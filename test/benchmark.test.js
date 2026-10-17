const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { self: {} };
vm.runInNewContext(fs.readFileSync("lib/profile-sort.js", "utf8"), context);
vm.runInNewContext(fs.readFileSync("lib/benchmark.js", "utf8"), context);
const profile = context.self.AAP_PROFILE_SORT;
const benchmark = context.self.AAP_BENCHMARK;

assert.equal(benchmark.SNAPSHOT_TTL_MS, 24 * 60 * 60 * 1000, "benchmark snapshots refresh daily");

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
const compactSnapshot = benchmark.compactSnapshot(snapshot);
assert.equal(Object.keys(compactSnapshot.actorFirstSeen).length, 0, "durable compact snapshots omit per-Actor history");
assert.equal(benchmark.validateSnapshot(compactSnapshot), true, "compact rank snapshots remain valid");
const minimalSnapshot = benchmark.minimalSnapshot(snapshot);
assert.equal(Object.keys(minimalSnapshot.actorFirstSeen).length, 0, "minimal rank snapshots omit per-Actor history");
assert.equal(benchmark.validateSnapshot(minimalSnapshot), true, "minimal rank snapshots remain valid");
const largeSnapshot = benchmark.buildSnapshot({
  builders: Array.from({ length: 8_521 }, (_, index) => ({
    key: `builder-${index}`,
    displayName: `Builder ${index}`,
    actorCount: 10,
    metrics: {
      totalActors: 10,
      monthlyUsers: index + 1,
      totalUsers: index + 2,
      monthlyRuns: index + 3,
      totalRuns: index + 4,
      newlyIndexedActors: 0,
    },
    missing: {},
  })),
  actorFirstSeen: Object.fromEntries(Array.from({ length: 90_317 }, (_, index) => [
    `actor-${index}`,
    "2026-10-17T00:00:00.000Z",
  ])),
  scan: { expectedActors: 90_317, indexedActors: 90_317 },
});
assert.ok(JSON.stringify(largeSnapshot).length > 2 * 1024 * 1024, "large scan snapshots reproduce the storage-limit case");
assert.ok(JSON.stringify(benchmark.compactSnapshot(largeSnapshot)).length < 2 * 1024 * 1024, "large rank snapshots fit the cache after compaction");
assert.equal(benchmark.validateSnapshot({ ...snapshot, schemaVersion: 999 }), false);
assert.equal(benchmark.validateSnapshot({ ...snapshot, schemaVersion: 2 }), false, "previous benchmark caches are invalidated");
assert.equal(benchmark.validateSnapshot({ ...snapshot, schemaVersion: 3 }), false, "local benchmark caches are invalidated after the rank-source change");
assert.equal(benchmark.validateSnapshot({ ...snapshot, schemaVersion: 4 }), false, "multi-sort benchmark caches are invalidated after the cohort-source change");
assert.equal(benchmark.validateSnapshot({ ...snapshot, schemaVersion: 1 }), false, "old benchmark caches are invalidated");

const observedSnapshot = benchmark.buildSnapshot({
  builders: aggregate.builders,
  capturedAt: "2026-10-17T00:00:00.000Z",
  scan: {
    expectedActors: 1000,
    indexedActors: 350,
    sourceTotal: 1000,
    sourceWindowEnded: true,
    coverage: "observed",
  },
});
assert.equal(observedSnapshot.scan.coverage, "observed");
assert.equal(observedSnapshot.scan.sourceTotal, 1000);
assert.equal(observedSnapshot.scan.sourceWindowEnded, true);

const builderRank = benchmark.rankForBuilder(snapshot.builders, "builder-a", "monthlyRuns");
const tag = benchmark.buildTagModel({ snapshot, result: builderRank, metricKey: "monthlyRuns" });
assert.equal(tag.label, "#1 · Monthly runs");
assert.match(tag.ariaLabel, /rank 1 of 2/);
assert.equal(benchmark.buildTagModel({ snapshot, result: builderRank, metricKey: "monthlyRuns", compact: true }).label, "#1");
assert.equal(benchmark.buildTagModel({ status: "scanning", metricKey: "monthlyRuns", compact: true }).label, "…");
assert.equal(benchmark.buildTagModel({ status: "scanning", metricKey: "monthlyRuns" }).label, "Scanning…");
assert.equal(benchmark.buildTagModel({ metricKey: "monthlyRuns" }).label, "Preparing…");
assert.equal(benchmark.buildTagModel({ status: "incomplete", metricKey: "monthlyRuns" }).label, "Scan incomplete");
assert.equal(benchmark.buildTagModel({ snapshot, result: builderRank, metricKey: "monthlyRuns", stale: true }).label, "#1 · Monthly runs · stale");
const observedTag = benchmark.buildTagModel({
  snapshot: observedSnapshot,
  result: benchmark.rankForBuilder(observedSnapshot.builders, "builder-a", "monthlyRuns"),
  metricKey: "monthlyRuns",
  compact: true,
});
assert.match(observedTag.ariaLabel, /local rank 1 of 2 local observed cohort/);
assert.match(observedTag.ariaLabel, /350 of 1,000 Actors observed/);

const replacedBuilders = benchmark.mergeBuilder(snapshot.builders, {
  key: "builder-a",
  actorCount: 999,
  metrics: { totalUsers: 999, monthlyUsers: 888, totalRuns: 777, monthlyRuns: 666 },
  missing: {},
});
assert.equal(replacedBuilders.filter((builder) => builder.key === "builder-a").length, 1);
assert.equal(benchmark.findBuilder(replacedBuilders, "builder-a").metrics.monthlyRuns, 666);
const addedBuilders = benchmark.mergeBuilder(snapshot.builders, {
  key: "builder-c",
  actorCount: 1,
  metrics: { totalUsers: 1, monthlyUsers: 1, totalRuns: 1, monthlyRuns: 1 },
  missing: {},
});
assert.ok(benchmark.findBuilder(addedBuilders, "builder-c"));

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

const completeActor = profile.normalizeStoreResponse({ data: { items: [{
  id: "actor-complete",
  username: "builder-complete",
  title: "Complete Actor",
  stats: {
    totalRuns: 12,
    totalUsers: 8,
    totalUsers30Days: 3,
    publicActorRunStats30Days: { TOTAL: 7 },
  },
}] } });
const completeSnapshot = benchmark.buildSnapshot({
  builders: benchmark.aggregateActors(completeActor).builders,
  capturedAt: "2026-10-17T00:00:00.000Z",
  scan: { indexedActors: 1, pageCount: 1 },
});
for (const metricKey of ["totalUsers", "monthlyUsers", "totalRuns", "monthlyRuns"]) {
  assert.ok(benchmark.rankForBuilder(completeSnapshot.builders, "builder-complete", metricKey).row, `${metricKey} should produce a rank`);
}

console.log("Builder Benchmark aggregation and ranking tests passed");
