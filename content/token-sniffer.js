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
  const CONSOLE_REQUEST_EVENT = "aap-console-request";
  const TEE_EVENT = "aap-api-tee";
  const TEE_REPLAY_EVENT = "aap-request-tee-replay";
  const MAX_TEE_BUFFER = 10;
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

  // The token is recognized from any Console backend request (the earliest
  // ones are not analytics calls), but requests the extension may make are
  // still limited to allowedApiUrl().
  function isBackendUrl(value) {
    try {
      return new URL(value, location.origin).origin === BACKEND_ORIGIN;
    } catch {
      return false;
    }
  }

  // Only the Console's own GET requests to the allowlisted analytics
  // endpoints are teed into the extension cache.
  function teeableUrl(value) {
    try {
      const absolute = new URL(value, location.origin).href;
      const url = allowedApiUrl(absolute);
      return url && url.pathname.startsWith("/actor-analytics/") ? url.href : null;
    } catch {
      return null;
    }
  }

  const recentConsoleRequests = new Map();
  const teeBuffer = new Map();

  function dispatchConsoleRequest(url) {
    recentConsoleRequests.set(url, Date.now());
    if (recentConsoleRequests.size > MAX_TEE_BUFFER * 2) recentConsoleRequests.delete(recentConsoleRequests.keys().next().value);
    window.dispatchEvent(new CustomEvent(CONSOLE_REQUEST_EVENT, { detail: { url } }));
  }

  // Reuse is limited to response data the page itself just received; the
  // token is never part of the event.
  function dispatchTee(url, data, headers) {
    const detail = { url, data, headers };
    teeBuffer.delete(url);
    teeBuffer.set(url, detail);
    if (teeBuffer.size > MAX_TEE_BUFFER) teeBuffer.delete(teeBuffer.keys().next().value);
    window.dispatchEvent(new CustomEvent(TEE_EVENT, { detail }));
  }

  function responseHeaders(getHeader) {
    try {
      return {
        etag: !!getHeader("etag"),
        lastModified: !!getHeader("last-modified"),
        cacheControl: getHeader("cache-control") || null,
      };
    } catch {
      return null;
    }
  }

  function onXhrLoad() {
    try {
      if (!this.__aptTeeUrl || this.status < 200 || this.status >= 300) return;
      let data;
      if (this.responseType === "" || this.responseType === "text") data = JSON.parse(this.responseText);
      else if (this.responseType === "json") data = this.response;
      else return;
      dispatchTee(this.__aptTeeUrl, data, responseHeaders((name) => this.getResponseHeader(name)));
    } catch {
      /* never let teeing break the Console */
    }
  }

  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__aptUrl = typeof url === "string" ? url : String(url);
    announceSeen(parseInfo(this.__aptUrl));
    try {
      // Reset on every open(): a reused XHR must not tee its new response
      // under the previous request's URL.
      const teeUrl = String(method || "GET").toUpperCase() === "GET" ? teeableUrl(this.__aptUrl) : null;
      this.__aptTeeUrl = teeUrl;
      if (teeUrl) {
        dispatchConsoleRequest(teeUrl);
        if (!this.__aptTeeListener) {
          this.__aptTeeListener = true;
          this.addEventListener("load", onXhrLoad);
        }
      }
    } catch {
      /* never let teeing break the Console */
    }
    return OrigOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name && name.toLowerCase() === "authorization" && isBackendUrl(this.__aptUrl)) {
      announceToken(value);
    }
    return OrigSetHeader.apply(this, arguments);
  };

  const OrigFetch = window.fetch;
  window.fetch = function (input, init) {
    let teeUrl = null;
    try {
      const url = typeof input === "string" ? input : input && (input.url || input.href);
      announceSeen(parseInfo(url));
      const headers = init?.headers || (typeof input === "string" ? null : input?.headers);
      if (url && headers && isBackendUrl(url)) {
        const auth = new Headers(headers).get("authorization");
        if (auth) announceToken(auth);
      }
      const method = String(init?.method || (typeof input === "object" && input?.method) || "GET").toUpperCase();
      teeUrl = method === "GET" && url ? teeableUrl(url) : null;
      if (teeUrl) dispatchConsoleRequest(teeUrl);
    } catch {
      /* never let sniffing break a real request */
    }
    const result = OrigFetch.apply(this, arguments);
    if (teeUrl) {
      // This reaction is registered before the caller's, so the clone is made
      // before the Console reads the body.
      result.then((response) => {
        if (!response?.ok) return;
        const headers = responseHeaders((name) => response.headers.get(name));
        response.clone().json().then((data) => dispatchTee(teeUrl, data, headers)).catch(() => {});
      }).catch(() => {});
    }
    return result;
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
  window.addEventListener(TEE_REPLAY_EVENT, () => {
    for (const [url, startedAt] of recentConsoleRequests) {
      if (Date.now() - startedAt < 5_000 && !teeBuffer.has(url)) {
        window.dispatchEvent(new CustomEvent(CONSOLE_REQUEST_EVENT, { detail: { url } }));
      }
    }
    for (const detail of teeBuffer.values()) window.dispatchEvent(new CustomEvent(TEE_EVENT, { detail }));
  });
})();
