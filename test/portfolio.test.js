const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { self: {} };
vm.runInNewContext(fs.readFileSync("lib/portfolio.js", "utf8"), context);
const model = context.self.AAP_PORTFOLIO_MODEL;

function item(id, { revenue = 0, cost = 0, paying = 0, free = 0, runs = 0, failed = 0, timedOut = 0, aborted = 0, results = 0, deprecated = false } = {}) {
  return {
    actor: { _id: id, title: `Actor ${id}`, name: id, username: "dev", isDeprecated: deprecated },
    earningsStats: { totalRevenueUsd: revenue, totalCostUsd: cost, totalProfitUsd: revenue - cost },
    usersStats: { payingUsers: paying, freeUsers: free },
    runsStats: { TOTAL: runs, SUCCEEDED: runs - failed - timedOut - aborted, FAILED: failed, "TIMED-OUT": timedOut, ABORTED: aborted, RESULTS: results },
    currentPricingInfo: {
      pricingModel: "PAY_PER_EVENT",
      pricingPerEvent: {
        actorChargeEvents: {
          "apify-actor-start": { isOneTimeEvent: true, eventPriceUsd: 0.00005 },
          "apify-default-dataset-item": {
            eventTitle: "job",
            isPrimaryEvent: true,
            eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.0015 }, GOLD: { tieredEventPriceUsd: 0.0011 } },
          },
        },
      },
    },
  };
}

// Normalization keeps the strategic fields and the primary event price.
const [normalized] = model.normalizeRows({ monetizationPerActor: [item("a", { revenue: 10, cost: 1, paying: 2, free: 3, runs: 20, failed: 1, timedOut: 1, aborted: 2, results: 400 })] });
assert.equal(normalized.profit, 9);
assert.equal(normalized.failed, 1);
assert.equal(normalized.timedOut, 1);
assert.equal(normalized.aborted, 2);
assert.deepEqual({ ...normalized.price }, { unit: "job", priceUsd: 0.0015 });
assert.equal(model.normalizeRows(null).length, 0);

assert.equal(model.previousMonthKey("2026-01-01"), "2025-12-01");
assert.equal(model.monthDays("2026-09-01", Date.UTC(2026, 9, 19)), 30);
assert.equal(model.monthDays("2026-10-01", Date.UTC(2026, 9, 11)), 10);

// Ten days into October against all of September (30 days). Portfolio
// profit pace is about $300/month, so materiality is $3/month.
const now = Date.UTC(2026, 9, 11);
const september = model.normalizeRows([
  item("star", { revenue: 150, cost: 5, paying: 5, free: 5, runs: 300, results: 9000 }),
  item("steady", { revenue: 60, cost: 2, paying: 3, free: 1, runs: 80, results: 900 }),
  item("fading", { revenue: 30, cost: 1, paying: 3, free: 0, runs: 30 }),
  item("noise", { revenue: 0.3, paying: 1, runs: 3 }),
  item("rising", { revenue: 3, cost: 0.1, paying: 1, free: 2, runs: 10 }),
]);
const october = model.normalizeRows([
  item("star", { revenue: 55, cost: 2, paying: 6, free: 4, runs: 100, results: 3000 }),
  item("steady", { revenue: 20, cost: 0.6, paying: 3, free: 1, runs: 25, results: 300 }),
  item("fading", { revenue: 2, cost: 0.1, paying: 1, free: 0, runs: 10 }),
  // +200% but only $0.60/month more: noise, not growth.
  item("noise", { revenue: 0.3, paying: 1, runs: 3 }),
  // $0.10/day -> $0.80/day, +$21/month, with more paying users.
  item("rising", { revenue: 8, cost: 0.3, paying: 3, free: 2, runs: 30 }),
  // 6 of 40 runs failed or timed out while users pay.
  item("flaky", { revenue: 5, cost: 0.2, paying: 2, free: 1, runs: 40, failed: 4, timedOut: 2 }),
  // Aborts alone are not a reliability problem.
  item("aborty", { revenue: 1, cost: 0.1, paying: 2, runs: 40, aborted: 10 }),
  // One failure in 3 runs is too little evidence.
  item("tiny", { revenue: 0.2, paying: 2, runs: 3, failed: 1 }),
  item("loser", { revenue: 0.5, cost: 2, paying: 1, free: 0, runs: 12 }),
  item("cents", { revenue: 0.01, cost: 0.02, paying: 1, runs: 1 }),
  item("freebie", { revenue: 0, cost: 0, paying: 0, free: 12, runs: 30 }),
  item("idle", { deprecated: true }),
]);

const single = model.analyze({ rowsByMonth: { "2026-10-01": october }, previousRows: september, now });
const byId = Object.fromEntries(single.rows.map((row) => [row.id, row]));
assert.equal(single.comparisonMonth, "2026-09-01");
assert.equal(single.thresholds.paceReady, true);
assert.ok(single.thresholds.materiality >= 1);

const has = (row, key) => model.hasAction(row, key);
const action = (row, key) => row.actions.find((item) => item.key === key);

assert.ok(has(byId.flaky, "fix"));
assert.ok(Math.abs(byId.flaky.failureRate - 0.15) < 1e-9);
assert.equal(action(byId.flaky, "fix").text, "6 failed (15.0%)");
assert.ok(!has(byId.aborty, "fix"));
assert.ok(!has(byId.tiny, "fix"));

assert.ok(has(byId.fading, "declining"));
assert.match(action(byId.fading, "declining").text, /^−\d+%\/day vs Sep$/);
assert.ok(byId.fading.notes.some((note) => note.text === "-2 paying users"));
assert.ok(!has(byId.noise, "growing"));
assert.ok(has(byId.rising, "growing"));
assert.ok(byId.rising.notes.some((note) => note.text === "+2 paying users"));
assert.ok(Math.abs(action(byId.rising, "growing").impact - ((0.8 - 0.1) * 30)) < 1e-9);

assert.ok(has(byId.loser, "reprice"));
// A one-cent loss is below the loss floor.
assert.ok(!has(byId.cents, "reprice"));
assert.ok(has(byId.freebie, "untapped"));
assert.equal(byId.idle.group, "idle");
assert.equal(byId.idle.actions.length, 0);
assert.ok(byId.idle.notes.some((note) => note.text === "Deprecated"));

// Core earners rank by profit and keep their group whatever their actions.
assert.ok(byId.star.isCore);
assert.equal(byId.star.group, "core");
assert.equal(byId.steady.group, "core");
assert.equal(byId.flaky.group, "tail");
// A core earner that starts failing stays a core earner, tagged "fix".
const failingCore = model.analyze({
  rowsByMonth: { "2026-10-01": october.map((row) => (row.id === "star" ? { ...row, failed: 10 } : row)) },
  previousRows: september,
  now,
}).rows.find((row) => row.id === "star");
assert.equal(failingCore.group, "core");
assert.ok(has(failingCore, "fix"));

// Every Actor has exactly one group; counts add up to all.
const groupTotal = model.GROUPS.reduce((sum, group) => sum + single.counts.groups[group.key], 0);
assert.equal(groupTotal, single.counts.all);
assert.equal(single.counts.actions.fix, single.rows.filter((row) => has(row, "fix")).length);
assert.equal(single.summary.coreCount, single.counts.groups.core);
assert.equal(
  single.summary.actionCount,
  single.rows.filter((row) => ["fix", "declining", "reprice"].some((key) => has(row, key))).length,
);

// Too early in the month: no pace, so nothing is growing or declining.
const early = model.analyze({ rowsByMonth: { "2026-10-01": october }, previousRows: september, now: Date.UTC(2026, 9, 4) });
assert.equal(early.thresholds.paceReady, false);
assert.equal(early.counts.actions.growing, 0);
assert.equal(early.counts.actions.declining, 0);

// While the comparison month loads, pace is marked as loading, not absent.
const loading = model.analyze({ rowsByMonth: { "2026-10-01": october }, paceLoading: true, now });
assert.equal(loading.thresholds.paceLoading, true);
assert.equal(loading.counts.actions.growing, 0);

// Tags hold until the Actor is clearly past the line. "edge" fails 4.5% of
// runs: not enough to start "Fix reliability", enough to keep it.
const edgeOctober = [...october, ...model.normalizeRows([item("edge", { revenue: 4, cost: 0.2, paying: 3, runs: 200, failed: 9 })])];
const fresh = model.analyze({ rowsByMonth: { "2026-10-01": edgeOctober }, previousRows: september, now });
const edgeFresh = fresh.rows.find((row) => row.id === "edge");
assert.ok(!has(edgeFresh, "fix"));
const held = model.analyze({
  rowsByMonth: { "2026-10-01": edgeOctober },
  previousRows: september,
  sticky: { day: "2026-10-10", pace: true, actors: { edge: ["tail", "fix"] } },
  now,
});
assert.ok(has(held.rows.find((row) => row.id === "edge"), "fix"));
// Under 4% the tag goes.
const recovered = model.analyze({
  rowsByMonth: { "2026-10-01": edgeOctober.map((row) => (row.id === "edge" ? { ...row, failed: 7 } : row)) },
  previousRows: september,
  sticky: { day: "2026-10-10", pace: true, actors: { edge: ["tail", "fix"] } },
  now,
});
assert.ok(!has(recovered.rows.find((row) => row.id === "edge"), "fix"));

// A core earner from the last snapshot stays core within the top 85% of
// profit; without the snapshot the 80% line decides.
const coreRows = model.normalizeRows([
  item("big", { revenue: 70, paying: 5, runs: 10 }),
  item("mid", { revenue: 12, paying: 3, runs: 10 }),
  item("small", { revenue: 8, paying: 2, runs: 10 }),
  item("tiny2", { revenue: 10, paying: 2, runs: 10 }),
]);
// Profit: big 70 + mid 12 reach 80%; tiny2 (10) brings it to 92%.
const coreFresh = model.analyze({ rowsByMonth: { "2026-10-01": coreRows }, now });
assert.equal(coreFresh.rows.find((row) => row.id === "tiny2").group, "tail");
const coreHeld = model.analyze({
  rowsByMonth: { "2026-10-01": coreRows },
  sticky: { day: "2026-10-10", pace: false, actors: { tiny2: ["core"], small: ["core"] } },
  now,
});
assert.equal(coreHeld.rows.find((row) => row.id === "tiny2").group, "core");
// Past the 85% line a former core earner drops to the long tail.
assert.equal(coreHeld.rows.find((row) => row.id === "small").group, "tail");

// Snapshots round-trip, and compareSnapshot marks what changed since.
const snap = model.snapshot(single, "2026-10-10");
assert.equal(snap.day, "2026-10-10");
assert.equal(snap.pace, true);
// flaky is new this month: failing and earning for the first time, which
// one category used to hide behind "fix".
assert.deepEqual([...snap.actors.flaky], ["tail", "fix", "growing"]);
assert.equal(model.compareSnapshot(model.analyze({ rowsByMonth: { "2026-10-01": october }, previousRows: september, now }), snap).changes.count, 0);
const moved = model.compareSnapshot(failingCoreAnalysis(), snap);
const movedStar = moved.rows.find((row) => row.id === "star");
assert.deepEqual([...movedStar.change.added], ["fix"]);
assert.equal(movedStar.change.group, null);
assert.equal(moved.changes.since, "2026-10-10");
assert.ok(moved.changes.count >= 1);
// A group change names the old group.
const demoted = model.compareSnapshot(single, { day: "2026-10-09", pace: true, actors: { ...snap.actors, flaky: ["core", "fix"] } });
assert.equal(demoted.rows.find((row) => row.id === "flaky").change.group, "core");
// Without pace on both sides, growing and declining are not compared.
const noPace = model.compareSnapshot(single, { day: "2026-10-09", pace: false, actors: { ...snap.actors, rising: ["tail"] } });
assert.equal(noPace.rows.find((row) => row.id === "rising").change, null);
const withPace = model.compareSnapshot(single, { day: "2026-10-09", pace: true, actors: { ...snap.actors, rising: ["tail"] } });
assert.deepEqual([...withPace.rows.find((row) => row.id === "rising").change.added], ["growing"]);
// Nothing to compare against: no changes.
assert.equal(model.compareSnapshot(single, null).changes, null);

function failingCoreAnalysis() {
  return model.analyze({
    rowsByMonth: { "2026-10-01": october.map((row) => (row.id === "star" ? { ...row, failed: 10 } : row)) },
    previousRows: september,
    now,
  });
}

// Without comparison data there is no pace.
const noComparison = model.analyze({ rowsByMonth: { "2026-10-01": october }, now });
assert.equal(noComparison.comparisonMonth, null);
assert.equal(noComparison.counts.actions.growing, 0);

// A two-month range sums money and runs, keeps peak monthly users, and uses
// the in-range previous month for pace instead of an extra request.
const range = model.analyze({ rowsByMonth: { "2026-09-01": september, "2026-10-01": october }, now });
const rangeStar = range.rows.find((row) => row.id === "star");
assert.equal(range.comparisonMonth, "2026-09-01");
assert.equal(rangeStar.revenue, 205);
assert.equal(rangeStar.runs, 400);
assert.equal(rangeStar.payingUsers, 6);
assert.equal(rangeStar.freeUsers, 5);

// Duplicate Actor entries within one month are merged, not summed.
const duplicated = model.normalizeRows([
  item("dup", { revenue: 10, cost: 1, paying: 2, runs: 5 }),
  item("dup", { revenue: 0, cost: 0, paying: 0, runs: 0 }),
]);
assert.equal(duplicated.length, 1);
assert.equal(duplicated[0].revenue, 10);
assert.equal(duplicated[0].runs, 5);

// Pager buttons: every page when there are few, else the ends, the current
// page and its neighbours, with null for skipped pages.
const pages = (page, pageCount) => JSON.stringify(model.pageButtons(page, pageCount));
assert.equal(pages(0, 1), "[0]");
assert.equal(pages(3, 7), "[0,1,2,3,4,5,6]");
assert.equal(pages(0, 18), "[0,1,2,3,null,17]");
assert.equal(pages(2, 18), "[0,1,2,3,null,17]");
assert.equal(pages(8, 18), "[0,null,7,8,9,null,17]");
assert.equal(pages(17, 18), "[0,null,14,15,16,17]");
assert.equal(pages(15, 18), "[0,null,14,15,16,17]");

console.log("Actor portfolio analysis tests passed");
