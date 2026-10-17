/* Small persistent cache for analytics responses and monetization breakdowns. */
(function () {
  const BREAKDOWN_PREFIX = "aap.breakdown.";
  const API_PREFIX = "aap.api.v2.";
  const VIEW_PREFIX = "aap.view.";
  const VERSION_KEY = "aap.cacheVersion";
  const CACHE_CLEAR_KEY = "aap.cacheClearedAt";
  const CACHE_VERSION = "7";
  const BREAKDOWN_TTL_MS = 15 * 60 * 1000;
  const MAX_API_ENTRY_BYTES = 900 * 1024;
  const MAX_API_CACHE_BYTES = 5 * 1024 * 1024;
  // chrome.storage.local's total quota is 10MB without the unlimitedStorage
  // permission (which this extension does not request). The per-type budgets
  // below are enforced inside one shared 8MB ceiling so API responses,
  // breakdowns, and durable page snapshots cannot collectively overflow it.
  const MAX_VIEW_ENTRY_BYTES = 2 * 1024 * 1024;
  const MAX_BENCHMARK_ENTRY_BYTES = 3 * 1024 * 1024;
  const MAX_VIEW_CACHE_BYTES = 3 * 1024 * 1024;
  const MAX_BREAKDOWN_ENTRY_BYTES = 1.5 * 1024 * 1024;
  const MAX_BREAKDOWN_CACHE_BYTES = 1.5 * 1024 * 1024;
  // Leave headroom below Chrome's 10MB storage quota for record/key overhead
  // and any unrelated extension data. Every cache type shares this ceiling.
  const MAX_STORAGE_BYTES = 8 * 1024 * 1024;

  const memory = new Map();
  let cacheWriteQueue = Promise.resolve();
  let cacheGeneration = 0;

  function hash(value) {
    let result = 2166136261;
    for (let index = 0; index < value.length; index++) {
      result ^= value.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(16).padStart(8, "0");
  }

  function apiKey(url, scope) {
    return `${API_PREFIX}${hash(`${scope}\n${url}`)}`;
  }

  async function clearAll() {
    cacheGeneration++;
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((key) => key.startsWith(BREAKDOWN_PREFIX) || key.startsWith("aap.api.") || key.startsWith(VIEW_PREFIX));
    if (keys.length) await chrome.storage.local.remove(keys);
    memory.clear();
    return keys.length;
  }

  // A version change intentionally starts with an empty cache. This extension
  // is still in development, so old response shapes should never be reused.
  const versionReady = (async () => {
    const stored = (await chrome.storage.local.get(VERSION_KEY))[VERSION_KEY];
    if (stored !== CACHE_VERSION) {
      await clearAll();
      await chrome.storage.local.set({ [VERSION_KEY]: CACHE_VERSION });
    }
  })();

  async function get(month, scope) {
    await versionReady;
    const key = `${BREAKDOWN_PREFIX}${month}${scope ? `:${scope}` : ""}`;
    const record = (await chrome.storage.local.get(key))[key];
    if (!record) return null;
    return { ...record, stale: Date.now() - record.updatedAt > BREAKDOWN_TTL_MS };
  }

  async function set(month, scope, data) {
    const key = `${BREAKDOWN_PREFIX}${month}${scope ? `:${scope}` : ""}`;
    const record = { ...data, updatedAt: Date.now() };
    let serialized;
    try {
      serialized = JSON.stringify(record);
    } catch {
      return record;
    }
    if (!serialized || serializedSize(serialized) > MAX_BREAKDOWN_ENTRY_BYTES) return record;

    const generation = cacheGeneration;
    const operation = enqueueCacheWrite(async () => {
      await versionReady;
      if (generation !== cacheGeneration) return record;
      const all = await chrome.storage.local.get(null);
      const plan = planCacheWrite(all, key, cacheSize(record));
      if (!plan.canWrite) return record;
      if (plan.keys.length) await chrome.storage.local.remove(plan.keys);
      if (generation !== cacheGeneration) return record;
      try {
        await chrome.storage.local.set({ [key]: record });
      } catch {
        // Breakdown caches are an optimization; a quota failure must not
        // interrupt the current monetization render.
      }
      return record;
    });
    try {
      await operation;
    } catch {
      // A cache failure must never prevent a live analytics response.
    }
    return record;
  }

  async function getApi(url, ttlMs, scope = "") {
    try {
      await versionReady;
      const key = apiKey(url, scope);
      const now = Date.now();
      const inMemory = memory.get(key);
      if (inMemory && now - inMemory.cachedAt <= ttlMs) return { hit: true, data: inMemory.data };
      if (inMemory) memory.delete(key);

      const record = (await chrome.storage.local.get(key))[key];
      if (!record || record.url !== url || record.scopeHash !== hash(scope)) return { hit: false };
      if (now - record.cachedAt > ttlMs) return { hit: false };
      memory.set(key, record);
      return { hit: true, data: record.data };
    } catch {
      // A storage/quota problem must never prevent a live API request.
      return { hit: false };
    }
  }

  async function setApi(url, data, scope = "") {
    let serialized;
    try {
      serialized = JSON.stringify(data);
    } catch {
      return false;
    }
    if (!serialized || serializedSize(serialized) > MAX_API_ENTRY_BYTES) return false;

    const generation = cacheGeneration;
    const key = apiKey(url, scope);
    const operation = enqueueCacheWrite(async () => {
      await versionReady;
      if (generation !== cacheGeneration) return false;
      const record = {
        url,
        scopeHash: hash(scope),
        data,
        cachedAt: Date.now(),
        size: serializedSize(serialized),
        generation,
      };
      const all = await chrome.storage.local.get(null);
      const plan = planCacheWrite(all, key, cacheSize(record));
      if (!plan.canWrite) return false;
      if (plan.keys.length) await chrome.storage.local.remove(plan.keys);
      if (generation !== cacheGeneration) {
        return false;
      }
      try {
        await chrome.storage.local.set({ [key]: record });
      } catch {
        return false;
      }
      memory.set(key, record);
      return true;
    });
    try {
      return await operation;
    } catch {
      return false;
    }
  }

  function viewKey(name, scope) {
    return `${VIEW_PREFIX}${name}${scope ? `:${scope}` : ""}`;
  }

  function cacheType(key) {
    if (key.startsWith(API_PREFIX)) return "api";
    if (key.startsWith(VIEW_PREFIX)) return "view";
    if (key.startsWith(BREAKDOWN_PREFIX)) return "breakdown";
    return null;
  }

  function cacheSize(value) {
    try {
      const serialized = JSON.stringify(value);
      if (typeof TextEncoder === "function") return new TextEncoder().encode(serialized).length;
      // Be conservative when TextEncoder is unavailable in a test/runtime.
      return serialized.length * 2;
    } catch {
      return 0;
    }
  }

  function serializedSize(serialized) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(serialized).length;
    return serialized.length * 2;
  }

  function cacheTimestamp(value) {
    return Number(value?.cachedAt || value?.updatedAt || 0);
  }

  function isProtectedCacheKey(key) {
    return key === viewKey("builder-benchmark", "local");
  }

  function cacheLimit(type) {
    if (type === "api") return MAX_API_CACHE_BYTES;
    if (type === "view") return MAX_VIEW_CACHE_BYTES;
    if (type === "breakdown") return MAX_BREAKDOWN_CACHE_BYTES;
    return 0;
  }

  function viewEntryLimit(name) {
    return name === "builder-benchmark" ? MAX_BENCHMARK_ENTRY_BYTES : MAX_VIEW_ENTRY_BYTES;
  }

  function enqueueCacheWrite(task) {
    const operation = cacheWriteQueue.then(task);
    cacheWriteQueue = operation.catch(() => false);
    return operation;
  }

  function planCacheWrite(all, key, incomingSize) {
    const existingSize = Object.prototype.hasOwnProperty.call(all, key) ? cacheSize(all[key]) : 0;
    const type = cacheType(key);
    const rows = Object.entries(all)
      .filter(([entryKey]) => cacheType(entryKey))
      .map(([entryKey, value]) => ({
        key: entryKey,
        type: cacheType(entryKey),
        size: cacheSize(value),
        timestamp: cacheTimestamp(value),
        protected: isProtectedCacheKey(entryKey),
      }));
    const cacheRows = rows.filter((row) => row.key !== key);
    const allStorageSize = Object.entries(all).reduce((sum, [entryKey, value]) => sum + cacheSize(value), 0);
    let total = allStorageSize - existingSize + incomingSize;
    let categoryTotal = rows
      .filter((row) => row.type === type)
      .reduce((sum, row) => sum + row.size, 0) - existingSize + incomingSize;
    const categoryMax = cacheLimit(type);
    const remove = new Set();
    const candidates = cacheRows
      .filter((row) => !row.protected)
      .sort((left, right) => left.timestamp - right.timestamp);

    function evict(row) {
      if (!row || remove.has(row.key)) return;
      remove.add(row.key);
      total -= row.size;
      if (row.type === type) categoryTotal -= row.size;
    }

    for (const row of candidates) {
      if (categoryTotal <= categoryMax) break;
      if (row.type === type) evict(row);
    }
    for (const row of candidates) {
      if (total <= MAX_STORAGE_BYTES) break;
      evict(row);
    }

    return {
      canWrite: categoryTotal <= categoryMax && total <= MAX_STORAGE_BYTES,
      keys: [...remove],
    };
  }

  // Durably persists a view's already-assembled render data (e.g. a table's
  // rows), not just raw API responses, so a closed-and-reopened tab can paint
  // instantly from the last good result instead of rebuilding it from
  // scratch. Callers supply their own TTL, same as getApi(); the returned
  // `stale` flag lets a caller render immediately and decide separately
  // whether to also refresh in the background.
  async function getView(name, ttlMs, scope = "") {
    try {
      await versionReady;
      const key = viewKey(name, scope);
      const record = (await chrome.storage.local.get(key))[key];
      if (!record) return { hit: false };
      return { hit: true, data: record.data, updatedAt: record.updatedAt, stale: Date.now() - record.updatedAt > ttlMs };
    } catch {
      // Cache reads are optional; fall through to the live request.
      return { hit: false };
    }
  }

  async function setView(name, data, scope = "") {
    let serialized;
    try {
      serialized = JSON.stringify(data);
    } catch {
      return false;
    }
    if (!serialized) return false;
    const generation = cacheGeneration;
    const key = viewKey(name, scope);
    const operation = enqueueCacheWrite(async () => {
      try {
        await versionReady;
        if (generation !== cacheGeneration) return false;
        const all = await chrome.storage.local.get(null);
        const record = { data, updatedAt: Date.now(), generation };
        if (cacheSize(record) > viewEntryLimit(name)) return false;
        const plan = planCacheWrite(all, key, cacheSize(record));
        if (!plan.canWrite) return false;
        if (plan.keys.length) await chrome.storage.local.remove(plan.keys);
        if (generation !== cacheGeneration) return false;
        await chrome.storage.local.set({ [key]: record });
        return true;
      } catch {
        // Cache writes are optional. In particular, a quota race with another
        // content script must never surface as an analytics-page error.
        return false;
      }
    });
    try {
      return await operation;
    } catch {
      return false;
    }
  }

  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[CACHE_CLEAR_KEY]) {
      cacheGeneration++;
      memory.clear();
    }
    for (const key of Object.keys(changes)) {
      if (key.startsWith(API_PREFIX)) memory.delete(key);
      if (key.startsWith(BREAKDOWN_PREFIX)) memory.delete(key);
    }
  });

  self.AAP_CACHE = { get, set, getApi, setApi, getView, setView, clearAll };
})();
