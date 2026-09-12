const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { self: {} };
vm.runInNewContext(fs.readFileSync("lib/range.js", "utf8"), context);
const range = context.self.AAPR;

assert.deepEqual(Array.from(range.monthKeysBetween("2026-01-31", "2026-03-01")), [
  "2026-01-01",
  "2026-02-01",
  "2026-03-01",
]);
assert.deepEqual(Array.from(range.datesBetween("2026-02-27", "2026-03-01")), [
  "2026-02-27",
  "2026-02-28",
  "2026-03-01",
]);
assert.equal(range.isDate("2026-02-29"), false);
assert.equal(range.isDate("2026-02-28"), true);
assert.equal(range.isMonth("2026-02"), true);
assert.equal(range.isMonth("2026-2"), false);
assert.equal(range.monthEnd("2026-02"), "2026-02-28");

const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(`${today}T00:00:00Z`);
tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
const capped = range.aggregate([], today, tomorrow.toISOString().slice(0, 10));
assert.equal(capped.end, today);
assert.deepEqual(Array.from(capped.days), [today]);

const data = range.aggregate(
  [
    {
      margin: {
        dailyProfitMarginStats: {
          "2026-01-31": { payingUsersUsd: { revenueUsd: 10, costUsd: 2, profitUsd: 8, margin: 0.8 } },
        },
      },
      runs: { dailyStats: { "2026-01-31": { TOTAL: 3, RESULTS: 5, SUCCEEDED: 2, ABORTED: 1, FAILED: 0, "TIMED-OUT": 0 } } },
      users: { "2026-01-31": { freeUsers: 7, payingUsers: 4 } },
      costs: { dailyActorRunsCost: { "2026-01-31": 0.25 } },
      actorMargins: [{
        actorId: "actor-a",
        name: "Actor A",
        margin: { dailyProfitMarginStats: { "2026-01-31": { payingUsersUsd: { revenueUsd: 6, costUsd: 1, profitUsd: 5, margin: 5 / 6 } } } },
      }],
    },
    {
      margin: {
        dailyProfitMarginStats: {
          "2026-02-01": { payingUsersUsd: { revenueUsd: 20, costUsd: 5, profitUsd: 15, margin: 0.75 } },
        },
      },
      runs: { dailyStats: { "2026-02-01": { TOTAL: 4, RESULTS: 6, SUCCEEDED: 4, ABORTED: 0, FAILED: 0, "TIMED-OUT": 0 } } },
      users: { "2026-02-01": { freeUsers: 8, payingUsers: 5 } },
      costs: { dailyActorRunsCost: { "2026-02-01": 0.5 } },
      actorMargins: [{
        actorId: "actor-a",
        name: "Actor A",
        margin: { dailyProfitMarginStats: { "2026-02-01": { payingUsersUsd: { revenueUsd: 12, costUsd: 3, profitUsd: 9, margin: 0.75 } } } },
      }],
    },
  ],
  "2026-01-31",
  "2026-02-02",
);

assert.deepEqual(Array.from(data.days), ["2026-01-31", "2026-02-01", "2026-02-02"]);
assert.equal(data.totals.revenue, 30);
assert.equal(data.totals.cost, 7);
assert.equal(data.totals.profit, 23);
assert.equal(data.totals.runs, 7);
assert.equal(data.totals.results, 11);
assert.equal(data.totals.margin, 23 / 30);
assert.equal(data.daily["2026-01-31"].payingUsers, 4);
assert.equal(data.daily["2026-01-31"].succeeded, 2);
assert.equal(data.daily["2026-01-31"].aborted, 1);
assert.equal(data.daily["2026-01-31"].failed, 0);
assert.equal(data.daily["2026-01-31"].timedOut, 0);
assert.equal(data.daily["2026-02-01"].freeUsers, 8);
assert.equal(data.daily["2026-02-02"].runs, 0);
assert.equal(data.costsSummary.maximum, 0.5);
assert.equal(data.actorDaily["2026-01-31"][0].revenue, 6);
assert.equal(data.actorNames["actor-a"], "Actor A");

const weekly = range.group(data, "week");
assert.deepEqual(Array.from(weekly.days), ["2026-01-26", "2026-02-02"]);
assert.equal(weekly.daily["2026-01-26"].runs, 7);
assert.equal(weekly.daily["2026-01-26"].aborted, 1);
assert.equal(weekly.daily["2026-01-26"].payingUsers, 4.5);
assert.equal(weekly.daily["2026-01-26"].actorRevenue["actor-a"], 18);
assert.equal(weekly.runsSummary.average, 3.5);
assert.equal(weekly.runsSummary.minimum, 0);
assert.equal(weekly.runsSummary.maximum, 7);
assert.equal(weekly.resultsSummary.average, 5.5);
assert.equal(weekly.resultsSummary.maximum, 11);
assert.equal(weekly.costsSummary.maximum, (0.25 * 5 + 0.5 * 6) / 11);

const daily = range.group(data, "day");
assert.deepEqual(Array.from(daily.days), ["2026-01-31", "2026-02-01", "2026-02-02"]);
assert.equal(daily.daily["2026-01-31"].runs, 3);
assert.equal(daily.daily["2026-01-31"].actorRevenue["actor-a"], 6);

const monthly = range.group(data, "month");
assert.deepEqual(Array.from(monthly.days), ["2026-01-01", "2026-02-01"]);
assert.equal(monthly.daily["2026-02-01"].results, 6);
assert.equal(monthly.daily["2026-02-01"].actorRevenue["actor-a"], 12);
assert.equal(monthly.runsSummary.average, 3.5);
assert.equal(monthly.runsSummary.minimum, 3);
assert.equal(monthly.runsSummary.maximum, 4);
assert.equal(monthly.resultsSummary.average, 5.5);
assert.equal(monthly.costsSummary.minimum, 0.25);

console.log("range aggregation tests passed");
