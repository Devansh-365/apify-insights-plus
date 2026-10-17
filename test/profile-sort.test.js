const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { self: {} };
vm.runInNewContext(fs.readFileSync("lib/profile-sort.js", "utf8"), context);
const helpers = context.self.AAP_PROFILE_SORT;

assert.equal(helpers.profileRoute("/builder-name").key, "builder-name");
assert.equal(helpers.profileRoute("/builder-name").username, "builder-name");
assert.equal(helpers.profileRoute("/store"), null);

const response = {
  data: {
    total: 4,
    items: [
      {
        id: "actor-a",
        name: "actor-a",
        title: "Actor A",
        username: "builder",
        stats: {
          totalRuns: 12,
          publicActorRunStats30Days: { TOTAL: 7 },
          totalUsers30Days: 3,
          totalUsers: 8,
          bookmarkCount: 2,
          actorReviewCount: 2,
        },
      },
      {
        id: "actor-b",
        name: "actor-b",
        title: "Actor B",
        username: "builder",
        stats: {
          totalRuns: 40,
          publicActorRunStats30Days: { TOTAL: 11 },
          totalUsers30Days: 1,
          totalUsers: 20,
          bookmarkCount: 5,
        },
        actorReviewCount: 5,
      },
      {
        id: "actor-c",
        name: "actor-c",
        title: "Actor C",
        username: "builder",
        stats: { totalRuns: 0, totalUsers30Days: 0, totalUsers: 0, bookmarkCount: 0, actorReviewCount: 0 },
      },
      { id: "actor-d", name: "actor-d", title: "Actor D", username: "builder", stats: {} },
    ],
  },
};

const actors = helpers.normalizeStoreResponse(response);
assert.equal(helpers.storeTotal(response), 4);
assert.equal(helpers.actorKey(actors[0]), "builder/actor-a");
assert.equal(actors[0].mau, 3);
assert.equal(actors[0].monthlyRuns, 7);
assert.equal(actors[1].bookmarks, 5);
assert.equal(actors[0].actorReviewCount, 2);
assert.equal(actors[1].actorReviewCount, 5);
assert.equal(actors[2].runs, 0, "zero is a known metric value");
assert.equal(actors[2].monthlyRuns, null, "missing monthly run metrics remain missing");
assert.equal(actors[3].users, null, "missing metrics remain missing");
const aggregate = helpers.aggregateActorStats(actors);
assert.equal(aggregate.totalRuns, 52);
assert.equal(aggregate.monthlyRuns, 18);
assert.equal(aggregate.totalReviews, 7);
assert.equal(aggregate.totalBookmarks, 7);

assert.deepEqual(Array.from(helpers.sortActors(actors, "runs"), (actor) => actor.name), [
  "actor-b",
  "actor-a",
  "actor-c",
  "actor-d",
]);
assert.deepEqual(Array.from(helpers.sortActors(actors, "monthlyRuns"), (actor) => actor.name), [
  "actor-b",
  "actor-a",
  "actor-c",
  "actor-d",
]);
assert.deepEqual(Array.from(helpers.sortActors(actors, "users", "asc"), (actor) => actor.name), [
  "actor-c",
  "actor-a",
  "actor-b",
  "actor-d",
]);
assert.deepEqual(Array.from(helpers.sortActors(actors, "bookmarks"), (actor) => actor.name), [
  "actor-b",
  "actor-a",
  "actor-c",
  "actor-d",
]);
assert.deepEqual(Array.from(helpers.sortActors(actors, "default"), (actor) => actor.name), [
  "actor-a",
  "actor-b",
  "actor-c",
  "actor-d",
]);
assert.deepEqual(Array.from(helpers.sortActors(actors, "newest"), (actor) => actor.name), [
  "actor-a",
  "actor-b",
  "actor-c",
  "actor-d",
]);
assert.deepEqual(Array.from(helpers.sortActors(actors, "newest", "asc"), (actor) => actor.name), [
  "actor-d",
  "actor-c",
  "actor-b",
  "actor-a",
]);

assert.deepEqual(Array.from(helpers.filterActors(actors, "mau", "gte", 2), (actor) => actor.name), ["actor-a"]);
assert.deepEqual(Array.from(helpers.filterActors(actors, "runs", "gt", 12), (actor) => actor.name), ["actor-b"]);
assert.deepEqual(Array.from(helpers.filterActors(actors, "monthlyRuns", "lte", 7), (actor) => actor.name), ["actor-a"]);
assert.deepEqual(Array.from(helpers.filterActors(actors, "users", "eq", 0), (actor) => actor.name), ["actor-c"]);
assert.deepEqual(Array.from(helpers.filterActors(actors, "bookmarks", "lt", 5), (actor) => actor.name), ["actor-a", "actor-c"]);
assert.deepEqual(Array.from(helpers.filterActors(actors, "runs", "gte", "not-a-number")), []);

console.log("Profile Actor sorting tests passed");
