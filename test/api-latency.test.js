const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// A promise that never settles lets the event loop drain and exit 0 silently;
// treat "never reached the end" as a failure.
let finished = false;
process.on("exit", () => {
  if (!finished && !process.exitCode) {
    console.error("API latency tests did not finish (a request never settled)");
    process.exitCode = 1;
  }
});

class SimpleEvent {
  constructor(type) { this.type = type; }
}

class SimpleCustomEvent extends SimpleEvent {
  constructor(type, init = {}) {
    super(type);
    this.detail = init.detail;
  }
}

function createHarness({ cacheEntries = new Map(), responseDelay = 0, failMonths = [] } = {}) {
  const listeners = new Map();
  const requests = [];
  const cacheWrites = [];
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
  const cache = {
    async getApi(url) {
      const entry = cacheEntries.get(url);
      return entry ? { hit: true, data: entry.data, stale: !!entry.stale } : { hit: false };
    },
    setApi(url, data, scope, policy) {
      cacheWrites.push({ url, data, policy });
      cacheEntries.set(url, { data });
      // Deliberately slow: callers must not wait for persistence.
      return new Promise((resolve) => setTimeout(() => resolve(true), 200));
    },
  };
  const context = {
    self: { AAP_CONTEXT: { organizationKey: () => "org-latency" } },
    window,
    Event: SimpleEvent,
    CustomEvent: SimpleCustomEvent,
    URL,
    URLSearchParams,
    crypto: { randomUUID: () => `latency-request-${++requestNumber}` },
    setTimeout,
    clearTimeout,
    console,
    AAP_CACHE: cache,
    AAPR: {
      isMonth: () => false,
      monthStart: (value) => value,
      monthEnd: (value) => value,
      monthKeysBetween: (start) => (start === "single" ? ["2026-10-01"] : ["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"]),
      aggregate: (monthly, start, end) => ({ months: monthly.map((item) => item.month), start, end }),
    },
  };
  window.addEventListener("aap-api-request", (event) => {
    const url = new URL(event.detail.url);
    requests.push(url);
    const month = url.searchParams.get("month");
    const fail = failMonths.includes(month);
    setTimeout(() => window.dispatchEvent(new SimpleCustomEvent("aap-api-response", {
      detail: fail
        ? { id: event.detail.id, error: `${url.pathname} -> HTTP 404` }
        : {
          id: event.detail.id,
          data: url.pathname.endsWith("/actor-breakdown")
            ? {
              currentMonthProfitUsd: 1,
              monetizationPerActor: [{
                actor: { _id: "a", title: "A", name: "a", userId: "secret-owner", notice: "x" },
                earningsStats: { totalRevenueUsd: 5, totalCostUsd: 1, totalProfitUsd: 4 },
                usersStats: { payingUsers: 1, freeUsers: 2 },
                runsStats: { TOTAL: 3, SUCCEEDED: 3, RESULTS: 9 },
                currentPricingInfo: {
                  pricingModel: "PAY_PER_EVENT",
                  apifyMarginPercentage: 0.2,
                  pricingPerEvent: {
                    actorChargeEvents: {
                      start: { isOneTimeEvent: true, eventPriceUsd: 0.00005, eventDescription: "long text" },
                      item: {
                        eventTitle: "job",
                        isPrimaryEvent: true,
                        eventDescription: "long text",
                        eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.0015 }, GOLD: { tieredEventPriceUsd: 0.0011 } },
                      },
                    },
                  },
                },
              }],
            }
            : { month },
        },
    })), responseDelay);
  });
  vm.runInNewContext(fs.readFileSync("lib/api.js", "utf8"), context);
  window.dispatchEvent(new SimpleCustomEvent("aap-auth-scope", { detail: "account-latency" }));
  return { api: context.self.AAP_API, requests, cacheWrites, cacheEntries, window };
}

(async () => {
  // Canonical URLs: empty params dropped, params sorted, so the Console's own
  // `?month=…&actorIds=` request and ours share one cache entry.
  {
    const { api } = createHarness();
    assert.equal(
      api.canonicalUrl("https://console-backend.apify.com/actor-analytics/actor-breakdown?month=2026-10-01&actorIds="),
      "https://console-backend.apify.com/actor-analytics/actor-breakdown?month=2026-10-01",
    );
    assert.equal(
      api.canonicalUrl("https://x.test/p?b=2&a=1"),
      "https://x.test/p?a=1&b=2",
    );
  }

  // Requests are sent exactly as built: the Actor list endpoint returns HTTP
  // 500 without its empty `text=` parameter, and acquisition totals send an
  // empty `actorIds=`. Only the cache key drops empty parameters.
  {
    const { api, requests, cacheWrites } = createHarness();
    await api.actorList();
    assert.equal(requests[0].search, "?text=", "the empty text parameter is sent");
    assert.equal(cacheWrites[0].url, "https://console-backend.apify.com/actors/find-users-owned-actors-by-text");
    await api.acquisitionData("2026-10-01T00:00:00.000Z", []);
    assert.ok(requests[1].search.includes("actorIds="), "empty actorIds is sent for acquisition totals");
  }

  // Past months stay fresh for days; the current month for minutes.
  {
    const { api } = createHarness();
    const current = new Date().toISOString().slice(0, 7);
    const past = api.cachePolicy("profit-margin", "https://x.test/p?month=2020-01-01");
    assert.ok(past.staleTime >= 3 * 24 * 60 * 60 * 1000, "past months are effectively immutable");
    const live = api.cachePolicy("profit-margin", `https://x.test/p?month=${current}-01`);
    assert.equal(live.staleTime, 5 * 60 * 1000);
    assert.ok(live.gcTime >= live.staleTime);
  }

  // Data returns before the (slow) cache write finishes.
  {
    const { api, cacheWrites } = createHarness();
    const started = Date.now();
    await api.profitMargin("2026-10-01", []);
    assert.ok(Date.now() - started < 150, "request resolves before the 200ms cache write");
    assert.equal(cacheWrites.length, 1);
  }

  // actor-breakdown is compacted before caching and before returning.
  {
    const { api, cacheWrites } = createHarness();
    const data = await api.actorBreakdown("2026-09-01", []);
    const item = data.monetizationPerActor[0];
    assert.equal(item.actor.userId, undefined, "unused Actor fields are dropped");
    assert.equal(item.currentPricingInfo.apifyMarginPercentage, undefined);
    const events = Object.values(item.currentPricingInfo.pricingPerEvent.actorChargeEvents);
    assert.equal(events.length, 1, "only the primary charge event is kept");
    assert.equal(events[0].eventTieredPricingUsd.FREE.tieredEventPriceUsd, 0.0015);
    assert.equal(events[0].eventDescription, undefined);
    assert.equal(item.earningsStats.totalProfitUsd, 4);
    assert.equal(cacheWrites[0].data, data);
    assert.equal(data.currentMonthProfitUsd, 1);
  }

  // Stale-while-revalidate: stale data returns immediately, then a background
  // refresh updates the cache and notifies listeners.
  {
    const cacheEntries = new Map();
    const { api, requests } = createHarness({ cacheEntries });
    const url = api.canonicalUrl("https://console-backend.apify.com/actor-analytics/profit-margin?month=2026-08-01");
    cacheEntries.set(url, { data: { cached: true }, stale: true });
    const revalidated = new Promise((resolve) => api.onRevalidated(resolve));
    const data = await api.profitMargin("2026-08-01", []);
    assert.equal(data.cached, true, "stale data is returned immediately");
    const event = await revalidated;
    assert.equal(event.path, "profit-margin");
    assert.equal(requests.length, 1, "exactly one background revalidation request");
    assert.equal(cacheEntries.get(url).data.month, "2026-08-01");
  }

  // Console response reuse: a teed response satisfies our pending request.
  {
    const { api, requests, window } = createHarness();
    const consoleUrl = "https://console-backend.apify.com/actor-analytics/user-count-statistics?month=2026-10-01&actorIds=";
    window.dispatchEvent(new SimpleCustomEvent("aap-console-request", { detail: { url: consoleUrl } }));
    const pending = api.userCountStatistics("2026-10-01", []);
    setTimeout(() => window.dispatchEvent(new SimpleCustomEvent("aap-api-tee", {
      detail: { url: consoleUrl, data: { teed: true }, headers: { etag: "abc" } },
    })), 20);
    const data = await pending;
    assert.equal(data.teed, true);
    assert.equal(requests.length, 0, "no duplicate request when the Console already fetched it");
  }

  // Newest month first, partial success, previous month in the same batch.
  {
    const { api, requests } = createHarness({ failMonths: ["2026-08-01"] });
    const progress = [];
    const result = await api.rangeData("multi", "end", [], { onProgress: (value) => progress.push(value), includePrevious: true });
    const firstMonth = requests[0].searchParams.get("month");
    assert.equal(firstMonth, "2026-10-01", "the newest month is requested first");
    assert.deepEqual([...result.partial.failedMonths], ["2026-08-01"]);
    assert.equal(result.partial.failedCount, 1);
    assert.deepEqual([...result.months], ["2026-07-01", "2026-09-01", "2026-10-01"]);
    assert.ok(progress.length >= 1, "progressive results are reported");
    assert.equal(progress[0].months.at(-1), "2026-10-01");
    assert.equal(progress[0].progressive, true);
    assert.equal(requests.some((url) => url.searchParams.get("month") === "2026-06-01"), false, "previous month already covered by range");

    const single = createHarness();
    await single.api.rangeData("single", "end", [], { includePrevious: true });
    assert.ok(single.requests.some((url) => url.pathname.endsWith("/actor-breakdown") && url.searchParams.get("month") === "2026-09-01"), "single-month range also fetches the previous month's breakdown");
  }

  // Every month failing still rejects.
  {
    const { api } = createHarness({ failMonths: ["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"] });
    await assert.rejects(api.rangeData("multi", "end", []));
  }

  // Cancelling a tag drains its queued requests immediately.
  {
    const { api, requests } = createHarness({ responseDelay: 30 });
    const load = api.rangeData("multi", "end", [], { tag: "range-1" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const removed = api.cancel("range-1");
    assert.ok(removed > 0, "queued requests are removed");
    await assert.rejects(load, /cancelled/i);
    const sentBeforeSettling = requests.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(requests.length, sentBeforeSettling, "no cancelled request is sent later");
    assert.ok(sentBeforeSettling < 20, "far fewer than the 20 range requests were sent");
  }

  finished = true;
  console.log("API latency tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
