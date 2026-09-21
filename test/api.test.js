const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

class SimpleEvent {
  constructor(type) { this.type = type; }
}

class SimpleCustomEvent extends SimpleEvent {
  constructor(type, init = {}) {
    super(type);
    this.detail = init.detail;
  }
}

const listeners = new Map();
const requests = [];
let requestNumber = 0;
const window = {
  addEventListener(type, listener) {
    (listeners.get(type) || listeners.set(type, []).get(type)).push(listener);
  },
  dispatchEvent(event) {
    for (const listener of listeners.get(event.type) || []) listener(event);
    return true;
  },
};

const context = {
  self: { AAP_CONTEXT: { organizationKey: () => "org-acme" } },
  window,
  Event: SimpleEvent,
  CustomEvent: SimpleCustomEvent,
  URL,
  URLSearchParams,
  crypto: { randomUUID: () => `request-${++requestNumber}` },
  setTimeout,
  clearTimeout,
  console,
  AAP_CACHE: {
    async getApi() { return { hit: false }; },
    async setApi() {},
  },
  AAPR: {
    isMonth: () => false,
    monthStart: (value) => value,
    monthEnd: (value) => value,
    monthKeysBetween: () => ["2026-01-01", "2026-02-01"],
    aggregate: (months, start, end) => ({ months, start, end }),
  },
};

function responseFor(url) {
  const path = url.pathname.replace(/^\/actor-analytics\//, "");
  const month = url.searchParams.get("month");
  const actorIds = url.searchParams.get("actorIds") || "";
  if (path === "actor-breakdown") {
    return {
      monetizationPerActor: month === "2026-01-01"
        ? [
          { actor: { _id: "actor-a", title: "Actor A" }, earningsStats: { totalRevenueUsd: 10, totalCostUsd: 2 } },
          { actor: { _id: "actor-a", title: "Actor A" }, earningsStats: { totalRevenueUsd: 0, totalCostUsd: 0 } },
          { actor: { _id: "actor-b", title: "Actor B" }, earningsStats: { totalRevenueUsd: 0, totalCostUsd: 0 } },
        ]
        : [{ actor: { _id: "actor-a", title: "Actor A" }, earningsStats: { totalRevenueUsd: 2, totalCostUsd: 1 } }],
    };
  }
  if (path === "profit-margin" || path === "run-statistics/monthly/all-users") {
    return actorIds ? {} : { dailyProfitMarginStats: {}, dailyStats: {} };
  }
  return {};
}

window.addEventListener("aap-api-request", (event) => {
  const url = new URL(event.detail.url);
  requests.push(url);
  const shouldFail = url.pathname.endsWith("/profit-margin")
    && url.searchParams.get("actorIds") === "actor-b";
  setTimeout(() => window.dispatchEvent(new SimpleCustomEvent("aap-api-response", {
    detail: shouldFail
      ? { id: event.detail.id, error: "Actor request failed" }
      : { id: event.detail.id, data: responseFor(url) },
  })), 0);
});

vm.runInNewContext(fs.readFileSync("lib/api.js", "utf8"), context);
window.dispatchEvent(new SimpleCustomEvent("aap-auth-scope", { detail: "account-test" }));

(async () => {
  const pooled = context.self.AAP_API.pooled;
  const pooledResults = await pooled([{ id: "ok" }, { id: "bad" }], async (item) => {
    if (item.id === "bad") throw new Error("temporary failure");
    return item.id;
  });
  assert.deepEqual([...pooledResults], ["ok", null]);
  assert.equal(pooledResults.failures.length, 1);
  assert.equal(pooledResults.failures[0].item.id, "bad");

  const range = await context.self.AAP_API.rangeData("2026-01-01", "2026-02-02", []);
  assert.equal(range.months.length, 2);
  assert.equal(requests.filter((url) => url.searchParams.has("actorIds")).length, 0, "rangeData must not fetch Actor detail rows");
  assert.deepEqual(Array.from(range.actorCatalogByMonth["2026-01-01"].map((actor) => actor.actorId)), ["actor-a", "actor-b"]);
  assert.deepEqual(Array.from(range.actorCatalogByMonth["2026-01-01"][0].activeMonths), ["2026-01-01"]);
  assert.equal(range.actorCatalog.find((actor) => actor.actorId === "actor-a").totalRevenueUsd, 12);
  assert.deepEqual(Array.from(range.actorCatalog.find((actor) => actor.actorId === "actor-b").activeMonths), ["2026-01-01"]);

  const beforeDetails = requests.length;
  const details = await Promise.all([
    context.self.AAP_API.actorDailyData("2026-01-01", "actor-a"),
    context.self.AAP_API.actorDailyData("2026-01-01", "actor-a"),
  ]);
  const detailRequests = requests.slice(beforeDetails).filter((url) => url.searchParams.get("actorIds") === "actor-a");
  assert.equal(detailRequests.length, 2, "identical concurrent Actor detail requests should be deduplicated");
  assert.equal(details[0].actorId, "actor-a");
  assert.equal(details[1].margin, details[0].margin);
  console.log("API pooling, deduplication, and lazy range request tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
