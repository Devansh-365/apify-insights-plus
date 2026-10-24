/*
 * Thin client for the same backend endpoints the Insights page itself calls.
 * The page-world token-sniffer performs the requests with the page's bearer
 * token and returns only response data to this isolated content-script world.
 * The credential never crosses the page-visible bridge.
 */
(function () {
  const BASE = "https://console-backend.apify.com/actor-analytics";
  const BACKEND_BASE = "https://console-backend.apify.com";
  const PUBLIC_API_BASE = "https://api.apify.com/v2";
  const MAX_ACTIVE_REQUESTS = 8;
  const MAX_CONCURRENT = MAX_ACTIVE_REQUESTS;
  const REQUEST_INTERVAL_MS = 20;
  const MAX_REQUEST_RETRIES = 2;
  const RETRY_BASE_DELAY_MS = 300;
  const MAX_PUBLIC_REQUEST_RETRIES = 4;
  const PUBLIC_RETRY_BASE_DELAY_MS = 1_000;
  const PUBLIC_RETRY_MAX_DELAY_MS = 60_000;
  const RETRYABLE_STATUS_RE = /HTTP (429|5\d\d)$/;
  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;
  // When the Console itself is already fetching the same analytics response,
  // wait this long for its copy (teed into our cache) before fetching again.
  const CONSOLE_TEE_WAIT_MS = 1_500;
  const CONSOLE_REQUEST_FRESH_MS = 5_000;
  // A tab waiting on another tab's in-flight fetch gives up after this long
  // and fetches on its own.
  const CROSS_TAB_LOCK_WAIT_MS = 5_000;
  const CANCELLED_MESSAGE = "Request cancelled";

  const perf = self.AAP_PERF || null;
  // Resolved lazily: lib/cache.js loads after this file.
  function cache() {
    return typeof AAP_CACHE !== "undefined" ? AAP_CACHE : self.AAP_CACHE;
  }
  let authScopeValue = null;
  let nextRequestAt = 0;
  let schedulerTimer = null;
  let schedulerSequence = 0;
  let activeRequests = 0;
  let bypassCacheUntil = 0;
  const schedulerQueue = [];
  const cancelledTags = new Set();
  const waiters = [];
  const tokenListeners = new Set();
  const revalidationListeners = new Set();
  const pendingRequests = new Map();
  const inFlightRequests = new Map();
  const consoleRequests = new Map();
  const teeWaiters = new Map();
  // Console responses teed before the account is known wait here.
  const pendingTees = [];
  const PROXY_REQUEST_EVENT = "aap-api-request";
  const PROXY_RESPONSE_EVENT = "aap-api-response";
  const AUTH_SCOPE_EVENT = "aap-auth-scope";
  const AUTH_SCOPE_REPLAY_EVENT = "aap-request-auth-scope";
  const CONSOLE_REQUEST_EVENT = "aap-console-request";
  const TEE_EVENT = "aap-api-tee";
  const PROXY_TIMEOUT_MS = 30_000;

  function setAuthScope(scope) {
    if (typeof scope !== "string" || !scope || scope === authScopeValue) return;
    authScopeValue = scope;
    waiters.splice(0).forEach((resolve) => resolve());
    pendingTees.splice(0).forEach(cacheTee);
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

  // Called with { url, path } after a stale cached response was refreshed in
  // the background, so views can re-render with the fresh copy.
  function onRevalidated(listener) {
    if (typeof listener === "function") revalidationListeners.add(listener);
    return () => revalidationListeners.delete(listener);
  }

  function emitRevalidated(detail) {
    for (const listener of revalidationListeners) {
      try {
        listener(detail);
      } catch {
        // A view's refresh handler must not break the request client.
      }
    }
  }

  function authScope() {
    return authScopeValue;
  }

  function organizationScope() {
    return self.AAP_CONTEXT?.organizationKey?.() || "personal";
  }

  function currentCacheScope() {
    return `${authScopeValue || ""}:${organizationScope()}`;
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

  // Cache key for a request URL, so our requests and the Console's own map to
  // the same entry: empty parameters dropped, the rest sorted. Never send this
  // form: some endpoints require their empty parameters (e.g. `text=`).
  function canonicalUrl(value) {
    try {
      const url = new URL(value);
      const params = [...url.searchParams.entries()]
        .filter(([, paramValue]) => paramValue !== "")
        .sort(([left, leftValue], [right, rightValue]) => left.localeCompare(right) || leftValue.localeCompare(rightValue));
      const query = new URLSearchParams(params).toString();
      return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
    } catch {
      return value;
    }
  }

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

  function backendPath(url) {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== BACKEND_BASE) return null;
      return parsed.pathname.replace(/^\/actor-analytics\//, "").replace(/^\//, "");
    } catch {
      return null;
    }
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function priorityRank(priority) {
    return priority === "background" ? 1 : 0;
  }

  function cancelledError() {
    const error = new Error(CANCELLED_MESSAGE);
    error.name = "AbortError";
    return error;
  }

  function isCancelled(error) {
    return error?.name === "AbortError" || error?.message === CANCELLED_MESSAGE;
  }

  // All features share one small priority queue. The queue is deliberately
  // global: otherwise Monetization, Quality, Acquisition, and Debugging could
  // each open their own pool and defeat the pacing protection.
  function scheduleRequest(task, priority = "foreground", tag = null) {
    if (tag && cancelledTags.has(tag)) return Promise.reject(cancelledError());
    return new Promise((resolve, reject) => {
      schedulerQueue.push({
        task,
        tag,
        priority: priorityRank(priority),
        sequence: schedulerSequence++,
        queuedAt: perf?.now(),
        resolve,
        reject,
      });
      pumpScheduler();
    });
  }

  // Drops every queued (not yet started) request with this tag, so switching
  // ranges does not leave the old range's requests occupying the queue.
  function cancel(tag) {
    if (!tag) return 0;
    cancelledTags.add(tag);
    if (cancelledTags.size > 50) cancelledTags.delete(cancelledTags.values().next().value);
    let removed = 0;
    for (let index = schedulerQueue.length - 1; index >= 0; index--) {
      if (schedulerQueue[index].tag !== tag) continue;
      const [entry] = schedulerQueue.splice(index, 1);
      entry.reject(cancelledError());
      removed++;
    }
    perf?.count("request.cancelled", removed);
    return removed;
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
    if (perf && entry.queuedAt != null) perf.time("request.queueWaitMs", perf.now() - entry.queuedAt);
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        activeRequests--;
        pumpScheduler();
      });
    pumpScheduler();
  }

  function todayDate() {
    return new Date().toISOString().slice(0, 10);
  }

  function previousMonthKey(month) {
    const date = new Date(`${String(month).slice(0, 7)}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() - 1);
    return date.toISOString().slice(0, 10);
  }

  function monthsInUrl(url) {
    try {
      const params = new URL(url).searchParams;
      return ["month", "monthStartAt"]
        .map((name) => params.get(name))
        .filter((value) => /^\d{4}-\d{2}/.test(value || ""))
        .map((value) => value.slice(0, 7));
    } catch {
      return [];
    }
  }

  // Freshness (staleTime) and retention (gcTime) per resource. Past months
  // are final, so they stay fresh for days; the current month refreshes in
  // minutes. Stale entries are still shown while a background refresh runs.
  function cachePolicy(path, url) {
    if (path === "actors/find-users-owned-actors-by-text") return { staleTime: 10 * MINUTE_MS, gcTime: HOUR_MS };
    if (path === "shared-runs") return { staleTime: 5 * MINUTE_MS, gcTime: 15 * MINUTE_MS };
    if (path.startsWith("actor-quality/") || /^actor\/[^/]+\/(?:metrics|basic-info)$/.test(path)) {
      return { staleTime: 15 * MINUTE_MS, gcTime: HOUR_MS };
    }
    const months = monthsInUrl(url);
    if (months.length) {
      const currentMonth = todayDate().slice(0, 7);
      if (months.some((month) => month >= currentMonth)) {
        return path === "monthly-marketing"
          ? { staleTime: MINUTE_MS, gcTime: 15 * MINUTE_MS }
          : { staleTime: 5 * MINUTE_MS, gcTime: HOUR_MS };
      }
      // Late usage can still land for a month that just ended.
      const justEnded = months.includes(previousMonthKey(`${currentMonth}-01`).slice(0, 7))
        && Number(todayDate().slice(8, 10)) <= 3;
      return justEnded
        ? { staleTime: 6 * HOUR_MS, gcTime: 7 * DAY_MS }
        : { staleTime: 3 * DAY_MS, gcTime: 7 * DAY_MS };
    }
    return { staleTime: 15 * MINUTE_MS, gcTime: HOUR_MS };
  }

  // Apify's own guidance for a 429/5xx is to wait and retry with doubling
  // backoff. A timeout is treated the same way; other errors (e.g. a 404 for
  // a deleted Actor) are not retried since trying again cannot succeed.
  function isRetryableError(error) {
    const message = error?.message || "";
    return message === "Analytics request timed out" || RETRYABLE_STATUS_RE.test(message);
  }

  function retryAfterMilliseconds(response) {
    const value = response?.headers?.get?.("retry-after");
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(PUBLIC_RETRY_MAX_DELAY_MS, seconds * 1000);
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp)
      ? Math.min(PUBLIC_RETRY_MAX_DELAY_MS, Math.max(0, timestamp - Date.now()))
      : null;
  }

  function publicRetryDelay(response, attempt) {
    return retryAfterMilliseconds(response)
      ?? Math.min(PUBLIC_RETRY_MAX_DELAY_MS, PUBLIC_RETRY_BASE_DELAY_MS * 2 ** attempt);
  }

  function publicResponseIsRetryable(response) {
    return response?.status === 429 || Number(response?.status) >= 500;
  }

  async function requestWithRetry(url, options = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        const started = perf?.now();
        const data = await scheduleRequest(() => pageRequest(url), options.priority, options.tag);
        if (perf) {
          perf.count("request.network");
          perf.time("request.totalMs", perf.now() - started);
        }
        return data;
      } catch (error) {
        if (isCancelled(error) || attempt >= MAX_REQUEST_RETRIES || !isRetryableError(error)) throw error;
        perf?.count("request.retry");
        // Jittered doubling backoff, as Apify recommends.
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
        await wait(delay + Math.random() * delay);
      }
    }
  }

  // ---- Payload compaction --------------------------------------------------
  // actor-breakdown carries full pricing definitions for every Actor (about
  // 1.2KB each). Keep only the fields the extension reads so a year of
  // months fits in the cache budget.
  function compactPricing(pricing) {
    if (!pricing || typeof pricing !== "object") return null;
    const events = pricing.pricingPerEvent?.actorChargeEvents || {};
    const entries = Object.entries(events);
    const [eventKey, event] = entries.find(([, item]) => item?.isPrimaryEvent)
      || entries.find(([, item]) => item && !item.isOneTimeEvent)
      || [];
    const compact = { pricingModel: pricing.pricingModel || null };
    if (pricing.pricePerUnitUsd != null) compact.pricePerUnitUsd = pricing.pricePerUnitUsd;
    if (pricing.unitName) compact.unitName = pricing.unitName;
    if (event) {
      const tiers = event.eventTieredPricingUsd;
      const freePrice = tiers ? tiers.FREE?.tieredEventPriceUsd ?? Object.values(tiers)[0]?.tieredEventPriceUsd : null;
      compact.pricingPerEvent = {
        actorChargeEvents: {
          [eventKey]: {
            eventTitle: event.eventTitle,
            isPrimaryEvent: !!event.isPrimaryEvent,
            isOneTimeEvent: !!event.isOneTimeEvent,
            ...(tiers ? { eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: freePrice } } } : { eventPriceUsd: event.eventPriceUsd }),
          },
        },
      };
    }
    return compact;
  }

  function compactBreakdown(raw) {
    const list = Array.isArray(raw) ? raw : raw?.monetizationPerActor;
    if (!Array.isArray(list)) return raw;
    const items = list.map((item) => {
      const actor = item?.actor || {};
      return {
        actor: {
          _id: actor._id,
          title: actor.title,
          name: actor.name,
          username: actor.username,
          pictureUrl: actor.pictureUrl,
          isDeprecated: actor.isDeprecated,
        },
        runsStats: item?.runsStats,
        earningsStats: item?.earningsStats,
        usersStats: item?.usersStats,
        chargedResults: item?.chargedResults,
        currentPricingInfo: compactPricing(item?.currentPricingInfo),
      };
    });
    if (Array.isArray(raw)) return items;
    const compact = { monetizationPerActor: items };
    for (const [key, value] of Object.entries(raw)) {
      if (key !== "monetizationPerActor" && (value == null || typeof value !== "object")) compact[key] = value;
    }
    return compact;
  }

  function prepareForCache(path, data) {
    return path === "actor-breakdown" ? compactBreakdown(data) : data;
  }

  // ---- Console response reuse ----------------------------------------------
  // The page-world sniffer reports the Console's own analytics requests as
  // they start, and tees their responses here, so we can reuse them instead
  // of fetching the same data a second time.
  window.addEventListener(CONSOLE_REQUEST_EVENT, (event) => {
    const url = event.detail?.url;
    if (typeof url !== "string") return;
    const canonical = canonicalUrl(url);
    consoleRequests.delete(canonical);
    consoleRequests.set(canonical, Date.now());
    if (consoleRequests.size > 40) consoleRequests.delete(consoleRequests.keys().next().value);
  });

  window.addEventListener(TEE_EVENT, (event) => {
    const detail = event.detail || {};
    if (typeof detail.url !== "string" || detail.data == null) return;
    perf?.recordHeaders(detail.headers);
    if (!authScopeValue) {
      if (pendingTees.length < 10) pendingTees.push(detail);
      return;
    }
    cacheTee(detail);
  });

  function cacheTee({ url, data }) {
    const canonical = canonicalUrl(url);
    const path = backendPath(canonical);
    if (!path) return;
    const stored = prepareForCache(path, data);
    Promise.resolve(cache()?.setApi?.(canonical, stored, currentCacheScope(), cachePolicy(path, canonical))).catch(() => {});
    perf?.count("tee.cached");
    const resolvers = teeWaiters.get(canonical);
    if (resolvers) {
      teeWaiters.delete(canonical);
      resolvers.forEach((resolve) => resolve(stored));
    }
  }

  // Pick up anything the Console fetched before this script was injected.
  window.dispatchEvent(new Event("aap-request-tee-replay"));

  function waitForConsoleCopy(url) {
    const startedAt = consoleRequests.get(url);
    if (!startedAt || Date.now() - startedAt > CONSOLE_REQUEST_FRESH_MS) return Promise.resolve(null);
    return new Promise((resolve) => {
      const resolvers = teeWaiters.get(url) || [];
      resolvers.push(resolve);
      teeWaiters.set(url, resolvers);
      // The Console request may fail and never be teed: stop waiting and
      // drop this waiter so the map does not grow.
      setTimeout(() => {
        resolve(null);
        const pending = teeWaiters.get(url);
        if (!pending) return;
        const index = pending.indexOf(resolve);
        if (index >= 0) pending.splice(index, 1);
        if (!pending.length) teeWaiters.delete(url);
      }, CONSOLE_TEE_WAIT_MS);
    });
  }

  // ---- Request pipeline -----------------------------------------------------
  function storeResponse(url, data, cacheScope, policy) {
    return Promise.resolve(cache()?.setApi?.(url, data, cacheScope, policy)).catch(() => false);
  }

  // `target.requestUrl` is sent as built; `target.cacheUrl` is the cache key.
  async function fetchAndStore(target, path, cacheScope, policy, options) {
    const data = prepareForCache(path, await requestWithRetry(target.requestUrl, options));
    // Persist in the background; the caller gets the data now.
    const persisted = storeResponse(target.cacheUrl, data, cacheScope, policy);
    return { data, persisted };
  }

  function lockManager() {
    return typeof navigator !== "undefined" && navigator.locks?.request ? navigator.locks : null;
  }

  function lockName(cacheScope, url) {
    let result = 2166136261;
    const value = `${cacheScope}\n${url}`;
    for (let index = 0; index < value.length; index++) {
      result ^= value.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return `aap-fetch-${(result >>> 0).toString(16)}`;
  }

  // Cross-tab de-duplication: one tab fetches while others holding the same
  // request wait on a Web Lock, then read the copy it stored. A tab that waits
  // too long fetches on its own.
  function fetchShared(target, path, cacheScope, policy, options) {
    const locks = lockManager();
    if (!locks) return fetchAndStore(target, path, cacheScope, policy, options).then((result) => result.data);
    return new Promise((resolve, reject) => {
      let settled = false;
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = setTimeout(() => controller?.abort(), CROSS_TAB_LOCK_WAIT_MS);
      locks.request(lockName(cacheScope, target.cacheUrl), controller ? { signal: controller.signal } : {}, async () => {
        clearTimeout(timer);
        const again = await cache().getApi(target.cacheUrl, policy, cacheScope);
        if (again.hit && !again.stale) {
          perf?.count("request.sharedAcrossTabs");
          settled = true;
          resolve(again.data);
          return;
        }
        try {
          const result = await fetchAndStore(target, path, cacheScope, policy, options);
          settled = true;
          resolve(result.data);
          // Hold the lock until the copy is stored so waiting tabs find it.
          await result.persisted;
        } catch (error) {
          settled = true;
          reject(error);
        }
      }).catch(() => {
        clearTimeout(timer);
        if (settled) return;
        fetchAndStore(target, path, cacheScope, policy, options).then((result) => resolve(result.data), reject);
      });
    });
  }

  function revalidate(target, path, cacheScope, policy, key) {
    const revalidationKey = `revalidate\n${key}`;
    // Only a second revalidation is a duplicate; the request serving the
    // stale copy is itself the in-flight entry for `key`.
    if (inFlightRequests.has(revalidationKey)) return;
    const operation = fetchShared(target, path, cacheScope, policy, { priority: "background" })
      .then(() => {
        perf?.count("request.revalidated");
        emitRevalidated({ url: target.cacheUrl, path });
      })
      .catch(() => {})
      .finally(() => inFlightRequests.delete(revalidationKey));
    inFlightRequests.set(revalidationKey, operation);
  }

  async function request(base, path, params, options = {}) {
    await ready();
    const requestUrl = buildUrl(base, path, params);
    const target = { requestUrl, cacheUrl: canonicalUrl(requestUrl) };
    const cacheScope = currentCacheScope();
    const key = `${cacheScope}\n${target.cacheUrl}`;
    const existing = inFlightRequests.get(key);
    if (existing) return existing;

    const operation = (async () => {
      const policy = cachePolicy(path, target.cacheUrl);
      const bypass = options.fresh || (options.priority !== "background" && Date.now() < bypassCacheUntil);
      if (!bypass) {
        const cached = await cache().getApi(target.cacheUrl, policy, cacheScope);
        if (cached.hit) {
          if (cached.stale) revalidate(target, path, cacheScope, policy, key);
          return cached.data;
        }
        const consoleCopy = await waitForConsoleCopy(target.cacheUrl);
        if (consoleCopy != null) {
          perf?.count("request.reusedConsole");
          return consoleCopy;
        }
      }
      return fetchShared(target, path, cacheScope, policy, options);
    })();
    inFlightRequests.set(key, operation);
    try {
      return await operation;
    } finally {
      if (inFlightRequests.get(key) === operation) inFlightRequests.delete(key);
    }
  }

  async function publicRequest(url, options = {}) {
    const cacheScope = "public";
    const cacheMode = options.cacheMode === "no-store" ? "no-store" : "default";
    const key = `${cacheScope}\n${cacheMode}\n${url}`;
    const existing = inFlightRequests.get(key);
    if (existing) return existing;
    const policy = { staleTime: 15 * MINUTE_MS, gcTime: HOUR_MS };

    async function fetchPublic(priority) {
      for (let attempt = 0; ; attempt++) {
        let response;
        try {
          response = await scheduleRequest(
            () => fetch(url, { cache: cacheMode, headers: { Accept: "application/json" } }),
            priority,
            options.tag,
          );
        } catch (error) {
          if (isCancelled(error) || attempt >= MAX_PUBLIC_REQUEST_RETRIES) throw error;
          await wait(Math.min(PUBLIC_RETRY_MAX_DELAY_MS, PUBLIC_RETRY_BASE_DELAY_MS * 2 ** attempt));
          continue;
        }
        let data = null;
        try {
          data = await response.json();
        } catch {
          // The status below still produces a useful error for a non-JSON reply.
        }
        if (response.ok) {
          perf?.count("request.public");
          if (cacheMode !== "no-store") storeResponse(url, data, cacheScope, policy);
          return data;
        }
        if (!publicResponseIsRetryable(response) || attempt >= MAX_PUBLIC_REQUEST_RETRIES) {
          const message = data?.error?.message || data?.message || `HTTP ${response.status}`;
          const error = new Error(`Public Actor request failed: ${message}`);
          error.status = response.status;
          throw error;
        }
        await wait(publicRetryDelay(response, attempt));
      }
    }

    const operation = (async () => {
      if (cacheMode !== "no-store") {
        const cached = await cache().getApi(url, policy, cacheScope);
        if (cached.hit) {
          if (cached.stale && !inFlightRequests.has(`revalidate\n${key}`)) {
            const refresh = fetchPublic("background")
              .then(() => emitRevalidated({ url, path: "public" }))
              .catch(() => {})
              .finally(() => inFlightRequests.delete(`revalidate\n${key}`));
            inFlightRequests.set(`revalidate\n${key}`, refresh);
          }
          return cached.data;
        }
      }
      return fetchPublic(options.priority || "foreground");
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

  function publicStorePage(options = {}) {
    const username = options.username == null ? "" : String(options.username).trim();
    if (username && !/^[^/?#\s]+$/.test(username)) throw new Error("Invalid public profile username");
    const rawLimit = options.limit == null ? 1000 : Number(options.limit);
    const rawOffset = options.offset == null ? 0 : Number(options.offset);
    if (!Number.isFinite(rawLimit) || rawLimit < 1) throw new Error("Invalid public Store page limit");
    if (!Number.isFinite(rawOffset) || rawOffset < 0) throw new Error("Invalid public Store page offset");
    const limit = Math.min(1000, Math.floor(rawLimit));
    const offset = Math.floor(rawOffset);
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (username) params.set("username", username);
    if (["relevance", "popularity", "newest", "lastUpdate", "totalUsers"].includes(options.sortBy)) {
      params.set("sortBy", options.sortBy);
    }
    if (options.includeUnrunnableActors != null) {
      params.set("includeUnrunnableActors", options.includeUnrunnableActors ? "true" : "false");
    }
    return publicRequest(`${PUBLIC_API_BASE}/store?${params.toString()}`, options);
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

  // Builds the range result from whichever months are available.
  function assembleRange(monthly, startDate, endDate) {
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
    // Compact per-Actor stats for the portfolio table (users, runs, pricing).
    if (self.AAP_PORTFOLIO_MODEL) {
      aggregated.actorBreakdownRows = Object.fromEntries(
        monthly.map((item) => [item.month, self.AAP_PORTFOLIO_MODEL.normalizeRows(item.actorBreakdown)]),
      );
    }
    aggregated.actorCatalog = [...ranked.values()].sort((left, right) =>
      Number(right.totalRevenueUsd > 0) - Number(left.totalRevenueUsd > 0)
      || right.totalRevenueUsd - left.totalRevenueUsd
      || String(left.name).localeCompare(String(right.name)),
    );
    return aggregated;
  }

  self.AAP_API = {
    hasToken: () => !!authScopeValue,
    whenReady: ready,
    onTokenChange,
    onRevalidated,
    authScope,
    cancel,
    canonicalUrl,
    cachePolicy,
    compactBreakdown,
    // Refresh buttons call this so the next foreground requests skip the
    // cache instead of re-rendering the copy they just showed.
    forceFresh: (milliseconds = 4_000) => {
      bypassCacheUntil = Date.now() + milliseconds;
    },
    actorList: (options = {}) => backendReq("actors/find-users-owned-actors-by-text", { text: "" }, options),
    actorQualityScores: (actorId, options = {}) => backendReq(`actor-quality/scores/${encodeURIComponent(actorId)}`, {}, options),
    actorQualityRecommendations: (actorId, options = {}) => backendReq(`actor-quality/praises-and-improvements/${encodeURIComponent(actorId)}`, {}, options),
    actorQualityBusinessValue: (actorId, options = {}) => backendReq(`actor-quality/business-value-improvements/${encodeURIComponent(actorId)}`, {}, options),
    actorBasicInfo: (actorId, options = {}) => backendReq(`actor/${encodeURIComponent(actorId)}/basic-info`, {}, options),
    actorMetrics: (actorId, options = {}) => backendReq(`actor/${encodeURIComponent(actorId)}/metrics`, {}, options),
    publicActorDetails: (actorRef, options = {}) => {
      const normalizedRef = String(actorRef || "").trim().replace(/\//g, "~");
      if (!/^[^/?#\s~]+~[^/?#\s~]+$/.test(normalizedRef)) throw new Error("Invalid public Actor reference");
      return publicRequest(`${PUBLIC_API_BASE}/acts/${encodeURIComponent(normalizedRef)}`, options);
    },
    publicStorePage,
    publicActorStore: (username, options = {}) => publicStorePage({ ...options, username }),
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
    /**
     * Loads every month of a range, newest month first. `options.onProgress`
     * receives a partial result as soon as the most recent months arrive, so
     * charts can draw before older months finish. A month that fails no
     * longer fails the whole range: the result resolves with
     * `partial: { failedMonths, failedCount }`, and rejects only when every
     * month failed. `options.tag` lets the caller cancel queued requests.
     */
    rangeData: async (start, end, actorIds, options = {}) => {
      const startDate = rangeDate(start, false);
      const requestedEndDate = rangeDate(end, true);
      const endDate = requestedEndDate > todayDate() ? todayDate() : requestedEndDate;
      const months = AAPR.monthKeysBetween(startDate, endDate);
      if (!months.length) throw new Error("Invalid date range");
      const requestOptions = { priority: "foreground", tag: options.tag };
      const ids = joinIds(actorIds);

      // The portfolio compares the latest month with the one before; fetch
      // that month in the same batch when the range does not include it.
      const latestMonth = months[months.length - 1];
      const previousMonth = previousMonthKey(latestMonth);
      const previousTask = options.includePrevious && !months.includes(previousMonth) && !ids
        ? req("actor-breakdown", { month: previousMonth }, requestOptions).catch(() => null)
        : Promise.resolve(null);

      // Keep a range request from opening an unbounded number of connections
      // when a user selects a long historical period. Each month's response
      // is independent, so three workers are enough to keep it quick without
      // competing with the Console's own requests.
      const order = months.map((_, index) => index).reverse();
      const monthly = new Array(months.length);
      const failures = [];
      let cursor = 0;
      let cancelled = false;
      let reportedSuffix = months.length;

      function reportProgress() {
        if (typeof options.onProgress !== "function") return;
        let suffixStart = months.length;
        while (suffixStart > 0 && monthly[suffixStart - 1]) suffixStart--;
        if (suffixStart >= reportedSuffix || suffixStart === 0) return;
        reportedSuffix = suffixStart;
        try {
          const partialStart = months[suffixStart] > startDate ? months[suffixStart] : startDate;
          const progress = assembleRange(monthly.slice(suffixStart), partialStart, endDate);
          progress.progressive = true;
          options.onProgress(progress);
        } catch {
          // Progress rendering is best effort; the final result still follows.
        }
      }

      async function worker() {
        while (cursor < order.length && !cancelled) {
          if (options.tag && cancelledTags.has(options.tag)) {
            cancelled = true;
            break;
          }
          const index = order[cursor++];
          const month = months[index];
          try {
            const [margin, runs, users, costs, actorBreakdown] = await Promise.all([
              req("profit-margin", { month, actorIds: ids }, requestOptions),
              req("run-statistics/monthly/all-users", { month, actorIds: ids }, requestOptions),
              req("user-count-statistics", { month, actorIds: ids }, requestOptions),
              req("costs-per-thousand-results", { month, actorIds: ids }, requestOptions),
              req("actor-breakdown", { month, actorIds: ids }, requestOptions),
            ]);
            monthly[index] = { month, margin, runs, users, costs, actorBreakdown };
            reportProgress();
          } catch (error) {
            if (isCancelled(error)) cancelled = true;
            failures.push({ month, error });
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(3, months.length) }, worker));
      if (cancelled) throw cancelledError();
      const loaded = monthly.filter(Boolean);
      if (!loaded.length) throw failures[0]?.error || new Error("Range could not be loaded");

      const aggregated = assembleRange(loaded, startDate, endDate);
      const previousBreakdown = await previousTask;
      if (previousBreakdown && self.AAP_PORTFOLIO_MODEL) {
        aggregated.previousBreakdownRows = {
          month: previousMonth,
          rows: self.AAP_PORTFOLIO_MODEL.normalizeRows(previousBreakdown),
        };
      }
      if (failures.length) {
        aggregated.partial = {
          failedMonths: failures.map((failure) => failure.month),
          failedCount: failures.length,
        };
      }
      return aggregated;
    },
    pooled,
  };
})();
