const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { self: {} };
vm.runInNewContext(fs.readFileSync("lib/visibility.js", "utf8"), context);
const model = context.self.AAP_VISIBILITY;
const plainObject = (value) => JSON.parse(JSON.stringify(value));

// Only the My Actors page, in a personal or an organization account.
assert.equal(model.developmentRoute("/actors/development"), true);
assert.equal(model.developmentRoute("/organization/acme/actors/development/"), true);
assert.equal(model.developmentRoute("/actors/development/abc"), false);
assert.equal(model.developmentRoute("/actors"), false);
assert.equal(model.routePrefix("/actors/development"), "/");
assert.equal(model.routePrefix("/organization/acme/actors/development"), "/organization/acme/");

// The owned list is deduplicated and keeps Actors with an id only.
const owned = model.ownedActors([
  { _id: "pub", name: "pub", title: "Public one" },
  { _id: "new", name: "new" },
  { _id: "was", name: "was", title: "Was public" },
  { _id: "lag", name: "lag", title: "Store lag" },
  { _id: "err", name: "err", title: "Errored" },
  { _id: "pub", name: "pub" },
  { name: "no-id" },
]);
assert.equal(owned.map((actor) => actor.id).join(), "pub,new,was,lag,err");
assert.equal(owned[1].title, "new", "the name stands in for a missing title");

// Store-listed Actors need no check; the rest need their own info.
const publicIds = new Set(["pub"]);
assert.equal(model.candidates(owned, publicIds).map((actor) => actor.id).join(), "new,was,lag,err");

// Search matches title, name, or the full username/name.
const searchable = { title: "Was public", name: "was", username: "me" };
assert.equal(model.matchesQuery(searchable, "WAS PUB"), true);
assert.equal(model.matchesQuery(searchable, "me/was"), true);
assert.equal(model.matchesQuery(searchable, "zzz"), false);
assert.equal(model.matchesQuery(searchable, "  "), true);

// ---- Store status filter -------------------------------------------------
assert.equal(model.STATUSES.map((status) => status.key).join(), "maintenance,deprecated");
const statusOwned = model.ownedActors([
  { _id: "paid", name: "paid", title: "Paid" },
  { _id: "maint", name: "maint", title: "Maintenance" },
  { _id: "freebie", name: "freebie", title: "Freebie" },
  { _id: "secret", name: "secret", title: "Secret" },
  { _id: "old", name: "old", title: "Old", isDeprecated: true },
  { _id: "gone", name: "gone", title: "Gone from Store" },
  { _id: "fail", name: "fail", title: "Failed check" },
  { _id: "lag2", name: "lag2", title: "Public, unlisted" },
]);
const store = model.storeEntries([
  { id: "paid", notice: "NONE", currentPricingInfo: { pricingModel: "PAY_PER_EVENT" } },
  { id: "maint", notice: "UNDER_MAINTENANCE", currentPricingInfo: { pricingModel: "PRICE_PER_DATASET_ITEM" } },
  { id: "freebie", notice: "NONE", currentPricingInfo: { pricingModel: "FREE" } },
  { id: "old", notice: "NONE", currentPricingInfo: { pricingModel: "PAY_PER_EVENT" } },
  { notice: "UNDER_MAINTENANCE" },
]);
const statusInfos = new Map([
  ["secret", { isPublic: false, firstPublishedAt: "2026-01-02T00:00:00.000Z" }],
  ["gone", { isPublic: true, isDeprecated: true, pricingInfos: [{ pricingModel: "PAY_PER_EVENT" }] }],
  ["fail", null],
  ["lag2", { isPublic: true }],
]);
const status = model.statusRows(statusOwned, store, statusInfos, new Set(["paid"]));
const byId = Object.fromEntries(status.rows.map((row) => [row.id, row.statuses.join("+")]));
assert.deepEqual(plainObject(byId), {
  paid: "deprecated", // from the monetization breakdown
  maint: "maintenance",
  old: "deprecated", // from the Console's own list
  gone: "deprecated", // public but unlisted, from basic or public info
});
assert.equal(status.unknown, 1, "a failed check is counted, not guessed");
assert.deepEqual(plainObject(status.counts), { maintenance: 1, deprecated: 3 });
assert.equal(status.rows.some((row) => row.id === "secret"), false, "a private Actor without a flag is left out");
assert.equal(status.rows.some((row) => row.id === "freebie" || row.id === "lag2"), false, "public, listed or not, with no flag is left out");

// Any selected status matches; search narrows further.
assert.equal(model.filterRows(status.rows, ["maintenance", "private"]).map((row) => row.id).join(), "maint", "unknown keys match nothing");
assert.equal(model.filterRows(status.rows, ["maintenance", "deprecated"]).map((row) => row.id).join(), "gone,maint,old,paid", "sorted by title");
assert.equal(model.filterRows(status.rows, ["deprecated"], "gone").map((row) => row.id).join(), "gone");
assert.equal(model.filterRows(status.rows, []).length, 0);
assert.deepEqual([...model.normalizeSelection(["private", "free", "bogus", "deprecated", "maintenance"])], ["maintenance", "deprecated"], "menu order, known keys only; removed statuses are dropped");
assert.deepEqual([...model.normalizeSelection(null)], []);

// Deprecated ids from an actor-breakdown response.
assert.deepEqual([...model.deprecatedIds({ monetizationPerActor: [{ actor: { _id: "a", isDeprecated: true } }, { actor: { _id: "b" } }] })], ["a"]);
assert.deepEqual([...model.deprecatedIds(null)], []);

console.log("visibility tests passed");
