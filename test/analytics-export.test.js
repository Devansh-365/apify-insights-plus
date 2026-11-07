const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { self: {} };
vm.runInNewContext(fs.readFileSync("lib/range.js", "utf8"), context);
vm.runInNewContext(fs.readFileSync("lib/analytics-export.js", "utf8"), context);
const helpers = context.self.AAP_ANALYTICS_EXPORT;

assert.deepEqual(Array.from(helpers.exportMonths("2025-11", "2026-02")), ["2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01"]);
assert.equal(helpers.fileName("2026-10", "2026-10"), "2026-10-01_analytics.json", "one month keeps Apify's file name");
assert.equal(helpers.fileName("2026-05", "2026-10"), "2026-05-01_to_2026-10_analytics.json");

const margin = (cost, revenue) => ({ costUsd: cost, revenueUsd: revenue, profitUsd: revenue - cost, margin: (revenue - cost) / revenue });
const breakdownRow = (actorId, actorName, revenue, paying, results) => ({
  actorId,
  actorName,
  actorPricingModel: "PAY_PER_EVENT",
  profitStats: { totalRevenueUsd: revenue, totalCostUsd: revenue / 10, totalProfitUsd: revenue * 0.9 },
  usersStats: { freeUsers: 1, payingUsers: paying },
  numChargedResults: results,
});
// The shape of Apify's monthly export, as the Console's Export button saves it.
const september = {
  actorIds: ["a", "b", "gone"],
  dateFromInclusive: "2026-09-01T00:00:00.000Z",
  dateToExclusive: "2026-10-01T00:00:00.000Z",
  marketingData: { numUniqueConsolePageViews: 4, numUniqueUsersWithRun: 2, numUniqueViewingUsers: 5, numUniqueWebPageViews: 9 },
  actorBreakdown: [breakdownRow("a", "me/a-old-name", 10, 2, 100), breakdownRow("gone", "me/gone", 1, 1, 5)],
  costPerThousandResults: {
    dailyActorRunsCostPerThousandResults: { "2026-09-30": 0.2, "2026-09-29": 0.4 },
    totalActorRunsCostPerThousandResults: { maxActorRunsCost: 0.4, minActorRunsCost: 0.2, avgActorRunsCost: 0.3 },
  },
  runStats: {
    dailyStats: {
      "2026-09-30": { SUCCEEDED: 9, FAILED: 1, TOTAL: 10, RESULTS: 100 },
      "2026-09-29": { SUCCEEDED: 2, TOTAL: 2, RESULTS: 300 },
    },
    runsSummary: { min: 2, max: 10, avg: 6 },
    resultsSummary: { min: 100, max: 300, avg: 200 },
  },
  profitMargin: {
    totalProfitMarginStats: { payingUsersUsd: margin(1, 10), allUsersUsd: margin(2, 20) },
    dailyProfitMarginStats: { "2026-09-30": { payingUsersUsd: margin(1, 10), allUsersUsd: margin(2, 20) } },
  },
  userStats: { "2026-09-30": { freeUsers: 3, payingUsers: 1 } },
};
const october = {
  actorIds: ["b", "a"],
  dateFromInclusive: "2026-10-01T00:00:00.000Z",
  dateToExclusive: "2026-11-01T00:00:00.000Z",
  marketingData: { numUniqueConsolePageViews: 1, numUniqueUsersWithRun: 1, numUniqueViewingUsers: 2, numUniqueWebPageViews: 3 },
  actorBreakdown: [breakdownRow("b", "me/b", 5, 1, 50), breakdownRow("a", "me/a", 30, 3, 200)],
  costPerThousandResults: {
    dailyActorRunsCostPerThousandResults: { "2026-10-01": 0.1 },
    totalActorRunsCostPerThousandResults: { maxActorRunsCost: 0.1, minActorRunsCost: 0.1, avgActorRunsCost: 0.1 },
  },
  runStats: {
    dailyStats: { "2026-10-01": { SUCCEEDED: 4, TOTAL: 4, RESULTS: 200 } },
    runsSummary: { min: 4, max: 4, avg: 4 },
    resultsSummary: { min: 200, max: 200, avg: 200 },
  },
  profitMargin: {
    totalProfitMarginStats: { payingUsersUsd: margin(3, 30), allUsersUsd: margin(4, 40) },
    dailyProfitMarginStats: { "2026-10-01": { payingUsersUsd: margin(3, 30), allUsersUsd: margin(4, 40) } },
  },
  // Apify lists the rest of the current month as empty user-stat days.
  userStats: { "2026-10-01": { freeUsers: 5, payingUsers: 2 }, "2026-10-02": { freeUsers: 0, payingUsers: 0 } },
};
const today = "2026-10-01";

const single = helpers.merge([{ month: "2026-10-01", data: october, marketing: { numUniqueViewingUsers: 40, topReferrers: [] } }], { today });
assert.equal(single.actorBreakdown, october.actorBreakdown, "one month keeps Apify's figures");
assert.equal(single.marketingData.numUniqueViewingUsers, 40, "marketing counts come from the monthly marketing statistics");
assert.equal(single.marketingData.numUniqueWebPageViews, 3, "a count the statistics lack keeps Apify's value");
assert.equal("topReferrers" in single.marketingData, false, "only Apify's marketing fields are copied");
assert.deepEqual(Object.keys(single.userStats), ["2026-10-01"], "days after today are left out");
assert.equal(Object.keys(october.userStats).length, 2, "Apify's file is not modified");
assert.match(single.notes[0], /monthly marketing statistics/);
assert.throws(() => helpers.merge([]), /No months/);

const merged = helpers.merge(
  [
    { month: "2026-09-01", data: september, marketing: { numUniqueConsolePageViews: 10, numUniqueUsersWithRun: 6, numUniqueViewingUsers: 30, numUniqueWebPageViews: 50 } },
    { month: "2026-10-01", data: october, marketing: null },
  ],
  { exportedAt: "2026-11-07T00:00:00.000Z", today },
);
assert.deepEqual(
  Object.keys(merged).slice(0, 9),
  ["actorIds", "dateFromInclusive", "dateToExclusive", "marketingData", "actorBreakdown", "costPerThousandResults", "runStats", "profitMargin", "userStats"],
  "Apify's fields come first, in Apify's order",
);
assert.deepEqual(Array.from(merged.actorIds), ["b", "a", "gone"], "newest month's order, then Actors only older months had");
assert.equal(merged.dateFromInclusive, "2026-09-01T00:00:00.000Z");
assert.equal(merged.dateToExclusive, "2026-11-01T00:00:00.000Z");
assert.equal(merged.marketingData.numUniqueViewingUsers, 32, "September's statistics plus October's export value");
assert.ok(merged.notes.some((note) => note.includes("kept for 2026-10")), "the notes name the month without statistics");

assert.deepEqual(Array.from(merged.actorBreakdown, (row) => row.actorId), ["b", "a", "gone"]);
const actorA = merged.actorBreakdown[1];
assert.equal(actorA.actorName, "me/a", "the newest name wins");
assert.equal(actorA.profitStats.totalRevenueUsd, 40);
assert.equal(actorA.usersStats.payingUsers, 5);
assert.equal(actorA.numChargedResults, 300);

assert.deepEqual(Object.keys(merged.runStats.dailyStats), ["2026-09-29", "2026-09-30", "2026-10-01"], "days are in date order");
assert.deepEqual({ ...merged.runStats.runsSummary }, { min: 2, max: 10, avg: 16 / 3 });
assert.deepEqual({ ...merged.runStats.resultsSummary }, { min: 100, max: 300, avg: 200 });
assert.deepEqual(Object.keys(merged.userStats), ["2026-09-30", "2026-10-01"]);
assert.equal(Object.keys(merged.profitMargin.dailyProfitMarginStats).length, 2);

const paying = merged.profitMargin.totalProfitMarginStats.payingUsersUsd;
assert.equal(paying.revenueUsd, 40);
assert.equal(paying.costUsd, 4);
assert.equal(paying.margin, 36 / 40);
assert.equal(merged.profitMargin.totalProfitMarginStats.allUsersUsd.revenueUsd, 60);

const cost = merged.costPerThousandResults;
assert.equal(Object.keys(cost.dailyActorRunsCostPerThousandResults).length, 3);
assert.equal(cost.totalActorRunsCostPerThousandResults.maxActorRunsCost, 0.4);
assert.equal(cost.totalActorRunsCostPerThousandResults.minActorRunsCost, 0.1);
// September: avg 0.3 over 400 results; October: avg 0.1 over 200 results.
assert.equal(cost.totalActorRunsCostPerThousandResults.avgActorRunsCost, (0.3 * 400 + 0.1 * 200) / 600);

assert.deepEqual(Array.from(merged.months, (month) => month.month), ["2026-09", "2026-10"]);
assert.equal(merged.months[0].actorBreakdown, september.actorBreakdown, "each month's exact figures are kept");
assert.equal(merged.months[1].marketingData.numUniqueViewingUsers, 2);
assert.equal(merged.exportedAt, "2026-11-07T00:00:00.000Z");
assert.ok(merged.notes.length > 0);

console.log("Analytics export tests passed");
