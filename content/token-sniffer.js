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
  let lastInfo = null;
  let lastToken = null;
  let lastAuthScope = null;
  const waitingRequests = [];

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
      if (!u.hostname.endsWith("console-backend.apify.com")) return null;
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
    while (waitingRequests.length) performRequest(waitingRequests.shift());
  }

  function dispatchResponse(id, response) {
    window.dispatchEvent(new CustomEvent(API_RESPONSE_EVENT, { detail: { id, ...response } }));
  }

  function allowedApiUrl(value) {
    try {
      const url = new URL(value);
      if (url.origin !== "https://console-backend.apify.com") return null;
      const allowed = url.pathname.startsWith("/actor-analytics/")
        || url.pathname === "/actors/find-users-owned-actors-by-text"
        || url.pathname.startsWith("/actor-quality/")
        || url.pathname.startsWith("/actor/");
      return allowed ? url : null;
    } catch {
      return null;
    }
  }

  async function performRequest(request) {
    const url = allowedApiUrl(request?.url);
    if (!request?.id || !url) {
      if (request?.id) dispatchResponse(request.id, { error: "Unsupported analytics request" });
      return;
    }
    if (!lastToken) {
      waitingRequests.push(request);
      return;
    }
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
    if (name && name.toLowerCase() === "authorization" && this.__aptUrl?.includes("console-backend.apify.com")) {
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
      if (url && headers && url.includes("console-backend.apify.com")) {
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
