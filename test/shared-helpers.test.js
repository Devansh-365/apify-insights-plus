const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const writes = [];
const intervals = [];
const removed = [];
const strayToggle = { dataset: { aapInsightsViewOwner: "quality" }, remove: () => removed.push("quality") };
const context = {
  self: {},
  location: { pathname: "/organization/acme/actors/insights" },
  setInterval: (callback) => intervals.push(callback),
  document: { querySelectorAll: (selector) => (selector === ".aap-insights-nav-view-toggle" ? [strayToggle] : []), querySelector: () => null },
  chrome: { storage: { local: {
    set: (items) => { writes.push(items); Object.assign(storage, items); return Promise.resolve(); },
    get: (keys) => Promise.resolve(Object.fromEntries([].concat(keys).filter((key) => key in storage).map((key) => [key, storage[key]]))),
    getKeys: () => Promise.resolve(Object.keys(storage)),
    remove: (keys) => { for (const key of [].concat(keys)) delete storage[key]; return Promise.resolve(); },
  } } },
};
const storage = {};
context.window = context.self;
for (const file of ["lib/context.js", "lib/format.js", "lib/local-store.js", "lib/insights-nav.js"]) {
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context);
}
const { AAP_CONTEXT, AAPF, AAP_LOCAL_STORE, AAP_INSIGHTS_NAV: NAV } = context.self;

// Account scope: organization plus signed-in account.
context.self.AAP_API = { authScope: () => "acct" };
assert.equal(AAP_CONTEXT.accountScope(), "org-acme:acct");
// Decisions are scoped by organization only, so a new login token keeps them.
assert.equal(AAP_CONTEXT.decisionScope(), "org-acme");

// Whole-number formatting.
assert.equal(AAPF.count(1234.6), "1,235");
assert.equal(AAPF.plural(1.2, "user", "users"), "1 user");
assert.equal(AAPF.plural(3, "user", "users"), "3 users");
assert.equal(AAPF.wholeMoney(0.4), "<$1");
assert.equal(AAPF.wholeMoney(1520.2), "$1,520");

// Own writes are echoes once each; a late echo of an older write is skipped
// and a change from elsewhere is not.
AAP_LOCAL_STORE.set("k", { v: 1 });
AAP_LOCAL_STORE.set("k", { v: 2 });
assert.equal(writes.length, 2);
assert.equal(AAP_LOCAL_STORE.isEcho("k", { v: 1 }), true, "late echo of the first write");
assert.equal(AAP_LOCAL_STORE.isEcho("k", { v: 2 }), true);
assert.equal(AAP_LOCAL_STORE.isEcho("k", { v: 2 }), false, "each echo is consumed once");
assert.equal(AAP_LOCAL_STORE.isEcho("k", { v: 3 }), false, "another tab's write");

// Views: the first is the default and keeps the URL clean; deep links open
// the detail view and are dropped on the default view.
const spec = { param: "aView", views: ["today", "triage", "table"], detail: "triage", deepLinks: ["aBucket", "aActor"] };
const params = (query) => new URLSearchParams(query);
assert.equal(NAV.initialView(spec, params("")), "today");
assert.equal(NAV.initialView(spec, params("aView=table")), "table");
assert.equal(NAV.initialView(spec, params("aBucket=leaking")), "triage");
assert.equal(NAV.initialView(spec, params("aView=bogus")), "today");
const url = new URL("https://console.apify.com/actors/insights/acquisition?aView=triage&aBucket=leaking&timePeriod=2026-08");
assert.equal(NAV.writeView(spec, url, "today"), false);
assert.equal(url.search, "?timePeriod=2026-08", "Today drops the view and deep links, so a reload lands on Today");
assert.equal(NAV.writeView(spec, url, "triage"), true);
assert.equal(url.searchParams.get("aView"), "triage");

// The Original/Plus toggle never mounts outside the Insights pages, and a
// stray one is swept away there.
context.location.pathname = "/actors/ALvOlTklatipYeFGg/source";
assert.equal(NAV.ensureViewToggle("quality", "custom", () => {}), null, "no toggle on an Actor's own page");
assert.deepEqual(removed, ["quality"], "an existing one is removed");
removed.length = 0;
intervals.forEach((sweep) => sweep());
assert.deepEqual(removed, ["quality"], "the sweep clears a toggle left by a late render");
removed.length = 0;
context.location.pathname = "/organization/acme/actors/insights/actor-quality";
intervals.forEach((sweep) => sweep());
assert.deepEqual(removed, [], "kept on an Insights page");

// Saved state keyed by older login tokens is merged into the new key once,
// and the old copies are removed; after that the new key is read as is.
(async () => {
  storage["d:org-a:account-1"] = { n: 1 };
  storage["d:org-a:account-2"] = { n: 2 };
  storage["d:org-ab:account-3"] = { n: 100 };
  const merge = (values) => ({ n: values.reduce((sum, value) => sum + value.n, 0) });
  assert.deepEqual(await AAP_LOCAL_STORE.getMigrated("d:org-a", "d:org-a:", merge), { n: 3 });
  assert.deepEqual(storage["d:org-a"], { n: 3 });
  assert.equal("d:org-a:account-1" in storage, false, "old copies are removed");
  assert.deepEqual(storage["d:org-ab:account-3"], { n: 100 }, "another organization is left alone");
  assert.equal(AAP_LOCAL_STORE.isEcho("d:org-a", { n: 3 }), true, "the merged write is this tab's own");
  storage["d:org-a:account-9"] = { n: 50 };
  assert.deepEqual(await AAP_LOCAL_STORE.getMigrated("d:org-a", "d:org-a:", merge), { n: 3 }, "once per page load");
  // Old copies left behind (here, by an older version still running in
  // another tab) are folded into the existing value on the next load.
  storage["e:org"] = { n: 10 };
  storage["e:org:account-1"] = { n: 5 };
  assert.deepEqual(await AAP_LOCAL_STORE.getMigrated("e:org", "e:org:", merge), { n: 15 });
  // A storage error falls back to the saved value and keeps the old copies.
  const getKeys = context.chrome.storage.local.getKeys;
  context.chrome.storage.local.getKeys = () => Promise.reject(new Error("quota"));
  storage["f:org"] = { n: 1 };
  storage["f:org:account-1"] = { n: 2 };
  assert.deepEqual(await AAP_LOCAL_STORE.getMigrated("f:org", "f:org:", merge), { n: 1 });
  assert.ok("f:org:account-1" in storage);
  context.chrome.storage.local.getKeys = getKeys;
  assert.equal(await AAP_LOCAL_STORE.getMigrated("d:none", "d:none:", merge), undefined);
  console.log("shared helper tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
