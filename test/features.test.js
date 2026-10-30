const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("lib/features.js", "utf8");

// A chrome.storage stand-in whose reads resolve when the test says so.
function load(saved) {
  const store = { "aap.features": saved };
  const changeListeners = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const chrome = {
    storage: {
      local: {
        get: async (key) => { await gate; return { [key]: store[key] }; },
        set: async (values) => {
          for (const [key, value] of Object.entries(values)) {
            const oldValue = store[key];
            store[key] = value;
            changeListeners.forEach((listener) => listener({ [key]: { oldValue, newValue: value } }, "local"));
          }
        },
      },
      onChanged: { addListener: (listener) => changeListeners.push(listener) },
    },
  };
  const context = { self: {}, chrome };
  vm.runInNewContext(source, context);
  return { features: context.self.AAP_FEATURES, store, release };
}

(async () => {
  // Before the saved switches are read, nothing is on: a switched-off
  // feature must not flash or start loading.
  const first = load({ quality: false });
  assert.equal(first.features.enabled("monetization"), false);
  let calls = 0;
  first.features.onChange(() => calls++);
  assert.equal(calls, 0, "listeners wait for the first read");
  first.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, "listeners run once the switches are read");
  assert.equal(first.features.enabled("monetization"), true, "features default to on");
  assert.equal(first.features.enabled("quality"), false);
  first.features.onChange(() => calls++);
  assert.equal(calls, 2, "a late listener runs right away");

  // A switch saved from the popup reaches open pages through onChanged.
  await first.features.set("monetization", false);
  assert.equal(first.features.enabled("monetization"), false);
  assert.equal(first.store["aap.features"].monetization, false);
  assert.equal(calls, 4, "both listeners heard the change");
  // Only switched-off features are saved.
  await first.features.set("monetization", true);
  assert.equal("monetization" in first.store["aap.features"], false);
  assert.equal(first.store["aap.features"].quality, false);

  // A feature that needs another is off when none of those are on.
  const off = (ids) => first.features.switchedOff(Object.fromEntries(ids.map((id) => [id, false])));
  assert.equal(first.features.isOn("portfolio", off(["monetization"])), false);
  assert.equal(first.features.isOn("portfolio", off([])), true);
  assert.equal(first.features.isOn("today", off(["acquisition"])), true, "Today still has the quality page");
  assert.equal(first.features.isOn("today", off(["acquisition", "quality"])), false);
  assert.equal(first.features.isOn("benchmark", off(["profileSort"])), false, "ranks sit in the profile stats");

  // Unknown ids and values other than false are ignored.
  const saved = first.features.switchedOff({ removedFeature: false, quality: 0, debugging: false });
  assert.equal([...saved].join(), "debugging");
  assert.equal(first.features.switchedOff("junk").size, 0);

  // Every feature has the fields the popup shows, and ids are unique.
  const ids = first.features.FEATURES.map((feature) => feature.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const feature of first.features.FEATURES) {
    assert.ok(["console", "store"].includes(feature.site), feature.id);
    assert.ok(feature.title && feature.description, feature.id);
    for (const id of feature.requires || []) assert.ok(ids.includes(id), `${feature.id} requires ${id}`);
  }

  // Without chrome.storage (a plain test page) every feature is on.
  const bare = { self: {} };
  vm.runInNewContext(source, bare);
  assert.equal(bare.self.AAP_FEATURES.enabled("quality"), true);

  console.log("features tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
