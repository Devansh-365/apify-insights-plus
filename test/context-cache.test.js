const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = {
  self: {},
  location: { pathname: "/organization/acme-123/actors/insights/monetization" },
};
vm.runInNewContext(fs.readFileSync("lib/context.js", "utf8"), context);
assert.equal(context.self.AAP_CONTEXT.organizationKey(), "org-acme-123");
assert.equal(context.self.AAP_CONTEXT.organizationKey("/actors/insights/monetization"), "personal");

const store = { "aap.cacheVersion": "5" };
const changeListeners = [];
const storage = {
  async get(keys) {
    if (keys == null) return { ...store };
    const requested = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(requested.filter((key) => key in store).map((key) => [key, store[key]]));
  },
  async set(values) {
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
};

const cacheContext = {
  self: {},
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

  const removed = await cacheContext.self.AAP_CACHE.clearAll();
  assert.equal(removed, 1);
  assert.equal((await cacheContext.self.AAP_CACHE.getView("quality", 60_000, "org-acme")).hit, false);
  console.log("context and cache tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
