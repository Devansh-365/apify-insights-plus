const assert = require("node:assert/strict");
const source = require("../scripts/refresh-builder-benchmark.js");

assert.equal(new URL(source.storePageUrl("newest", 2000)).searchParams.get("sortBy"), "newest");
assert.equal(new URL(source.storePageUrl("newest", 2000)).searchParams.get("limit"), "1000");
assert.equal(source.responseTotal({ data: { total: 123 } }), 123);
assert.equal(source.responsePageAdvance({ data: { count: 7 } }), 7);

const originalFetch = global.fetch;
global.fetch = async () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  async json() {
    return {
      data: {
        total: 1,
        count: 1,
        items: [{
          id: "actor-1",
          username: "builder-a",
          name: "example-actor",
          userFullName: "Builder A",
          stats: {
            totalUsers: 2,
            totalUsers30Days: 1,
            totalRuns: 10,
            publicActorRunStats30Days: { TOTAL: 3 },
          },
        }],
      },
    };
  },
});

(async () => {
  try {
    const snapshot = await source.buildSnapshot();
    assert.equal(snapshot.scan.distribution, "shared");
    assert.equal(snapshot.scan.pageCount, 4, "the shared scan uses every ranking sort once");
    assert.equal(snapshot.builders.length, 1);
    assert.equal(snapshot.builders[0].metrics.monthlyRuns, 3);
    assert.equal(snapshot.builders[0].metrics.totalRuns, 10);
    console.log("shared benchmark generator tests passed");
  } finally {
    global.fetch = originalFetch;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
