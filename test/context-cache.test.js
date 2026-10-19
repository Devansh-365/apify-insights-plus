const assert = require("node:assert/strict");
const fs = require("node:fs");
const { TextEncoder } = require("node:util");
const vm = require("node:vm");

const context = {
  self: {},
  location: { pathname: "/organization/acme-123/actors/insights/monetization" },
};
vm.runInNewContext(fs.readFileSync("lib/context.js", "utf8"), context);
assert.equal(context.self.AAP_CONTEXT.organizationKey(), "org-acme-123");
assert.equal(context.self.AAP_CONTEXT.organizationKey("/actors/insights/monetization"), "personal");

const store = { "aap.cacheVersion": "9" };
const changeListeners = [];
let failNextStorageWrite = false;
let fullReads = 0;
const storage = {
  async get(keys) {
    if (keys == null) {
      fullReads++;
      return { ...store };
    }
    const requested = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(requested.filter((key) => key in store).map((key) => [key, store[key]]));
  },
  async set(values) {
    if (failNextStorageWrite) {
      failNextStorageWrite = false;
      throw new Error("Resource::kQuotaBytes quota exceeded");
    }
    const changes = {};
    for (const [key, value] of Object.entries(values)) {
      changes[key] = { oldValue: store[key], newValue: value };
      store[key] = value;
    }
    changeListeners.forEach((listener) => listener(changes, "local"));
  },
  async remove(keys) {
    const changes = {};
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (!(key in store)) continue;
      changes[key] = { oldValue: store[key] };
      delete store[key];
    }
    if (Object.keys(changes).length) changeListeners.forEach((listener) => listener(changes, "local"));
  },
  // Mirrors Chrome: key + JSON value bytes, without deserializing anything.
  async getBytesInUse() {
    return Object.entries(store).reduce((sum, [key, value]) => sum + key.length + Buffer.byteLength(JSON.stringify(value)), 0);
  },
};

const cacheContext = {
  self: {},
  TextEncoder,
  chrome: {
    storage: {
      local: storage,
      onChanged: { addListener(listener) { changeListeners.push(listener); } },
    },
  },
  console,
};
vm.runInNewContext(fs.readFileSync("lib/cache.js", "utf8"), cacheContext);

(async () => {
  await cacheContext.self.AAP_CACHE.setView("quality", { rows: [1, 2, 3] }, "org-acme");
  assert.equal((await cacheContext.self.AAP_CACHE.getView("quality", 60_000, "org-acme")).hit, true);
  assert.equal(Object.keys(store).some((key) => key.startsWith("aap.view.")), true);

  await cacheContext.self.AAP_CACHE.setView("builder-benchmark", { schemaVersion: 5 }, "local");
  const benchmarkKey = "aap.view.builder-benchmark:local";
  store[benchmarkKey].updatedAt = Date.now() - (24 * 60 * 60 * 1000) - 1;
  const expiredBenchmark = await cacheContext.self.AAP_CACHE.getView(
    "builder-benchmark",
    24 * 60 * 60 * 1000,
    "local",
  );
  assert.equal(expiredBenchmark.hit, true);
  assert.equal(expiredBenchmark.stale, true, "benchmark snapshots become stale after 24 hours");

  const oversized = await cacheContext.self.AAP_CACHE.setView(
    "builder-benchmark",
    { payload: "x".repeat(3 * 1024 * 1024) },
    "local",
  );
  assert.equal(oversized, false, "oversized snapshots report that they were not cached");

  const largeView = { payload: "x".repeat(1.6 * 1024 * 1024) };
  assert.equal(await cacheContext.self.AAP_CACHE.setView("acquisition", largeView, "org-acme"), true);
  assert.equal(await cacheContext.self.AAP_CACHE.setView("debugging", largeView, "org-acme"), true);
  assert.equal(
    store["aap.view.acquisition:org-acme"],
    undefined,
    "the shared view budget evicts an older page snapshot before writing a newer one",
  );

  store.unrelatedExtensionData = "x".repeat(8 * 1024 * 1024);
  assert.equal(
    await cacheContext.self.AAP_CACHE.setView("quota", { rows: ["quota"] }, "org-acme"),
    false,
    "cache writes skip safely when unrelated extension data consumes the shared quota",
  );
  assert.equal(store["aap.view.quota:org-acme"], undefined);
  delete store.unrelatedExtensionData;

  failNextStorageWrite = true;
  assert.equal(
    await cacheContext.self.AAP_CACHE.setView("quota-race", { rows: ["quota-race"] }, "org-acme"),
    false,
    "a quota race during storage.set is treated as an optional cache miss",
  );

  const removed = await cacheContext.self.AAP_CACHE.clearAll();
  assert.equal(removed, 2);
  assert.equal((await cacheContext.self.AAP_CACHE.getView("quality", 60_000, "org-acme")).hit, false);

  const oldStore = {
    "aap.cacheVersion": "5",
    "aap.breakdown.old": { updatedAt: Date.now() },
    "aap.api.old": { url: "https://example.test/old" },
    "aap.view.old": { data: { rows: ["old"] }, updatedAt: Date.now() },
  };
  const oldListeners = [];
  const oldStorage = {
    async get(keys) {
      if (keys == null) return { ...oldStore };
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((key) => key in oldStore).map((key) => [key, oldStore[key]]));
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) oldStore[key] = value;
      oldListeners.forEach((listener) => listener({}, "local"));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete oldStore[key];
    },
  };
  const oldCacheContext = {
    self: {},
    TextEncoder,
    chrome: {
      storage: {
        local: oldStorage,
        onChanged: { addListener(listener) { oldListeners.push(listener); } },
      },
    },
    console,
  };
  vm.runInNewContext(fs.readFileSync("lib/cache.js", "utf8"), oldCacheContext);
  await oldCacheContext.self.AAP_CACHE.getView("quality", 60_000, "org-acme");
  assert.equal(oldStore["aap.cacheVersion"], "9");
  assert.equal(Object.keys(oldStore).some((key) => key.includes("old")), false, "cache version changes must remove incompatible entries");
  await apiCacheTests();
  await compressionTests();
  console.log("context and cache tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function freshCache(extraGlobals = {}) {
  const apiStore = { "aap.cacheVersion": "9" };
  const listeners = [];
  let gets = 0;
  let setDelay = 0;
  const apiStorage = {
    async get(keys) {
      if (keys == null) {
        gets++;
        return { ...apiStore };
      }
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((key) => key in apiStore).map((key) => [key, apiStore[key]]));
    },
    async set(values) {
      if (setDelay) await new Promise((resolve) => setTimeout(resolve, setDelay));
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { newValue: value };
        apiStore[key] = value;
      }
      listeners.forEach((listener) => listener(changes, "local"));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete apiStore[key];
    },
    async getBytesInUse() {
      return Object.entries(apiStore).reduce((sum, [key, value]) => sum + key.length + Buffer.byteLength(JSON.stringify(value)), 0);
    },
  };
  const ctx = {
    self: {},
    TextEncoder,
    setTimeout,
    chrome: { storage: { local: apiStorage, onChanged: { addListener(listener) { listeners.push(listener); } } } },
    console,
    ...extraGlobals,
  };
  vm.runInNewContext(fs.readFileSync("lib/cache.js", "utf8"), ctx);
  return {
    cache: ctx.self.AAP_CACHE,
    store: apiStore,
    fullReads: () => gets,
    setStorageDelay(ms) { setDelay = ms; },
    emit(changes) { listeners.forEach((listener) => listener(changes, "local")); },
  };
}

function freshCacheWith(entries) {
  const instance = freshCache();
  Object.assign(instance.store, entries);
  return instance.cache;
}

async function apiCacheTests() {
  const { cache, store: apiStore, fullReads, setStorageDelay, emit } = freshCache();

  // Data is readable from memory before the slow storage write finishes.
  setStorageDelay(100);
  const persisted = cache.setApi("https://x.test/a?month=2026-01-01", { value: 1 }, "scope");
  const immediate = await cache.getApi("https://x.test/a?month=2026-01-01", 60_000, "scope");
  assert.equal(immediate.hit, true);
  assert.equal(immediate.data.value, 1);
  assert.equal(await persisted, true);
  setStorageDelay(0);

  // Many writes read all of storage once (to build the size index), not per write.
  const before = fullReads();
  for (let index = 0; index < 30; index++) {
    await cache.setApi(`https://x.test/bulk?i=${index}`, { index }, "scope");
  }
  assert.ok(fullReads() - before <= 1, `expected at most one full read, saw ${fullReads() - before}`);

  // Stale-while-revalidate: between staleTime and gcTime the entry is stale.
  const key = Object.keys(apiStore).find((entry) => apiStore[entry]?.url === "https://x.test/a?month=2026-01-01");
  const fresh = await cache.getApi("https://x.test/a?month=2026-01-01", { staleTime: 60_000, gcTime: 120_000 }, "scope");
  assert.equal(fresh.stale, false);
  // Read the aged record from storage in a second tab (its memory is empty).
  apiStore[key].cachedAt = Date.now() - 90_000;
  const otherTab = freshCache();
  Object.assign(otherTab.store, apiStore);
  const stale = await otherTab.cache.getApi("https://x.test/a?month=2026-01-01", { staleTime: 60_000, gcTime: 120_000 }, "scope");
  assert.equal(stale.hit, true);
  assert.equal(stale.stale, true);
  const expired = await freshCacheWith(apiStore).getApi("https://x.test/a?month=2026-01-01", { staleTime: 10_000, gcTime: 60_000 }, "scope");
  assert.equal(expired.hit, false, "entries older than gcTime are misses");
  // A newer write from another tab replaces this tab's in-memory copy.
  apiStore[key] = { ...apiStore[key], cachedAt: Date.now() + 1_000 };
  emit({ [key]: { newValue: apiStore[key] } });
  assert.equal((await cache.getApi("https://x.test/a?month=2026-01-01", 60_000, "scope")).hit, true);

  // The decoded in-memory layer is bounded.
  for (let index = 0; index < cache.MAX_MEMORY_ENTRIES + 20; index++) {
    cache.setApi(`https://x.test/memory?i=${index}`, { index }, "scope");
  }
  delete apiStore[Object.keys(apiStore).find((entry) => apiStore[entry]?.url === "https://x.test/memory?i=0")];
  const evicted = await cache.getApi("https://x.test/memory?i=0", 60_000, "scope");
  assert.equal(evicted.hit, false, "the oldest in-memory entry is evicted once the cap is exceeded");
  const kept = await cache.getApi(`https://x.test/memory?i=${cache.MAX_MEMORY_ENTRIES + 19}`, 60_000, "scope");
  assert.equal(kept.hit, true);
}

async function compressionTests() {
  if (typeof CompressionStream !== "function") return;
  const { cache, store: apiStore } = freshCache({ CompressionStream, DecompressionStream, Blob, Response, btoa, atob });
  const rows = Array.from({ length: 436 }, (_, index) => ({
    actor: { _id: `actor-${index}`, title: `Actor number ${index}`, name: `actor-${index}` },
    earningsStats: { totalRevenueUsd: index * 0.37, totalCostUsd: index * 0.02, totalProfitUsd: index * 0.35 },
    usersStats: { payingUsers: index % 7, freeUsers: index % 13 },
  }));
  const payload = { monetizationPerActor: rows };
  assert.equal(await cache.setApi("https://x.test/breakdown?month=2026-01-01", payload, "scope"), true);
  const record = Object.values(apiStore).find((value) => value?.url === "https://x.test/breakdown?month=2026-01-01");
  assert.equal(typeof record.z, "string", "large payloads are stored gzip+base64");
  assert.ok(record.z.length < JSON.stringify(payload).length / 3, "compression shrinks repetitive JSON");

  // A different tab (fresh memory) decodes the persisted copy.
  const other = freshCache({ CompressionStream, DecompressionStream, Blob, Response, btoa, atob });
  Object.assign(other.store, apiStore);
  const decoded = await other.cache.getApi("https://x.test/breakdown?month=2026-01-01", 60_000, "scope");
  assert.equal(decoded.hit, true);
  assert.deepEqual(JSON.parse(JSON.stringify(decoded.data)), payload);
}
