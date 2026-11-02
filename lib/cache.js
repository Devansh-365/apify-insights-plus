/* Small persistent cache for analytics responses and monetization breakdowns. */
(function () {
  const BREAKDOWN_PREFIX = "aap.breakdown.";
  const API_PREFIX = "aap.api.v2.";
  const VIEW_PREFIX = "aap.view.";
  const VERSION_KEY = "aap.cacheVersion";
  const CACHE_CLEAR_KEY = "aap.cacheClearedAt";
  // Bumped for the compressed record format and canonical request URLs.
  const CACHE_VERSION = "9";
  const BREAKDOWN_TTL_MS = 15 * 60 * 1000;
  const DEFAULT_API_GC_MS = 60 * 60 * 1000;
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
  // Decoded responses kept in memory per tab; oldest-used entries go first.
  const MAX_MEMORY_ENTRIES = 100;
  // Small payloads are not worth the gzip + base64 round trip.
  const COMPRESS_MIN_BYTES = 8 * 1024;

  const perf = self.AAP_PERF || null;
  const memory = new Map();
  let cacheWriteQueue = Promise.resolve();
  let cacheGeneration = 0;
  // Size index of cache records, built once from storage on the first write
  // instead of reading and re-serializing all of storage on every write.
  let index = null;
  let indexReady = null;
  let otherBytes = 0;

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

  function resetIndex() {
    index = null;
    indexReady = null;
    otherBytes = 0;
  }

  async function clearAll() {
    cacheGeneration++;
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((key) => key.startsWith(BREAKDOWN_PREFIX) || key.startsWith("aap.api.") || key.startsWith(VIEW_PREFIX));
    if (keys.length) await chrome.storage.local.remove(keys);
    memory.clear();
    resetIndex();
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

  // ---- Encoding: gzip + base64 for large payloads -----------------------
  // chrome.storage.local stores JSON only, so compressed bytes are kept as a
  // base64 string ({ z }). Plain payloads stay as { data } objects.
  function compressionAvailable() {
    return typeof CompressionStream === "function"
      && typeof DecompressionStream === "function"
      && typeof Blob === "function"
      && typeof Response === "function"
      && typeof btoa === "function"
      && typeof atob === "function";
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let offset = 0; offset < binary.length; offset++) bytes[offset] = binary.charCodeAt(offset);
    return bytes;
  }

  async function gzipText(text) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function gunzipText(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }

  function byteLength(text) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
    return text.length * 2;
  }

  // Returns the payload fields to store on a record plus their stored size.
  async function encodePayload(data) {
    const serialized = JSON.stringify(data);
    if (serialized == null) throw new Error("Unserializable cache payload");
    const plainBytes = byteLength(serialized);
    if (plainBytes >= COMPRESS_MIN_BYTES && compressionAvailable()) {
      try {
        const started = perf?.now();
        const z = bytesToBase64(await gzipText(serialized));
        if (perf) {
          perf.time("cache.compressMs", perf.now() - started);
          perf.count("cache.compressedBytesSaved", Math.max(0, plainBytes - z.length));
        }
        if (z.length < plainBytes) return { fields: { z }, bytes: z.length };
      } catch {
        // Fall back to the plain JSON payload below.
      }
    }
    return { fields: { data }, bytes: plainBytes };
  }

  async function decodePayload(record) {
    if (typeof record?.z === "string") {
      const started = perf?.now();
      const data = JSON.parse(await gunzipText(base64ToBytes(record.z)));
      if (perf) perf.time("cache.decompressMs", perf.now() - started);
      return data;
    }
    return record?.data;
  }

  // ---- Index and eviction -----------------------------------------------
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
      return byteLength(JSON.stringify(value));
    } catch {
      return 0;
    }
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

  function metaFor(key, record) {
    return {
      type: cacheType(key),
      // Records carry their own stored size, so other tabs' writes can be
      // indexed from storage.onChanged without re-serializing them.
      bytes: Number(record?.bytes) || cacheSize(record),
      timestamp: cacheTimestamp(record),
      gcUntil: Number(record?.gcUntil) || 0,
      protected: isProtectedCacheKey(key),
    };
  }

  function ensureIndex() {
    if (!indexReady) {
      indexReady = (async () => {
        await versionReady;
        const all = await chrome.storage.local.get(null);
        const built = new Map();
        let other = 0;
        for (const [key, value] of Object.entries(all)) {
          if (cacheType(key)) built.set(key, metaFor(key, value));
          else other += cacheSize(value) + key.length;
        }
        index = built;
        otherBytes = other;
      })().catch((error) => {
        indexReady = null;
        throw error;
      });
    }
    return indexReady;
  }

  // Unrelated extension data can change without touching our index; ask
  // Chrome for the real total (cheap, no deserialization) when available.
  async function refreshOtherBytes() {
    const getBytes = chrome.storage.local.getBytesInUse;
    if (typeof getBytes !== "function") return;
    try {
      const total = await getBytes.call(chrome.storage.local, null);
      if (!Number.isFinite(total)) return;
      let indexed = 0;
      for (const meta of index.values()) indexed += meta.bytes;
      otherBytes = Math.max(0, total - indexed);
    } catch {
      // Keep the last known estimate.
    }
  }

  function planCacheWrite(key, incomingBytes) {
    if (!index) return { canWrite: false, keys: [] };
    const type = cacheType(key);
    let total = otherBytes;
    let categoryTotal = 0;
    for (const [entryKey, meta] of index) {
      if (entryKey === key) continue;
      total += meta.bytes;
      if (meta.type === type) categoryTotal += meta.bytes;
    }
    total += incomingBytes;
    categoryTotal += incomingBytes;
    const categoryMax = cacheLimit(type);
    const now = Date.now();
    // Expired entries go first, then the oldest by write time.
    const candidates = [...index.entries()]
      .filter(([entryKey, meta]) => entryKey !== key && !meta.protected)
      .sort(([, left], [, right]) => {
        const leftExpired = left.gcUntil && left.gcUntil < now ? 0 : 1;
        const rightExpired = right.gcUntil && right.gcUntil < now ? 0 : 1;
        return leftExpired - rightExpired || left.timestamp - right.timestamp;
      });
    const remove = new Set();

    function evict(entryKey, meta) {
      if (remove.has(entryKey)) return;
      remove.add(entryKey);
      total -= meta.bytes;
      if (meta.type === type) categoryTotal -= meta.bytes;
    }

    for (const [entryKey, meta] of candidates) {
      if (categoryTotal <= categoryMax) break;
      if (meta.type === type) evict(entryKey, meta);
    }
    for (const [entryKey, meta] of candidates) {
      if (total <= MAX_STORAGE_BYTES) break;
      evict(entryKey, meta);
    }
    return {
      canWrite: categoryTotal <= categoryMax && total <= MAX_STORAGE_BYTES,
      keys: [...remove],
    };
  }

  function recordEvictions(keys) {
    if (!perf) return;
    const now = Date.now();
    for (const key of keys) {
      const meta = index.get(key);
      if (!meta) continue;
      perf.count("cache.evicted");
      if (meta.gcUntil && meta.gcUntil > now) perf.count("cache.evictedBeforeExpiry");
      if (meta.timestamp) perf.time("cache.evictedAgeMs", now - meta.timestamp);
    }
  }

  function enqueueCacheWrite(task) {
    const operation = cacheWriteQueue.then(task);
    cacheWriteQueue = operation.catch(() => false);
    return operation;
  }

  // Shared write path: make room according to the index, then store.
  async function writeRecord(key, record, generation) {
    await ensureIndex();
    if (generation !== cacheGeneration) return false;
    await refreshOtherBytes();
    // A cache clear during the await resets the index; skip this write.
    if (generation !== cacheGeneration || !index) return false;
    const plan = planCacheWrite(key, record.bytes);
    if (!plan.canWrite) {
      perf?.count("cache.writeSkipped");
      return false;
    }
    if (plan.keys.length) {
      recordEvictions(plan.keys);
      await chrome.storage.local.remove(plan.keys);
      for (const evicted of plan.keys) {
        index.delete(evicted);
        memory.delete(evicted);
      }
    }
    if (generation !== cacheGeneration) return false;
    await chrome.storage.local.set({ [key]: record });
    index?.set(key, metaFor(key, record));
    return true;
  }

  function remember(key, entry) {
    memory.delete(key);
    memory.set(key, entry);
    while (memory.size > MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value);
  }

  // Stored size of a record: the encoded payload plus its JSON envelope.
  function recordBytes(record, payloadBytes) {
    const envelope = { ...record };
    delete envelope.data;
    delete envelope.z;
    return payloadBytes + byteLength(JSON.stringify(envelope)) + 24;
  }

  function normalizePolicy(policy) {
    if (typeof policy === "number") return { staleTime: policy, gcTime: policy };
    const staleTime = Number(policy?.staleTime) || 0;
    return { staleTime, gcTime: Math.max(staleTime, Number(policy?.gcTime) || staleTime) };
  }

  // ---- Monetization breakdowns (legacy month view) ----------------------
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
    let bytes;
    try {
      bytes = byteLength(JSON.stringify(record));
    } catch {
      return record;
    }
    if (!bytes || bytes > MAX_BREAKDOWN_ENTRY_BYTES) return record;
    record.bytes = bytes;
    const generation = cacheGeneration;
    try {
      await enqueueCacheWrite(async () => {
        await versionReady;
        return writeRecord(key, record, generation);
      });
    } catch {
      // Breakdown caches are an optimization; a quota failure must not
      // interrupt the current monetization render.
    }
    return record;
  }

  // ---- API responses ------------------------------------------------------
  // Stale-while-revalidate: entries younger than staleTime are fresh; up to
  // gcTime they are returned with `stale: true` so the caller can render now
  // and refresh in the background; older entries are misses.
  async function getApi(url, policy, scope = "") {
    const started = perf?.now();
    try {
      await versionReady;
      const { staleTime, gcTime } = normalizePolicy(policy);
      const key = apiKey(url, scope);
      const now = Date.now();
      const inMemory = memory.get(key);
      if (inMemory && inMemory.url === url) {
        const age = now - inMemory.cachedAt;
        if (age <= gcTime) {
          remember(key, inMemory);
          const stale = age > staleTime;
          perf?.count(stale ? "cache.staleHit" : "cache.hit");
          return { hit: true, data: inMemory.data, stale, cachedAt: inMemory.cachedAt };
        }
        memory.delete(key);
      }

      const record = (await chrome.storage.local.get(key))[key];
      if (!record || record.url !== url || record.scopeHash !== hash(scope)) {
        perf?.count("cache.miss");
        return { hit: false };
      }
      const age = now - record.cachedAt;
      if (age > gcTime) {
        perf?.count("cache.miss");
        return { hit: false };
      }
      const data = await decodePayload(record);
      remember(key, { url, data, cachedAt: record.cachedAt });
      const stale = age > staleTime;
      perf?.count(stale ? "cache.staleHit" : "cache.hit");
      return { hit: true, data, stale, cachedAt: record.cachedAt };
    } catch {
      // A storage/quota/decoding problem must never prevent a live request.
      perf?.count("cache.miss");
      return { hit: false };
    } finally {
      if (perf) perf.time("cache.readMs", perf.now() - started);
    }
  }

  // Updates memory synchronously and persists in the background. Callers can
  // return the data immediately; the returned promise reports whether the
  // persisted write succeeded. `requestedAt` dates the copy from when it was
  // requested, so freshness and "which copy is newer" follow the data's age.
  function setApi(url, data, scope = "", policy, requestedAt) {
    const key = apiKey(url, scope);
    const cachedAt = Number.isFinite(requestedAt) ? requestedAt : Date.now();
    remember(key, { url, data, cachedAt });
    const { gcTime } = policy ? normalizePolicy(policy) : { gcTime: DEFAULT_API_GC_MS };
    const generation = cacheGeneration;
    const started = perf?.now();
    return enqueueCacheWrite(async () => {
      await versionReady;
      if (generation !== cacheGeneration) return false;
      const encoded = await encodePayload(data);
      if (encoded.bytes > MAX_API_ENTRY_BYTES) {
        perf?.count("cache.writeSkipped");
        return false;
      }
      const record = {
        url,
        scopeHash: hash(scope),
        cachedAt,
        gcUntil: cachedAt + (gcTime || DEFAULT_API_GC_MS),
        generation,
        ...encoded.fields,
      };
      record.bytes = recordBytes(record, encoded.bytes);
      return writeRecord(key, record, generation);
    }).then((written) => {
      if (perf) perf.time("cache.writeMs", perf.now() - started);
      return written;
    }, () => false);
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
      const data = await decodePayload(record);
      return { hit: true, data, updatedAt: record.updatedAt, stale: Date.now() - record.updatedAt > ttlMs };
    } catch {
      // Cache reads are optional; fall through to the live request.
      return { hit: false };
    }
  }

  async function setView(name, data, scope = "") {
    const generation = cacheGeneration;
    const key = viewKey(name, scope);
    const updatedAt = Date.now();
    try {
      return await enqueueCacheWrite(async () => {
        await versionReady;
        if (generation !== cacheGeneration) return false;
        const encoded = await encodePayload(data);
        const record = { updatedAt, generation, ...encoded.fields };
        record.bytes = recordBytes(record, encoded.bytes);
        if (record.bytes > viewEntryLimit(name)) return false;
        return writeRecord(key, record, generation);
      });
    } catch {
      // Cache writes are optional. In particular, a quota race with another
      // content script must never surface as an analytics-page error.
      return false;
    }
  }

  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[CACHE_CLEAR_KEY]) {
      cacheGeneration++;
      memory.clear();
      resetIndex();
    }
    for (const [key, change] of Object.entries(changes)) {
      if (!cacheType(key)) continue;
      const record = change.newValue;
      if (!record) {
        index?.delete(key);
        memory.delete(key);
        continue;
      }
      index?.set(key, metaFor(key, record));
      // Another tab wrote a newer copy: drop ours so the next read decodes it.
      const inMemory = memory.get(key);
      if (inMemory && record.cachedAt && inMemory.cachedAt < record.cachedAt) memory.delete(key);
    }
  });

  self.AAP_CACHE = { get, set, getApi, setApi, getView, setView, clearAll, MAX_MEMORY_ENTRIES };
})();
