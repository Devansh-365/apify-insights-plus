const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { self: {} };
vm.runInNewContext(fs.readFileSync("lib/actor-filter.js", "utf8"), context);
const model = context.self.AAP_ACTOR_FILTER;
const plain = (value) => JSON.parse(JSON.stringify(value));

// Apify's owned-Actor list in any of its wrappers; deduplicated, ids required.
const owned = model.normalize({
  items: [
    { _id: "b", name: "2gis-reviews-scraper", title: "2GIS Reviews Scraper", username: "getascraper" },
    { _id: "a", name: "17zwd-wholesale", title: "17ZWD Wholesale Fashion Scraper", username: "getascraper" },
    { _id: "a", name: "duplicate" },
    { name: "no-id" },
    { id: "c", name: "plain-name" },
  ],
});
assert.deepEqual(plain(owned.map((actor) => actor.id)), ["b", "a", "c"]);
assert.equal(owned[2].title, "plain-name", "the name stands in for a missing title");
assert.deepEqual(plain(model.normalize(null)), []);
assert.deepEqual(plain(model.normalize([{ actorId: "x", title: "From catalog" }]).map((actor) => actor.id)), ["x"]);

// The catalog adds Actors the owned list lacks, and only fills gaps.
const merged = model.merge(owned, model.normalize([{ id: "a", title: "Catalog title" }, { id: "gone", title: "Deleted Actor" }]));
assert.equal(merged.find((actor) => actor.id === "a").title, "17ZWD Wholesale Fashion Scraper", "owned titles win");
assert.equal(merged.find((actor) => actor.id === "gone").title, "Deleted Actor");
assert.equal(merged.length, 4);

// username/name, as the second line of Apify's picker.
assert.equal(model.slug(owned[0]), "getascraper/2gis-reviews-scraper");
assert.equal(model.slug({ name: "solo" }), "solo");
assert.equal(model.slug({ name: "" }), "");

// Search matches title or slug, any case, every word in any order.
assert.equal(model.matches(owned[0], ""), true);
assert.equal(model.matches(owned[0], "2gis"), true);
assert.equal(model.matches(owned[0], "REVIEWS gis"), true);
assert.equal(model.matches(owned[0], "getascraper/2gis"), true);
assert.equal(model.matches(owned[0], "fashion"), false);

// Plain alphabetical order like Apify's picker; chosen Actors first when the list opens.
assert.deepEqual(plain(model.order(owned).map((actor) => actor.id)), ["a", "b", "c"], "17ZWD before 2GIS, as in Apify's own picker");
assert.deepEqual(plain(model.order(owned, ["c"]).map((actor) => actor.id)), ["c", "a", "b"]);

// Selections compare as sets.
assert.deepEqual(plain(model.normalizeIds(["b", "a", "b", "", null])), ["a", "b"]);
assert.equal(model.sameIds(["a", "b"], ["b", "a"]), true);
assert.equal(model.sameIds([], ["a"]), false);

// The button label.
assert.equal(model.summary([], owned), "All Actors");
assert.equal(model.summary(["b"], owned), "2GIS Reviews Scraper");
assert.equal(model.summary(["unknown"], owned), "1 Actor");
assert.equal(model.summary(["a", "b", "a"], owned), "2 Actors");

console.log("actor-filter tests passed");
