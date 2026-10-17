const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { self: {} };
vm.runInNewContext(fs.readFileSync("lib/profile-sort.js", "utf8"), context);
vm.runInNewContext(fs.readFileSync("lib/benchmark.js", "utf8"), context);
const profile = context.self.AAP_PROFILE_SORT;
const benchmark = context.self.AAP_BENCHMARK;

const actors = Array.from({ length: 350 }, (_, index) => ({
  id: `actor-${index}`,
  username: index < 200 ? "builder-a" : "builder-b",
  name: `actor-${index}`,
  userFullName: index < 200 ? "Builder A" : "Builder B",
  monthlyUsers: index % 5,
  totalUsers: index % 9,
  monthlyRuns: index < 200 ? 10 : 5,
  totalRuns: index + 1,
}));

const aggregate = benchmark.aggregateActors(actors);
assert.equal(aggregate.indexedActors, 350);
assert.equal(aggregate.builders.length, 2);
assert.equal(aggregate.builders.find((builder) => builder.key === "builder-a").actorCount, 200);
assert.equal(aggregate.builders.find((builder) => builder.key === "builder-b").actorCount, 150);

const monthlyRuns = benchmark.rankBuilders(aggregate.builders, "monthlyRuns");
assert.equal(monthlyRuns.rows[0].builder.key, "builder-a");
assert.equal(monthlyRuns.rows[0].rank, 1);
assert.equal(monthlyRuns.cohortSize, 2);

const tied = benchmark.rankBuilders([
  { key: "a", actorCount: 1, metrics: { monthlyRuns: 10 }, missing: {} },
  { key: "b", actorCount: 1, metrics: { monthlyRuns: 10 }, missing: {} },
  { key: "c", actorCount: 1, metrics: { monthlyRuns: 5 }, missing: {} },
], "monthlyRuns");
assert.deepEqual(tied.rows.map((row) => row.rank), [1, 1, 3], "ties use competition ranking");

const missing = benchmark.rankBuilders([
  { key: "complete", actorCount: 1, metrics: { monthlyRuns: 10 }, missing: {} },
  { key: "partial", actorCount: 2, metrics: { monthlyRuns: 10 }, missing: { monthlyRuns: 1 } },
], "monthlyRuns");
assert.equal(missing.cohortSize, 1, "partial metric data is excluded from the cohort");
assert.equal(missing.rows[0].builder.key, "complete");

const snapshot = benchmark.buildSnapshot({
  builders: aggregate.builders,
  capturedAt: "2026-10-17T00:00:00.000Z",
  actorFirstSeen: { "actor-0": "2026-10-01T00:00:00.000Z" },
  scan: { expectedActors: 350, indexedActors: 350, pageCount: 1, baseline: false },
});
assert.equal(benchmark.validateSnapshot(snapshot), true);
assert.equal(benchmark.validateSnapshot({ ...snapshot, schemaVersion: 999 }), false);

const builderRank = benchmark.rankForBuilder(snapshot.builders, "builder-a", "monthlyRuns");
const tag = benchmark.buildTagModel({ snapshot, result: builderRank, metricKey: "monthlyRuns" });
assert.equal(tag.label, "#1 · Monthly runs");
assert.match(tag.ariaLabel, /rank 1 of 2/);
assert.equal(benchmark.buildTagModel({ status: "scanning", metricKey: "monthlyRuns" }).label, "Scanning…");
assert.equal(benchmark.buildTagModel({ metricKey: "monthlyRuns" }).label, "Preparing…");
assert.equal(benchmark.buildTagModel({ status: "incomplete", metricKey: "monthlyRuns" }).label, "Scan incomplete");
assert.equal(benchmark.buildTagModel({ snapshot, result: builderRank, metricKey: "monthlyRuns", stale: true }).label, "#1 · Monthly runs · stale");

const previousSnapshot = benchmark.buildSnapshot({
  builders: [
    { key: "builder-a", actorCount: 1, metrics: { monthlyRuns: 5 }, missing: {} },
    { key: "builder-b", actorCount: 1, metrics: { monthlyRuns: 10 }, missing: {} },
  ],
  capturedAt: "2026-10-16T00:00:00.000Z",
  scan: { definitionVersion: 1 },
});
assert.equal(benchmark.sameCohort(snapshot, previousSnapshot, "monthlyRuns"), true);
assert.equal(benchmark.rankMovement(snapshot, previousSnapshot, "builder-a", "monthlyRuns"), 1);

const history = benchmark.aggregateActors([
  { id: "actor-0", username: "builder-a", monthlyRuns: 2 },
  { id: "actor-new", username: "builder-a", monthlyRuns: 3 },
], { previousFirstSeen: { "actor-0": "2026-10-01T00:00:00.000Z" } });
assert.equal(history.builders[0].metrics.newlyIndexedActors, 1);

const normalized = profile.normalizeStoreResponse({ data: { total: 1, items: [{ id: "actor-x", username: "builder-x", title: "Actor X", stats: { publicActorRunStats30Days: { TOTAL: 7 } } }] } });
assert.equal(benchmark.aggregateActors(normalized).builders[0].metrics.monthlyRuns, 7);

console.log("Builder Benchmark aggregation and ranking tests passed");
