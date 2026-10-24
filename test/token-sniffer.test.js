const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

let finished = false;
process.on("exit", () => {
  if (!finished && !process.exitCode) {
    console.error("token sniffer tests did not finish");
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

const listeners = new Map();
const events = [];
const pageFetches = [];
const window = {
  addEventListener(type, listener) {
    (listeners.get(type) || listeners.set(type, []).get(type)).push(listener);
  },
  dispatchEvent(event) {
    events.push(event);
    for (const listener of listeners.get(event.type) || []) listener(event);
    return true;
  },
};

class FakeXhr {
  constructor() {
    this.listeners = [];
    this.status = 200;
    this.responseType = "";
  }
  open() {}
  setRequestHeader() {}
  getResponseHeader() { return null; }
  addEventListener(type, listener) {
    if (type === "load") this.listeners.push(listener);
  }
  finish(body) {
    this.responseText = JSON.stringify(body);
    this.listeners.forEach((listener) => listener.call(this));
  }
}

function jsonResponse(body, headers = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  pageFetches.push({ url, init });
  if (url.includes("/actor-analytics/profit-margin")) return jsonResponse({ dailyProfitMarginStats: { "2026-10-01": 1 } }, { "cache-control": "no-cache" });
  return jsonResponse({ ok: true });
};

const context = {
  window,
  location: { origin: "https://console.apify.com" },
  XMLHttpRequest: FakeXhr,
  CustomEvent: SimpleCustomEvent,
  Event: SimpleEvent,
  Headers,
  URL,
  crypto: { randomUUID: () => "id" },
  console,
};
vm.runInNewContext(fs.readFileSync("content/token-sniffer.js", "utf8"), context);

(async () => {
  // The earliest Console request is not an analytics call; the token is
  // still recognized from it, but only its hash is announced.
  await window.fetch("https://console-backend.apify.com/users/profile/me", { headers: { Authorization: "Bearer secret-token" } });
  const scopeEvent = events.find((event) => event.type === "aap-auth-scope");
  assert.ok(scopeEvent, "auth scope announced from a non-analytics backend request");
  assert.match(scopeEvent.detail, /^account-[0-9a-f]{8}$/);
  assert.equal(JSON.stringify(events.map((event) => event.detail)).includes("secret-token"), false, "the token never appears in an event");

  // The extension still cannot ask for non-allowlisted endpoints.
  window.dispatchEvent(new SimpleCustomEvent("aap-api-request", { detail: { id: "x1", url: "https://console-backend.apify.com/users/profile/me" } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const rejected = events.find((event) => event.type === "aap-api-response" && event.detail.id === "x1");
  assert.equal(rejected.detail.error, "Unsupported analytics request");

  // An Actor's basic info (its publish date) is allowed; other Actor paths are not.
  window.dispatchEvent(new SimpleCustomEvent("aap-api-request", { detail: { id: "x2", url: "https://console-backend.apify.com/actor/abc123/basic-info" } }));
  window.dispatchEvent(new SimpleCustomEvent("aap-api-request", { detail: { id: "x3", url: "https://console-backend.apify.com/actor/abc123/permissions-approval" } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const basicInfo = events.find((event) => event.type === "aap-api-response" && event.detail.id === "x2");
  assert.equal(basicInfo.detail.error, undefined);
  assert.ok(pageFetches.some((request) => request.url.endsWith("/actor/abc123/basic-info")));
  const otherActorPath = events.find((event) => event.type === "aap-api-response" && event.detail.id === "x3");
  assert.equal(otherActorPath.detail.error, "Unsupported analytics request");

  // The Console's own analytics response is teed, and the Console still gets
  // an unconsumed body.
  const response = await window.fetch("https://console-backend.apify.com/actor-analytics/profit-margin?month=2026-10-01&actorIds=");
  const consoleBody = await response.json();
  assert.equal(consoleBody.dailyProfitMarginStats["2026-10-01"], 1, "the Console reads its response normally");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const started = events.find((event) => event.type === "aap-console-request");
  assert.ok(started.detail.url.includes("/actor-analytics/profit-margin"));
  const tee = events.find((event) => event.type === "aap-api-tee");
  assert.ok(tee, "response teed to the extension");
  assert.equal(tee.detail.data.dailyProfitMarginStats["2026-10-01"], 1);
  assert.equal(tee.detail.headers.cacheControl, "no-cache");

  // Non-GET and non-analytics requests are not teed.
  const teesBefore = events.filter((event) => event.type === "aap-api-tee").length;
  await window.fetch("https://console-backend.apify.com/actor-analytics/profit-margin?month=2026-10-01", { method: "POST" });
  await window.fetch("https://console-backend.apify.com/users/settings");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(events.filter((event) => event.type === "aap-api-tee").length, teesBefore);

  // Late-loading content scripts can ask for a replay.
  window.dispatchEvent(new SimpleEvent("aap-request-tee-replay"));
  assert.ok(events.filter((event) => event.type === "aap-api-tee").length > teesBefore, "buffered tees are replayed");

  // A reused XHR tees each response under its own URL.
  const xhr = new context.XMLHttpRequest();
  xhr.open("GET", "https://console-backend.apify.com/actor-analytics/profit-margin?month=2026-09-01");
  xhr.finish({ which: "profit" });
  xhr.open("GET", "https://console-backend.apify.com/actor-analytics/user-count-statistics?month=2026-09-01");
  xhr.finish({ which: "users" });
  const xhrTees = events.filter((event) => event.type === "aap-api-tee" && /2026-09-01/.test(event.detail.url));
  assert.equal(xhrTees.length, 2);
  assert.ok(xhrTees[1].detail.url.includes("user-count-statistics"));
  assert.equal(xhrTees[1].detail.data.which, "users", "the second response is filed under the second URL");
  assert.equal(xhr.listeners.length, 1, "one load listener per XHR object");

  finished = true;
  console.log("token sniffer tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
