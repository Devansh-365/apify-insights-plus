const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { self: {} };
vm.runInNewContext(fs.readFileSync("lib/visibility.js", "utf8"), context);
const model = context.self.AAP_VISIBILITY;

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

// Store-listed Actors are public without a check; the rest need basic info.
const publicIds = new Set(["pub"]);
assert.equal(model.candidates(owned, publicIds).map((actor) => actor.id).join(), "new,was,lag,err");

const infos = new Map([
  ["new", { isPublic: false, username: "me" }],
  ["was", { isPublic: false, firstPublishedAt: "2026-03-04T10:00:00.000Z", pictureUrl: "https://x/p.png" }],
  // Public but not in the Store response yet: not listed as private.
  ["lag", { isPublic: true }],
  ["err", null],
]);
// No visibility flag at all: counted as unchecked, never as public.
const noFlag = model.classify(owned.slice(0, 2), new Set(["pub"]), new Map([["new", { username: "me" }]]));
assert.equal(noFlag.hidden.length, 0);
assert.equal(noFlag.unknown, 1);
const { hidden, unknown } = model.classify(owned, publicIds, infos);
assert.equal(hidden.map((actor) => actor.id).join(), "new,was");
assert.equal(hidden[0].firstPublishedAt, null, "never published");
assert.equal(hidden[0].username, "me");
assert.equal(hidden[1].firstPublishedAt, Date.parse("2026-03-04T10:00:00.000Z"), "unpublished after being public");
assert.equal(hidden[1].pictureUrl, "https://x/p.png");
assert.equal(unknown, 1, "a failed check is reported, not guessed");

// Search matches title, name, or the full username/name.
assert.equal(model.matchesQuery(hidden[1], "WAS PUB"), true);
assert.equal(model.matchesQuery(hidden[0], "me/new"), true);
assert.equal(model.matchesQuery(hidden[0], "zzz"), false);
assert.equal(model.matchesQuery(hidden[0], "  "), true);

console.log("visibility tests passed");
