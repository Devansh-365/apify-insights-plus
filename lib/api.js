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
  const MAX_ACTIVE_REQUESTS = 8;
  const REQUEST_INTERVAL_MS = 20;
  const MAX_REQUEST_RETRIES = 2;
  const RETRY_BASE_DELAY_MS = 300;
  const RETRYABLE_STATUS_RE = /HTTP (429|5\d\d)$/;

  let authScopeValue = null;
  let nextRequestAt = 0;
  let schedulerTimer = null;
  let schedulerSequence = 0;
  let activeRequests = 0;
  const schedulerQueue = [];
  const waiters = [];
  const tokenListeners = new Set();
  const pendingRequests = new Map();
  const inFlightRequests = new Map();
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

  function organizationScope() {
    return self.AAP_CONTEXT?.organizationKey?.() || "personal";
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

  function priorityRank(priority) {
    return priority === "background" ? 1 : 0;
  }

  // All features share one small priority queue. The queue is deliberately
  // global: otherwise Monetization, Quality, Acquisition, and Debugging could
  // each open their own pool and defeat the pacing protection.
  function scheduleRequest(task, priority = "foreground") {
    return new Promise((resolve, reject) => {
      schedulerQueue.push({
        task,
        priority: priorityRank(priority),
        sequence: schedulerSequence++,
        resolve,
        reject,
      });
      pumpScheduler();
    });
  }

  function pumpScheduler() {
    if (activeRequests >= MAX_ACTIVE_REQUESTS || !schedulerQueue.length) return;
    const delay = Math.max(0, nextRequestAt - Date.now());
    if (delay) {
      if (schedulerTimer == null) {
        schedulerTimer = setTimeout(() => {
          schedulerTimer = null;
          pumpScheduler();
        }, delay);
      }
      return;
    }

    schedulerQueue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
    const entry = schedulerQueue.shift();
    activeRequests++;
    nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        activeRequests--;
        pumpScheduler();
      });
    pumpScheduler();
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
    // The monthly catalog changes much less often than live day totals and is
    // also the source for lazy tooltip rows. Keep it reusable across reloads.
    if (path === "actor-breakdown") return 15 * 60 * 1000;
    if (path === "shared-runs" || currentMonthInUrl(url)) return 5 * 60 * 1000;
    return 15 * 60 * 1000;
  }

  // Apify's own guidance for a 429/5xx is to wait and retry with doubling
  // backoff. A timeout is treated the same way; other errors (e.g. a 404 for
  // a deleted Actor) are not retried since trying again cannot succeed.
  function isRetryableError(error) {
    const message = error?.message || "";
    return message === "Analytics request timed out" || RETRYABLE_STATUS_RE.test(message);
  }

  async function requestWithRetry(url, options = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await scheduleRequest(() => pageRequest(url), options.priority);
      } catch (error) {
        if (attempt >= MAX_REQUEST_RETRIES || !isRetryableError(error)) throw error;
        await wait(RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    }
  }

  async function request(base, path, params, options = {}) {
    await ready();
    const url = buildUrl(base, path, params);
    const cacheScope = `${authScopeValue || ""}:${organizationScope()}`;
    const key = `${cacheScope}\n${url}`;
    const existing = inFlightRequests.get(key);
    if (existing) return existing;

    const operation = (async () => {
      const cached = await AAP_CACHE.getApi(url, cacheTtl(path, url), cacheScope);
      if (cached.hit) return cached.data;
      const data = await requestWithRetry(url, options);
      await AAP_CACHE.setApi(url, data, cacheScope);
      return data;
    })();
    inFlightRequests.set(key, operation);
    try {
      return await operation;
    } finally {
      if (inFlightRequests.get(key) === operation) inFlightRequests.delete(key);
    }
  }

  function req(path, params, options) {
    return request(BASE, path, params, options);
  }

  function backendReq(path, params, options) {
    return request(BACKEND_BASE, path, params, options);
  }

  // Runs `items.map(fn)` with at most MAX_CONCURRENT in flight, reporting
  // progress via onProgress(done, total). A single item failure remains a
  // null result so callers can keep rendering successful items, but failures
  // are also exposed for an honest partial-data state and retry.
  async function pooled(items, fn, onProgress, options = {}) {
    if (onProgress && typeof onProgress !== "function") {
      options = onProgress;
      onProgress = options?.onProgress;
    }
    const priority = options?.priority || "foreground";
    const results = new Array(items.length);
    const failures = [];
    let next = 0;
    let done = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        try {
          results[i] = await fn(items[i], i, { priority });
        } catch (error) {
          results[i] = null;
          failures.push({ index: i, item: items[i], error });
        }
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    }
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT, items.length) }, worker);
    await Promise.all(workers);
    results.failures = failures;
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

  function actorEntries(raw, activeMonth) {
    const rows = Array.isArray(raw) ? raw : raw?.monetizationPerActor || [];
    const actors = new Map();
    for (const item of rows) {
      const actorId = item.actor?._id;
      if (!actorId) continue;
      const revenue = Number(item.earningsStats?.totalRevenueUsd) || 0;
      const cost = Number(item.earningsStats?.totalCostUsd) || 0;
      const current = actors.get(actorId) || {
        actorId,
        name: item.actor?.title || item.actor?.name || actorId,
        totalRevenueUsd: 0,
        totalCostUsd: 0,
        activeMonths: activeMonth ? [activeMonth] : [],
      };
      current.name = item.actor?.title || item.actor?.name || current.name;
      // A few backend versions have returned duplicate catalog entries. Keep
      // the largest monthly value so a duplicate cannot inflate the catalog,
      // while still recovering when the first duplicate is empty.
      current.totalRevenueUsd = Math.max(current.totalRevenueUsd, revenue);
      current.totalCostUsd = Math.max(current.totalCostUsd, cost);
      actors.set(actorId, current);
    }
    return [...actors.values()];
  }

  self.AAP_API = {
    hasToken: () => !!authScopeValue,
    whenReady: ready,
    onTokenChange,
    authScope,
    actorList: (options = {}) => backendReq("actors/find-users-owned-actors-by-text", { text: "" }, options),
    actorQualityScores: (actorId, options = {}) => backendReq(`actor-quality/scores/${encodeURIComponent(actorId)}`, {}, options),
    actorQualityRecommendations: (actorId, options = {}) => backendReq(`actor-quality/praises-and-improvements/${encodeURIComponent(actorId)}`, {}, options),
    actorQualityBusinessValue: (actorId, options = {}) => backendReq(`actor-quality/business-value-improvements/${encodeURIComponent(actorId)}`, {}, options),
    actorMetrics: (actorId, options = {}) => backendReq(`actor/${encodeURIComponent(actorId)}/metrics`, {}, options),
    acquisitionData: (monthStartAt, actorIds, options = {}) =>
      req("monthly-marketing", {
        monthStartAt,
        actorIds: actorIds?.length ? joinIds(actorIds) : "",
        portionOfMonthElapsed: options.portionOfMonthElapsed,
      }, options),
    actorBreakdown: (month, actorIds, options = {}) => req("actor-breakdown", { month, actorIds: joinIds(actorIds) }, options),
    profitMargin: (month, actorIds, options = {}) => req("profit-margin", { month, actorIds: joinIds(actorIds) }, options),
    runStatistics: (month, actorIds, options = {}) =>
      req("run-statistics/monthly/all-users", { month, actorIds: joinIds(actorIds) }, options),
    sharedRuns: (actorIds, options = {}) =>
      req("shared-runs", {
        actorIds: actorIds?.length ? joinIds(actorIds) : null,
        tiers: options.tiers?.length ? joinIds(options.tiers) : null,
        limit: options.limit,
        searchAfter: options.searchAfter,
        searchBefore: options.searchBefore,
        sort: options.sort,
      }, options),
    userCountStatistics: (month, actorIds, options = {}) =>
      req("user-count-statistics", { month, actorIds: joinIds(actorIds) }, options),
    costsPerThousandResults: (month, actorIds, options = {}) =>
      req("costs-per-thousand-results", { month, actorIds: joinIds(actorIds) }, options),
    actorDailyData: async (month, actorId, options = {}) => {
      const normalizedMonth = rangeDate(month, false);
      const [margin, runs] = await Promise.all([
        self.AAP_API.profitMargin(normalizedMonth, [actorId], options),
        self.AAP_API.runStatistics(normalizedMonth, [actorId], options),
      ]);
      return { month: normalizedMonth, actorId, margin, runs };
    },
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
              req("profit-margin", { month, actorIds: joinIds(actorIds) }, { priority: "foreground" }),
              req("run-statistics/monthly/all-users", { month, actorIds: joinIds(actorIds) }, { priority: "foreground" }),
              req("user-count-statistics", { month, actorIds: joinIds(actorIds) }, { priority: "foreground" }),
              req("costs-per-thousand-results", { month, actorIds: joinIds(actorIds) }, { priority: "foreground" }),
              req("actor-breakdown", { month, actorIds: joinIds(actorIds) }, { priority: "foreground" }),
            ]);
            monthly[index] = { month, margin, runs, users, costs, actorBreakdown };
          } catch (error) {
            firstError = error;
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(3, months.length) }, worker));
      if (firstError) throw firstError;

      const aggregated = AAPR.aggregate(monthly, startDate, endDate);
      const ranked = new Map();
      const actorCatalogByMonth = {};
      for (const item of monthly) {
        const entries = actorEntries(item.actorBreakdown, item.month);
        actorCatalogByMonth[item.month] = entries;
        for (const actor of entries) {
          const current = ranked.get(actor.actorId) || {
            actorId: actor.actorId,
            name: actor.name || actor.actorId,
            totalRevenueUsd: 0,
            totalCostUsd: 0,
            activeMonths: [],
          };
          current.name = actor.name || current.name;
          current.totalRevenueUsd += Number(actor.totalRevenueUsd) || 0;
          current.totalCostUsd += Number(actor.totalCostUsd) || 0;
          if (!current.activeMonths.includes(item.month)) current.activeMonths.push(item.month);
          ranked.set(actor.actorId, current);
        }
      }
      aggregated.actorCatalogByMonth = actorCatalogByMonth;
      aggregated.actorCatalog = [...ranked.values()].sort((left, right) =>
        Number(right.totalRevenueUsd > 0) - Number(left.totalRevenueUsd > 0)
        || right.totalRevenueUsd - left.totalRevenueUsd
        || String(left.name).localeCompare(String(right.name)),
      );
      return aggregated;
    },
    pooled,
  };
})();
