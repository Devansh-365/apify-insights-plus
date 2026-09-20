/*
 * MAIN-world script (runs in the page's own JS realm, before the console SPA
 * boots). The Insights page authenticates its own XHR/fetch calls to
 * console-backend.apify.com with a bearer token attached by the page's own
 * API client — there's no auth cookie on that host (a direct navigation to
 * the endpoint 401s with "token-not-provided"). The bearer token stays in
 * this page world. The isolated extension code asks this script to perform
 * approved analytics requests and receives only their response data; the
 * credential never crosses the page-visible DOM bridge.
 */
(function () {
  const SEEN_EVENT = "aap-request-seen";
  const SEEN_REPLAY_EVENT = "aap-request-info";
  const AUTH_SCOPE_EVENT = "aap-auth-scope";
  const AUTH_SCOPE_REPLAY_EVENT = "aap-request-auth-scope";
  const API_REQUEST_EVENT = "aap-api-request";
  const API_RESPONSE_EVENT = "aap-api-response";
  const BACKEND_ORIGIN = "https://console-backend.apify.com";
  const MAX_REQUEST_ID_LENGTH = 128;
  const MAX_QUERY_LENGTH = 4096;
  let lastInfo = null;
  let lastToken = null;
  let lastAuthScope = null;
  const waitingRequests = [];
  const waitingRequestIds = new Set();
  const activeRequestIds = new Set();

  function hash(value) {
    let result = 2166136261;
    for (let index = 0; index < value.length; index++) {
      result ^= value.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(16).padStart(8, "0");
  }

  function parseInfo(url) {
    try {
      const u = new URL(url, location.origin);
      if (u.origin !== BACKEND_ORIGIN) return null;
      if (!u.pathname.includes("/actor-analytics/")) return null;
      // The console sends the native Actor filter as one comma-joined
      // `actorIds` param (it used to be repeated `actorIds[]=` params —
      // still read as a fallback for older console builds).
      const joined = u.searchParams.get("actorIds") || "";
      const actorIds = joined ? joined.split(",").filter(Boolean) : u.searchParams.getAll("actorIds[]");
      return {
        path: u.pathname.replace(/^\/actor-analytics\//, ""),
        month: u.searchParams.get("month"),
        actorIds,
      };
    } catch {
      return null;
    }
  }

  function dispatchSeen(info) {
    window.dispatchEvent(new CustomEvent(SEEN_EVENT, { detail: info }));
  }

  function announceSeen(info) {
    if (!info) return;
    lastInfo = info;
    dispatchSeen(info);
  }

  function dispatchAuthScope() {
    if (!lastAuthScope) return;
    window.dispatchEvent(new CustomEvent(AUTH_SCOPE_EVENT, { detail: lastAuthScope }));
  }

  function announceToken(value) {
    if (typeof value !== "string" || !value || value === lastToken) return;
    lastToken = value;
    lastAuthScope = `account-${hash(value)}`;
    dispatchAuthScope();
    while (waitingRequests.length) {
      const request = waitingRequests.shift();
      waitingRequestIds.delete(request.id);
      performRequest(request);
    }
  }

  function dispatchResponse(id, response) {
    window.dispatchEvent(new CustomEvent(API_RESPONSE_EVENT, { detail: { id, ...response } }));
  }

  const ACTOR_ANALYTICS_ENDPOINTS = new Set([
    "monthly-marketing",
    "actor-breakdown",
    "profit-margin",
    "run-statistics/monthly/all-users",
    "shared-runs",
    "user-count-statistics",
    "costs-per-thousand-results",
  ]);

  function allowedApiUrl(value) {
    try {
      const url = new URL(value);
      if (url.origin !== BACKEND_ORIGIN || url.hash || url.search.length > MAX_QUERY_LENGTH) return null;
      const actorAnalyticsPath = url.pathname.replace(/^\/actor-analytics\//, "");
      if (url.pathname.startsWith("/actor-analytics/")) {
        if (!ACTOR_ANALYTICS_ENDPOINTS.has(actorAnalyticsPath)) return null;
      } else if (
        url.pathname !== "/actors/find-users-owned-actors-by-text"
        && !/^\/actor-quality\/(?:scores|praises-and-improvements|business-value-improvements)\/[^/]+$/.test(url.pathname)
        && !/^\/actor\/[^/]+\/metrics$/.test(url.pathname)
      ) {
        return null;
      }

      const queryKeys = new Set(url.searchParams.keys());
      const allowedQueryKeys = url.pathname === "/actors/find-users-owned-actors-by-text"
        ? new Set(["text"])
        : url.pathname === "/actor-analytics/monthly-marketing"
          ? new Set(["monthStartAt", "actorIds", "portionOfMonthElapsed"])
          : url.pathname === "/actor-analytics/shared-runs"
            ? new Set(["actorIds", "tiers", "limit", "searchAfter", "searchBefore", "sort[finishedAt]"])
            : url.pathname.startsWith("/actor-analytics/")
              ? new Set(["month", "actorIds"])
              : new Set();
      if ([...queryKeys].some((key) => !allowedQueryKeys.has(key))) return null;
      if ([...url.searchParams.values()].some((value) => value.length > 2048)) return null;
      for (const key of ["month", "monthStartAt"]) {
        const value = url.searchParams.get(key);
        if (value && !/^\d{4}-\d{2}(?:-\d{2})?(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value)) return null;
      }
      return url;
    } catch {
      return null;
    }
  }

  async function performRequest(request) {
    const url = allowedApiUrl(request?.url);
    if (typeof request?.id !== "string" || request.id.length === 0 || request.id.length > MAX_REQUEST_ID_LENGTH || !url) {
      if (request?.id) dispatchResponse(request.id, { error: "Unsupported analytics request" });
      return;
    }
    if (activeRequestIds.has(request.id)) {
      return;
    }
    if (!lastToken) {
      if (waitingRequestIds.has(request.id)) return;
      waitingRequestIds.add(request.id);
      waitingRequests.push(request);
      return;
    }
    activeRequestIds.add(request.id);
    try {
      const response = await OrigFetch.call(window, url.href, {
        credentials: "include",
        headers: {
          Authorization: lastToken,
          Accept: "application/json",
          "x-idempotency-key": crypto.randomUUID(),
        },
      });
      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (!response.ok) {
        dispatchResponse(request.id, { error: `${url.pathname} -> HTTP ${response.status}` });
        return;
      }
      dispatchResponse(request.id, { data });
    } catch (error) {
      dispatchResponse(request.id, { error: error?.message || String(error) });
    } finally {
      activeRequestIds.delete(request.id);
    }
  }

  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__aptUrl = typeof url === "string" ? url : String(url);
    announceSeen(parseInfo(this.__aptUrl));
    return OrigOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name && name.toLowerCase() === "authorization" && allowedApiUrl(this.__aptUrl)) {
      announceToken(value);
    }
    return OrigSetHeader.apply(this, arguments);
  };

  const OrigFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input && input.url;
      announceSeen(parseInfo(url));
      const headers = init?.headers || (typeof input === "string" ? null : input?.headers);
      if (url && headers && allowedApiUrl(url)) {
        const auth = new Headers(headers).get("authorization");
        if (auth) announceToken(auth);
      }
    } catch {
      /* never let sniffing break a real request */
    }
    return OrigFetch.apply(this, arguments);
  };

  window.addEventListener(API_REQUEST_EVENT, (event) => {
    const request = event.detail;
    if (!request || typeof request.id !== "string") return;
    performRequest(request);
  });

  // Isolated content scripts are injected after the Console starts. Replay
  // the latest request metadata so the first request cannot be lost before
  // their listeners are installed.
  window.addEventListener(SEEN_REPLAY_EVENT, () => {
    if (lastInfo) dispatchSeen(lastInfo);
  });
  window.addEventListener(AUTH_SCOPE_REPLAY_EVENT, dispatchAuthScope);
})();
