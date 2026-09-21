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
let active = 0;
let maxActive = 0;
const window = {
  addEventListener(type, listener) {
    (listeners.get(type) || listeners.set(type, []).get(type)).push(listener);
  },
  dispatchEvent(event) {
    for (const listener of listeners.get(event.type) || []) listener(event);
    return true;
  },
};

const months = Array.from({ length: 12 }, (_, index) => `2025-${String(index + 1).padStart(2, "0")}-01`);
const ACTOR_COUNT = 350;
const context = {
  self: { AAP_CONTEXT: { organizationKey: () => "org-performance" } },
  window,
  Event: SimpleEvent,
  CustomEvent: SimpleCustomEvent,
  URL,
  URLSearchParams,
  crypto: { randomUUID: () => `performance-request-${++requestNumber}` },
  setTimeout,
  clearTimeout,
  console,
  AAP_CACHE: {
    async getApi() { return { hit: false }; },
    async setApi() {},
  },
  AAPR: {
    isMonth: (value) => /^\d{4}-\d{2}$/.test(value),
    monthStart: (value) => /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value,
    monthEnd: (value) => /^\d{4}-\d{2}$/.test(value) ? `${value}-28` : value,
    monthKeysBetween: () => months,
    aggregate: (monthly) => ({ months: monthly }),
  },
};

function responseFor(url) {
  const path = url.pathname.replace(/^\/actor-analytics\//, "");
  const month = url.searchParams.get("month");
  if (path === "actor-breakdown") {
    return {
      monetizationPerActor: Array.from({ length: ACTOR_COUNT }, (_, index) => ({
        actor: { _id: `actor-${index + 1}`, title: `Actor ${index + 1}` },
        earningsStats: { totalRevenueUsd: index === 0 ? 10 : 0, totalCostUsd: index === 0 ? 1 : 0 },
      })),
    };
  }
  if (path === "profit-margin" || path === "run-statistics/monthly/all-users") {
    return { dailyProfitMarginStats: {}, dailyStats: {} };
  }
  return {};
}

window.addEventListener("aap-api-request", (event) => {
  const url = new URL(event.detail.url);
  requests.push(url);
  active++;
  maxActive = Math.max(maxActive, active);
  setTimeout(() => {
    active--;
    window.dispatchEvent(new SimpleCustomEvent("aap-api-response", {
      detail: { id: event.detail.id, data: responseFor(url) },
    }));
  }, 40);
});

vm.runInNewContext(fs.readFileSync("lib/api.js", "utf8"), context);
window.dispatchEvent(new SimpleCustomEvent("aap-auth-scope", { detail: "performance-account" }));

(async () => {
  const range = await context.self.AAP_API.rangeData("2025-01-01", "2025-12-31", []);
  const rangeRequests = requests.filter((url) => url.pathname.includes("/actor-analytics/") && !url.searchParams.has("actorIds"));
  assert.equal(rangeRequests.length, 60, "12 months should require five account-level requests per month");
  assert.equal(requests.some((url) => url.searchParams.has("actorIds")), false, "initial range loading must not scale with Actor count");
  assert.equal(Object.keys(range.actorCatalogByMonth).length, 12);
  assert.equal(range.actorCatalog.length, ACTOR_COUNT, "the aggregate catalog should include all 350 Actors without detail fan-out");
  assert.ok(maxActive <= 8, `scheduler exceeded eight active requests: ${maxActive}`);

  const beforeDedup = requests.length;
  await Promise.all([
    context.self.AAP_API.actorDailyData("2025-01-01", "actor-1"),
    context.self.AAP_API.actorDailyData("2025-01-01", "actor-1"),
  ]);
  const duplicateRequests = requests.slice(beforeDedup).filter((url) => url.searchParams.get("actorIds") === "actor-1");
  assert.equal(duplicateRequests.length, 2, "identical concurrent Actor details should share both underlying requests");

  const start = requests.length;
  await Promise.all([
    ...Array.from({ length: 8 }, (_, index) => context.self.AAP_API.runStatistics("2025-01-01", [`background-${index}`], { priority: "background" })),
    context.self.AAP_API.userCountStatistics("2025-01-01", ["foreground"], { priority: "foreground" }),
  ]);
  const priorityRequests = requests.slice(start);
  const foregroundIndex = priorityRequests.findIndex((url) => url.pathname.endsWith("/user-count-statistics"));
  assert.ok(foregroundIndex >= 0 && foregroundIndex < priorityRequests.length - 1, "foreground work should be scheduled ahead of queued background work");
  console.log("performance request-count, scheduler, and deduplication tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
