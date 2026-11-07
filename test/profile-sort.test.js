const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { self: {} };
vm.runInNewContext(fs.readFileSync("lib/profile-sort.js", "utf8"), context);
const helpers = context.self.AAP_PROFILE_SORT;

assert.deepEqual(Array.from(helpers.RANK_METRIC_KEYS), ["totalUsers", "monthlyUsers", "totalRuns", "monthlyRuns"]);

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
assert.equal(actors[0].monthlyUsers, 3);
assert.equal(actors[0].monthlyRuns, 7);
assert.equal(actors[0].totalRuns, 12);
assert.equal(actors[0].totalUsers, 8);
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

// "Recently updated" keeps the Store's lastUpdate order (the catalog index),
// fetched as its own catalog.
assert.deepEqual(Array.from(helpers.sortActors(actors, "updated"), (actor) => actor.name), ["actor-a", "actor-b", "actor-c", "actor-d"]);
assert.deepEqual(Array.from(helpers.sortActors(actors, "updated", "asc"), (actor) => actor.name), ["actor-d", "actor-c", "actor-b", "actor-a"]);
assert.equal(helpers.optionLabel("updated"), "Recently updated");
assert.equal(helpers.catalogOrder("updated"), "updated");
assert.equal(helpers.catalogOrder("newest"), "newest");
assert.equal(helpers.catalogOrder("runs"), "default");
assert.equal(helpers.storeSortFor("updated"), "lastUpdate");
assert.equal(helpers.storeSortFor("default"), undefined);
assert.deepEqual(Array.from(helpers.orderLabels("updated")), ["Latest update first", "Oldest update first"]);
assert.equal(helpers.orderLabels("runs"), null);

assert.deepEqual(Array.from(helpers.filterActors(actors, "mau", "gte", 2), (actor) => actor.name), ["actor-a"]);
assert.deepEqual(Array.from(helpers.filterActors(actors, "runs", "gt", 12), (actor) => actor.name), ["actor-b"]);
assert.deepEqual(Array.from(helpers.filterActors(actors, "monthlyRuns", "lte", 7), (actor) => actor.name), ["actor-a"]);
assert.deepEqual(Array.from(helpers.filterActors(actors, "users", "eq", 0), (actor) => actor.name), ["actor-c"]);
assert.deepEqual(Array.from(helpers.filterActors(actors, "bookmarks", "lt", 5), (actor) => actor.name), ["actor-a", "actor-c"]);
assert.deepEqual(Array.from(helpers.filterActors(actors, "runs", "gte", "not-a-number")), []);

// Quick views. Fields are the normalized Actor shape.
const viewActor = (name, fields) => ({ name, title: name, users: 0, users7: 0, mau: 0, users90: 0, ...fields });
const viewSample = [
  // Last 30 days at 30 of a 90-day 150 (average month at least 50): -40%.
  viewActor("monthly-drop", { users: 400, users90: 150, mau: 30, users7: 7 }),
  // Steady month, but 1 user in 7 days against an expected 7: a weekly drop.
  viewActor("weekly-drop", { users: 400, users90: 60, mau: 30, users7: 1 }),
  viewActor("steady", { users: 400, users90: 60, mau: 30, users7: 9 }),
  // Every user arrived within 90 days, so it is a launch, not a drop.
  viewActor("launch", { users: 40, users90: 40, mau: 5, users7: 0 }),
  // Too few users for either comparison to mean anything.
  viewActor("tiny", { users: 12, users90: 12 - 1, mau: 1, users7: 0 }),
  viewActor("dormant", { users: 90, users90: 4, mau: 0, users7: 0 }),
  viewActor("maintenance", { users: 50, users90: 20, mau: 10, users7: 3, notice: "UNDER_MAINTENANCE" }),
  viewActor("low-rated", { users: 50, users90: 20, mau: 8, users7: 2, actorReviewRating: 3.4, actorReviewCount: 5 }),
  viewActor("few-reviews", { users: 50, users90: 20, mau: 8, users7: 2, actorReviewRating: 2, actorReviewCount: 2 }),
];
const viewNames = (key) => Array.from(helpers.viewActors(viewSample, key), (actor) => actor.name);
assert.deepEqual(viewNames("losing"), ["monthly-drop", "weekly-drop"]);
assert.deepEqual(viewNames("new"), ["launch"]);
assert.deepEqual(viewNames("inactive"), ["dormant"]);
assert.deepEqual(viewNames("fix"), ["maintenance", "low-rated"], "a rating needs 3+ reviews to count");
assert.equal(viewNames("all").length, viewSample.length);
assert.equal(helpers.viewCounts(viewSample).losing, 2);
const monthlyDrop = helpers.userDrop(viewSample[0]);
assert.equal(monthlyDrop.window, "30 days");
assert.equal(Math.round(monthlyDrop.change * 100), -40);
assert.equal(helpers.userDrop(viewSample[1]).window, "7 days");
assert.equal(helpers.userDrop(viewSample[3]), null, "launches have no past to drop from");
assert.equal(helpers.viewFor("unknown").key, "all");
assert.equal(helpers.normalizeActor({ stats: { totalUsers7Days: 3, totalUsers90Days: 9 } }).users90, 9);
const shareSample = Array.from({ length: 12 }, (_, index) => ({ mau: index < 10 ? 10 : 50 }));
assert.equal(helpers.topShare(shareSample), (2 * 50 + 8 * 10) / 200);
assert.equal(helpers.topShare(shareSample.slice(0, 5)), null, "no share line when every Actor is in the top 10");

// The profile page's embedded data, escaped as it sits inside a script string.
const profilePayload = String.raw`self.__next_f.push([1,"22:[[\"$\",\"$L6d\",null,{\"user\":{\"_id\":\"R6H\",\"username\":\"Builder-Name\",\"profile\":{\"bio\":\"Scrapers\",\"githubUsername\":null},\"dnsFriendlyUsername\":\"builder-name\",\"stats\":{\"activeUsers30Days\":2194,\"runSuccessRate\":0.988},\"createdAt\":\"2022-10-18T05:50:12.185Z\"},\"actorsCount\":464,\"actorsTotalUsers\":6553,\"actors\":[{\"name\":\"a\",\"stats\":{\"totalUsers\":6000},\"username\":\"builder-name\"}]}]]"])`;
assert.deepEqual({ ...helpers.parseDeveloperUserStats(profilePayload, "builder-name") }, { totalUsers: 6553, monthlyUsers: 2194 });
assert.equal(helpers.parseDeveloperUserStats(profilePayload, "someone-else"), null, "another profile's data is ignored");
assert.equal(helpers.parseDeveloperUserStats("<html></html>", "builder-name"), null);
assert.deepEqual(
  { ...helpers.parseDeveloperUserStats(profilePayload.replace(/\\"activeUsers30Days\\":2194,/, ""), "builder-name") },
  { totalUsers: 6553, monthlyUsers: null },
  "a missing monthly count leaves Apify's rounded value",
);

console.log("Profile Actor sorting tests passed");
