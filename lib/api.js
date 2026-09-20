/*
 * Thin client for the same backend endpoints the Insights page itself calls.
 * The page-world token-sniffer performs the requests with the page's bearer
 * token and returns only response data to this isolated content-script world.
 * The credential never crosses the page-visible bridge.
 */
(function () {
  const BASE = "https://console-backend.apify.com/actor-analytics";
  const BACKEND_BASE = "https://console-backend.apify.com";
  const MAX_CONCURRENT = 10;
  const REQUEST_INTERVAL_MS = 20;
  const MAX_REQUEST_RETRIES = 2;
  const RETRY_BASE_DELAY_MS = 300;
  const RETRYABLE_STATUS_RE = /HTTP (429|5\d\d)$/;

  let authScopeValue = null;
  let nextRequestAt = 0;
  let requestQueue = Promise.resolve();
  const waiters = [];
  const tokenListeners = new Set();
  const pendingRequests = new Map();
  const PROXY_REQUEST_EVENT = "aap-api-request";
  const PROXY_RESPONSE_EVENT = "aap-api-response";
  const AUTH_SCOPE_EVENT = "aap-auth-scope";
  const AUTH_SCOPE_REPLAY_EVENT = "aap-request-auth-scope";
  const PROXY_TIMEOUT_MS = 30_000;

  function setAuthScope(scope) {
    if (typeof scope !== "string" || !scope || scope === authScopeValue) return;
    authScopeValue = scope;
    waiters.splice(0).forEach((resolve) => resolve());
    for (const listener of tokenListeners) {
      try {
        listener();
      } catch {
        // Authentication changes must not break the request client.
      }
    }
  }

  function ready() {
    return authScopeValue ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve));
  }

  function onTokenChange(listener) {
    if (typeof listener === "function") tokenListeners.add(listener);
    return () => tokenListeners.delete(listener);
  }

  function authScope() {
    return authScopeValue;
  }

  function pageRequest(url) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error("Analytics request timed out"));
      }, PROXY_TIMEOUT_MS);
      pendingRequests.set(id, { resolve, reject, timeout });
      window.dispatchEvent(new CustomEvent(PROXY_REQUEST_EVENT, { detail: { id, url } }));
    });
  }

  window.addEventListener(AUTH_SCOPE_EVENT, (event) => setAuthScope(event.detail));
  window.addEventListener(PROXY_RESPONSE_EVENT, (event) => {
    const { id, data, error } = event.detail || {};
    const pending = pendingRequests.get(id);
    if (!pending) return;
    pendingRequests.delete(id);
    clearTimeout(pending.timeout);
    if (error) pending.reject(new Error(error));
    else pending.resolve(data);
  });
  window.dispatchEvent(new Event(AUTH_SCOPE_REPLAY_EVENT));

  // API requests are made only after the page has exposed a non-secret hash of
  // its auth token. This also gives cache keys an account namespace without
  // storing the credential itself.
  function buildUrl(base, path, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
      else if (v && typeof v === "object") {
        for (const [nestedKey, nestedValue] of Object.entries(v)) {
          if (nestedValue != null) qs.set(`${k}[${nestedKey}]`, nestedValue);
        }
      }
      else qs.set(k, v);
    }
    return `${base}/${path}?${qs.toString()}`;
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  // Requests can be issued by several page features at once. Keep their
  // existing bounded concurrency, but pace request starts globally so loading
  // an account-wide table does not create a burst against the backend.
  function waitForRequestSlot() {
    const slot = requestQueue.then(async () => {
      const delay = Math.max(0, nextRequestAt - Date.now());
      if (delay) await wait(delay);
      nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
    });
    requestQueue = slot.catch(() => {});
    return slot;
  }

  function currentMonthInUrl(url) {
    const currentMonth = todayDate().slice(0, 7);
    try {
      return [...new URL(url).searchParams.values()].some((value) =>
        new RegExp(`(^|[^\\d])${currentMonth}(?:-\\d{2})?(?:[^\\d]|$)`).test(value),
      );
    } catch {
      return url.includes(currentMonth);
    }
  }

  function cacheTtl(path, url) {
    if (path === "actors/find-users-owned-actors-by-text") return 10 * 60 * 1000;
    if (path === "shared-runs" || currentMonthInUrl(url)) return 60 * 1000;
    return 15 * 60 * 1000;
  }

  // Apify's own guidance for a 429/5xx is to wait and retry with doubling
  // backoff. A timeout is treated the same way; other errors (e.g. a 404 for
  // a deleted Actor) are not retried since trying again cannot succeed.
  function isRetryableError(error) {
    const message = error?.message || "";
    return message === "Analytics request timed out" || RETRYABLE_STATUS_RE.test(message);
  }

  async function requestWithRetry(url) {
    for (let attempt = 0; ; attempt++) {
      await waitForRequestSlot();
      try {
        return await pageRequest(url);
      } catch (error) {
        if (attempt >= MAX_REQUEST_RETRIES || !isRetryableError(error)) throw error;
        await wait(RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    }
  }

  async function request(base, path, params) {
    await ready();
    const url = buildUrl(base, path, params);
    const cacheScope = authScopeValue || "";
    const cached = await AAP_CACHE.getApi(url, cacheTtl(path, url), cacheScope);
    if (cached.hit) return cached.data;
    const data = await requestWithRetry(url);
    await AAP_CACHE.setApi(url, data, cacheScope);
    return data;
  }

  function req(path, params) {
    return request(BASE, path, params);
  }

  function backendReq(path, params) {
    return request(BACKEND_BASE, path, params);
  }

  // Runs `items.map(fn)` with at most MAX_CONCURRENT in flight, reporting
  // progress via onProgress(done, total). Never throws for a single item
  // failure — that item's result is `null` so one bad actor doesn't sink the
  // whole indexing pass.
  async function pooled(items, fn, onProgress) {
    const results = new Array(items.length);
    let next = 0;
    let done = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        try {
          results[i] = await fn(items[i], i);
        } catch {
          results[i] = null;
        }
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    }
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT, items.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  // The backend expects a single comma-joined `actorIds` param; both the old
  // `actorIds[]=` form and repeated `actorIds=` params are rejected with 400.
  function joinIds(actorIds) {
    return actorIds && actorIds.length ? actorIds.join(",") : null;
  }

  function rangeDate(value, end) {
    if (AAPR.isMonth(value)) return end ? AAPR.monthEnd(value) : AAPR.monthStart(value);
    return value;
  }

  function todayDate() {
    return new Date().toISOString().slice(0, 10);
  }

  function actorEntries(raw) {
    const rows = Array.isArray(raw) ? raw : raw?.monetizationPerActor || [];
    return rows
      .map((item) => ({
        actorId: item.actor?._id,
        name: item.actor?.title || item.actor?.name || item.actor?._id,
        totalRevenueUsd: item.earningsStats?.totalRevenueUsd ?? 0,
        totalCostUsd: item.earningsStats?.totalCostUsd ?? 0,
      }))
      .filter((actor) => actor.actorId);
  }

  self.AAP_API = {
    hasToken: () => !!authScopeValue,
    whenReady: ready,
    onTokenChange,
    authScope,
    actorList: () => backendReq("actors/find-users-owned-actors-by-text", { text: "" }),
    actorQualityScores: (actorId) => backendReq(`actor-quality/scores/${encodeURIComponent(actorId)}`),
    actorQualityRecommendations: (actorId) => backendReq(`actor-quality/praises-and-improvements/${encodeURIComponent(actorId)}`),
    actorQualityBusinessValue: (actorId) => backendReq(`actor-quality/business-value-improvements/${encodeURIComponent(actorId)}`),
    actorMetrics: (actorId) => backendReq(`actor/${encodeURIComponent(actorId)}/metrics`),
    acquisitionData: (monthStartAt, actorIds, options = {}) =>
      req("monthly-marketing", {
        monthStartAt,
        actorIds: actorIds?.length ? joinIds(actorIds) : "",
        portionOfMonthElapsed: options.portionOfMonthElapsed,
      }),
    actorBreakdown: (month, actorIds) => req("actor-breakdown", { month, actorIds: joinIds(actorIds) }),
    profitMargin: (month, actorIds) => req("profit-margin", { month, actorIds: joinIds(actorIds) }),
    runStatistics: (month, actorIds) =>
      req("run-statistics/monthly/all-users", { month, actorIds: joinIds(actorIds) }),
    sharedRuns: (actorIds, options = {}) =>
      req("shared-runs", {
        actorIds: actorIds?.length ? joinIds(actorIds) : null,
        tiers: options.tiers?.length ? joinIds(options.tiers) : null,
        limit: options.limit,
        searchAfter: options.searchAfter,
        searchBefore: options.searchBefore,
        sort: options.sort,
      }),
    userCountStatistics: (month, actorIds) =>
      req("user-count-statistics", { month, actorIds: joinIds(actorIds) }),
    costsPerThousandResults: (month, actorIds) =>
      req("costs-per-thousand-results", { month, actorIds: joinIds(actorIds) }),
    rangeData: async (start, end, actorIds) => {
      const startDate = rangeDate(start, false);
      const requestedEndDate = rangeDate(end, true);
      const endDate = requestedEndDate > todayDate() ? todayDate() : requestedEndDate;
      const months = AAPR.monthKeysBetween(startDate, endDate);
      if (!months.length) throw new Error("Invalid date range");

      // Keep a range request from opening an unbounded number of connections
      // when a user selects a long historical period. Each month's response
      // is independent, so three workers are enough to keep it quick without
      // competing with the Console's own requests.
      const monthly = new Array(months.length);
      let next = 0;
      let firstError = null;
      async function worker() {
        while (next < months.length && !firstError) {
          const index = next++;
          const month = months[index];
          try {
            const [margin, runs, users, costs, actorBreakdown] = await Promise.all([
              req("profit-margin", { month, actorIds: joinIds(actorIds) }),
              req("run-statistics/monthly/all-users", { month, actorIds: joinIds(actorIds) }),
              req("user-count-statistics", { month, actorIds: joinIds(actorIds) }),
              req("costs-per-thousand-results", { month, actorIds: joinIds(actorIds) }),
              req("actor-breakdown", { month, actorIds: joinIds(actorIds) }),
            ]);
            monthly[index] = { month, margin, runs, users, costs, actorBreakdown };
          } catch (error) {
            firstError = error;
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(3, months.length) }, worker));
      if (firstError) throw firstError;

      // actor-breakdown returns month totals and names, while the daily chart
      // needs per-Actor daily profit-margin and run-statistics responses.
      // Fetch every Actor returned by the breakdown so the day tooltip can
      // show both earning Actors and Actors that only ran.
      const ranked = new Map();
      for (const item of monthly) {
        for (const actor of actorEntries(item.actorBreakdown)) {
          const current = ranked.get(actor.actorId) || { ...actor, totalRevenueUsd: 0, totalCostUsd: 0 };
          current.name = actor.name || current.name;
          current.totalRevenueUsd += Number(actor.totalRevenueUsd) || 0;
          current.totalCostUsd += Number(actor.totalCostUsd) || 0;
          ranked.set(actor.actorId, current);
        }
      }
      const actors = [...ranked.values()]
        .sort((a, b) => b.totalRevenueUsd - a.totalRevenueUsd || b.totalCostUsd - a.totalCostUsd);
      const tasks = [];
      for (let index = 0; index < monthly.length; index++) {
        for (const actor of actors) tasks.push({ index, month: monthly[index].month, actor });
      }
      const actorMargins = await pooled(tasks, async (task) => {
        const [margin, runs] = await Promise.all([
          req("profit-margin", { month: task.month, actorIds: [task.actor.actorId] }),
          req("run-statistics/monthly/all-users", { month: task.month, actorIds: [task.actor.actorId] }),
        ]);
        return {
          index: task.index,
          actorId: task.actor.actorId,
          name: task.actor.name,
          margin,
          runs,
        };
      });
      for (const entry of actorMargins) {
        if (!entry) continue;
        (monthly[entry.index].actorMargins ||= []).push(entry);
      }

      return AAPR.aggregate(monthly, startDate, endDate);
    },
    pooled,
  };
})();
