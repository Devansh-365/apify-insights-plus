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
  const actorRequests = requests.filter((url) => url.searchParams.has("actorIds"));
  assert.equal(actorRequests.filter((url) => url.searchParams.get("actorIds") === "actor-a").length, 4);
  assert.equal(actorRequests.filter((url) => url.searchParams.get("actorIds") === "actor-b").length, 2);
  assert.equal(actorRequests.some((url) => url.searchParams.get("actorIds") === "actor-b" && url.searchParams.get("month") === "2026-02-01"), false);
  assert.equal(range.partial.failedCount, 1);
  assert.equal(range.partial.failedActors.length, 1);
  assert.equal(range.partial.failedActors[0].actorId, "actor-b");
  assert.equal(range.partial.failedActors[0].month, "2026-01-01");
  console.log("API pooling and range request tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
