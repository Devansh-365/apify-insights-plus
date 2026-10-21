const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const writes = [];
const context = {
  self: {},
  location: { pathname: "/organization/acme/actors/insights" },
  chrome: { storage: { local: { set: (items) => { writes.push(items); return Promise.resolve(); } } } },
};
context.window = context.self;
for (const file of ["lib/context.js", "lib/format.js", "lib/local-store.js", "lib/insights-nav.js"]) {
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context);
}
const { AAP_CONTEXT, AAPF, AAP_LOCAL_STORE, AAP_INSIGHTS_NAV: NAV } = context.self;

// Account scope: organization plus signed-in account.
context.self.AAP_API = { authScope: () => "acct" };
assert.equal(AAP_CONTEXT.accountScope(), "org-acme:acct");

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

console.log("shared helper tests passed");
