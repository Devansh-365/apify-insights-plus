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

assert.equal(byId.flaky.primary, "fix");
assert.ok(Math.abs(byId.flaky.failureRate - 0.15) < 1e-9);
assert.notEqual(byId.aborty.primary, "fix");
assert.notEqual(byId.tiny.primary, "fix");

assert.equal(byId.fading.primary, "declining");
assert.ok(byId.fading.signals.some((signal) => signal.text === "-2 paying users"));
assert.notEqual(byId.noise.primary, "growing");
assert.equal(byId.rising.primary, "growing");
assert.ok(byId.rising.signals.some((signal) => signal.text === "+2 paying users"));
assert.ok(Math.abs(byId.rising.impact - ((0.8 - 0.1) * 30)) < 1e-9);

assert.equal(byId.loser.primary, "reprice");
// A one-cent loss is below the loss floor.
assert.notEqual(byId.cents.primary, "reprice");
assert.equal(byId.freebie.primary, "untapped");
assert.equal(byId.idle.primary, "idle");
assert.ok(byId.idle.signals.some((signal) => signal.text === "Deprecated"));

// Core earners rank by profit and only take the primary slot when nothing more
// urgent applies, but always carry the context chip.
// star goes from $5/day to $5.50/day (+10%), below the growth bar.
assert.ok(byId.star.isCore);
assert.equal(byId.star.primary, "core");
assert.ok(byId.star.signals.some((signal) => signal.text.startsWith("Core")));
assert.equal(byId.steady.primary, "core");
// A core earner that is also failing is shown as "fix", keeping the core chip.
const failingCore = model.analyze({
  rowsByMonth: { "2026-10-01": october.map((row) => (row.id === "star" ? { ...row, failed: 10 } : row)) },
  previousRows: september,
  now,
}).rows.find((row) => row.id === "star");
assert.equal(failingCore.primary, "fix");
assert.ok(failingCore.signals.some((signal) => signal.text.startsWith("Core")));

// Every Actor has exactly one primary segment.
const segmentTotal = model.SEGMENTS.reduce((sum, segment) => sum + single.counts[segment.key], 0);
assert.equal(segmentTotal, single.counts.all);
assert.equal(single.summary.actionCount, single.counts.fix + single.counts.declining + single.counts.reprice);

// Too early in the month: no pace, so nothing is growing or declining.
const early = model.analyze({ rowsByMonth: { "2026-10-01": october }, previousRows: september, now: Date.UTC(2026, 9, 4) });
assert.equal(early.thresholds.paceReady, false);
assert.equal(early.counts.growing, 0);
assert.equal(early.counts.declining, 0);

// A two-month range sums money and runs, keeps peak monthly users, and uses
// the in-range previous month for pace instead of an extra request.
const range = model.analyze({ rowsByMonth: { "2026-09-01": september, "2026-10-01": october }, now });
const rangeStar = range.rows.find((row) => row.id === "star");
assert.equal(range.comparisonMonth, "2026-09-01");
assert.equal(rangeStar.revenue, 205);
assert.equal(rangeStar.runs, 400);
assert.equal(rangeStar.payingUsers, 6);
assert.equal(rangeStar.freeUsers, 5);

// Without comparison data there is no pace.
const noComparison = model.analyze({ rowsByMonth: { "2026-10-01": october }, now });
assert.equal(noComparison.comparisonMonth, null);
assert.equal(noComparison.counts.growing, 0);

console.log("Actor portfolio analysis tests passed");
