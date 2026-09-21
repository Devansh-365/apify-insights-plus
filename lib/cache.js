/* Small persistent cache for analytics responses and monetization breakdowns. */
(function () {
  const BREAKDOWN_PREFIX = "aap.breakdown.";
  const API_PREFIX = "aap.api.v2.";
  const VIEW_PREFIX = "aap.view.";
  const VERSION_KEY = "aap.cacheVersion";
  const CACHE_CLEAR_KEY = "aap.cacheClearedAt";
  const CACHE_VERSION = "6";
  const BREAKDOWN_TTL_MS = 15 * 60 * 1000;
  const MAX_API_ENTRY_BYTES = 900 * 1024;
  const MAX_API_CACHE_BYTES = 5 * 1024 * 1024;
  // chrome.storage.local's total quota is 10MB without the unlimitedStorage
  // permission (which this extension does not request). The API cache above
  // already reserves 5MB for itself, so the view cache gets its own smaller,
  // separately-tracked budget carved out of what's left rather than an
  // unbounded per-name entry count - a large account's acquisition/debugging
  // history across several browsed months could otherwise add up to many
  // megabytes on its own.
  const MAX_VIEW_ENTRY_BYTES = 2 * 1024 * 1024;
  const MAX_VIEW_CACHE_BYTES = 3 * 1024 * 1024;

  const memory = new Map();
  let apiMetadataPromise = null;
  let apiWriteQueue = Promise.resolve();
  let viewWriteQueue = Promise.resolve();
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
    apiMetadataPromise = null;
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

  async function getApiMetadata() {
    if (!apiMetadataPromise) {
      apiMetadataPromise = (async () => {
        await versionReady;
        const all = await chrome.storage.local.get(null);
        return new Map(
          Object.entries(all)
            .filter(([key, value]) => key.startsWith(API_PREFIX) && value?.url)
            .map(([key, value]) => [key, { cachedAt: value.cachedAt || 0, size: value.size || 0 }]),
        );
      })();
    }
    return apiMetadataPromise;
  }

  async function get(month, scope) {
    await versionReady;
    const key = `${BREAKDOWN_PREFIX}${month}${scope ? `:${scope}` : ""}`;
    const record = (await chrome.storage.local.get(key))[key];
    if (!record) return null;
    return { ...record, stale: Date.now() - record.updatedAt > BREAKDOWN_TTL_MS };
  }

  async function set(month, scope, data) {
    await versionReady;
    const key = `${BREAKDOWN_PREFIX}${month}${scope ? `:${scope}` : ""}`;
    const record = { ...data, updatedAt: Date.now() };
    await chrome.storage.local.set({ [key]: record });
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
      return;
    }
    if (!serialized || serialized.length > MAX_API_ENTRY_BYTES) return;

    const generation = cacheGeneration;
    const operation = apiWriteQueue.then(async () => {
      await versionReady;
      if (generation !== cacheGeneration) return;
      const key = apiKey(url, scope);
      const record = {
        url,
        scopeHash: hash(scope),
        data,
        cachedAt: Date.now(),
        size: serialized.length,
        generation,
      };
      const metadata = await getApiMetadata();
      metadata.set(key, { cachedAt: record.cachedAt, size: record.size });
      let total = [...metadata.values()].reduce((sum, item) => sum + item.size, 0);
      const remove = [];
      for (const [oldKey, item] of [...metadata.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)) {
        if (total <= MAX_API_CACHE_BYTES || oldKey === key) continue;
        total -= item.size;
        remove.push(oldKey);
        metadata.delete(oldKey);
      }
      await chrome.storage.local.set({ [key]: record });
      if (generation !== cacheGeneration) {
        const current = (await chrome.storage.local.get(key))[key];
        if (current?.generation === generation) await chrome.storage.local.remove(key);
        return;
      }
      if (remove.length) await chrome.storage.local.remove(remove);
      memory.set(key, record);
    });
    apiWriteQueue = operation.catch(() => {});
    await apiWriteQueue;
  }

  function viewKey(name, scope) {
    return `${VIEW_PREFIX}${name}${scope ? `:${scope}` : ""}`;
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
    } catch (error) {
      console.warn(`[Apify Insights Plus] Failed to read cached "${name}" for offline reload.`, error);
      return { hit: false };
    }
  }

  async function setView(name, data, scope = "") {
    let serialized;
    try {
      serialized = JSON.stringify(data);
    } catch {
      return;
    }
    if (!serialized) return;
    if (serialized.length > MAX_VIEW_ENTRY_BYTES) {
      console.warn(`[Apify Insights Plus] Skipped caching "${name}" for offline reload: ${Math.round(serialized.length / 1024)}KB exceeds the ${Math.round(MAX_VIEW_ENTRY_BYTES / 1024)}KB per-entry limit.`);
      return;
    }
    const generation = cacheGeneration;
    const operation = viewWriteQueue.then(async () => {
      try {
        await versionReady;
        if (generation !== cacheGeneration) return;
        const key = viewKey(name, scope);
        const size = serialized.length;
        const all = await chrome.storage.local.get(null);
        const entries = Object.entries(all)
          .filter(([k, v]) => k.startsWith(VIEW_PREFIX) && k !== key && v?.updatedAt)
          .map(([k, v]) => [k, { updatedAt: v.updatedAt, size: JSON.stringify(v.data ?? "").length }])
          .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
        let total = size + entries.reduce((sum, [, item]) => sum + item.size, 0);
        const remove = [];
        for (const [oldKey, item] of entries) {
          if (total <= MAX_VIEW_CACHE_BYTES) break;
          total -= item.size;
          remove.push(oldKey);
        }
        await chrome.storage.local.set({ [key]: { data, updatedAt: Date.now(), generation } });
        if (generation !== cacheGeneration) {
          const current = (await chrome.storage.local.get(key))[key];
          if (current?.generation === generation) await chrome.storage.local.remove(key);
          return;
        }
        if (remove.length) await chrome.storage.local.remove(remove);
      } catch (error) {
        // A storage/quota problem must never prevent a live render.
        console.warn(`[Apify Insights Plus] Failed to cache "${name}" for offline reload.`, error);
      }
    });
    viewWriteQueue = operation.catch(() => {});
    await viewWriteQueue;
  }

  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[CACHE_CLEAR_KEY]) {
      cacheGeneration++;
      memory.clear();
      apiMetadataPromise = null;
    }
    for (const key of Object.keys(changes)) {
      if (key.startsWith(API_PREFIX)) memory.delete(key);
      if (key.startsWith(BREAKDOWN_PREFIX)) memory.delete(key);
    }
  });

  self.AAP_CACHE = { get, set, getApi, setApi, getView, setView, clearAll };
})();
