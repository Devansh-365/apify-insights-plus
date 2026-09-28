const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { self: {} };
vm.runInNewContext(fs.readFileSync("lib/actor-detail.js", "utf8"), context);

const normalized = context.self.AAP_ACTOR_DETAIL.normalize({
  data: {
    id: "actor-123",
    name: "example-actor",
    username: "example-user",
    title: "Example Actor",
    createdAt: "2026-01-02T03:04:05.000Z",
    pricingInfos: [
      { createdAt: "2026-02-01T00:00:00.000Z" },
      { createdAt: "2026-03-01T00:00:00.000Z" },
    ],
    stats: {
      totalUsers30Days: 12,
      publicActorRunStats30Days: {
        SUCCEEDED: 18,
        FAILED: 2,
        ABORTED: 1,
        "TIMED-OUT": 1,
        TOTAL: 22,
      },
      publicActorDailyRunStats30Days: {
        "2026-03-01": 4,
        "2026-03-02": { TOTAL: 2 },
      },
      lastRunStartedAt: "2026-03-10T12:00:00.000Z",
    },
  },
});

assert.equal(normalized.title, "Example Actor");
assert.equal(normalized.activeUsers30Days, 12);
assert.equal(normalized.runs30Days, 22);
assert.equal(normalized.pricingUpdatedAt, "2026-03-01T00:00:00.000Z");
assert.equal(normalized.lastRunAt, "2026-03-10T12:00:00.000Z");
assert.equal(normalized.runStats.SUCCEEDED, 18);
assert.equal(normalized.runStats.FAILED, 2);
assert.equal(normalized.runStats.ABORTED, 1);
assert.equal(normalized.runStats["TIMED-OUT"], 1);
assert.deepEqual(JSON.parse(JSON.stringify(normalized.dailyRuns)), [
  { date: "2026-03-01", runs: 4 },
  { date: "2026-03-02", runs: 2 },
]);

const fallback = context.self.AAP_ACTOR_DETAIL.normalize({
  stats: { publicActorRunStats30Days: { SUCCEEDED: 2, FAILED: 1, TIMED_OUT: 1 } },
});
assert.equal(fallback.runs30Days, 4);
assert.equal(fallback.runStats["TIMED-OUT"], 1);
assert.deepEqual(JSON.parse(JSON.stringify(fallback.dailyRuns)), []);

console.log("Actor detail normalization tests passed");
