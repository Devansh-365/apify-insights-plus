const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const EXTENSION = "chrome-extension://abcdefghijklmnop/";
const listeners = new Map();
const stored = {};
const appended = [];
const runtime = {
  id: "abcdefghijklmnop",
  getURL: (path) => `${EXTENSION}${path}`,
  getManifest: () => ({ version: "1.0.0" }),
};

function element(tag) {
  return {
    tag,
    children: [],
    listeners: {},
    textContent: "",
    setAttribute() {},
    append(...items) { this.children.push(...items); },
    appendChild(item) { this.children.push(item); },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    remove() { this.removed = true; },
  };
}

const context = {
  self: {},
  location: { hostname: "console.apify.com", pathname: "/actors/insights/monetization", reload() {} },
  chrome: {
    runtime,
    storage: {
      local: {
        async get(key) { return { [key]: stored[key] }; },
        async set(values) { Object.assign(stored, values); },
      },
    },
  },
  document: {
    body: { appendChild: (item) => appended.push(item) },
    createElement: element,
    querySelector: () => null,
  },
  window: {
    addEventListener(type, listener) { listeners.set(type, listener); },
  },
  setTimeout: (callback) => setImmediate(callback),
  setInterval,
  clearInterval,
  Date,
  String,
  Array,
};
vm.runInNewContext(fs.readFileSync("lib/error-boundary.js", "utf8"), context);
const lifecycle = context.self.AAP_LIFECYCLE;
const settle = () => new Promise((resolve) => setImmediate(resolve));

function extensionError(name, message) {
  const error = new Error(message);
  error.name = name;
  error.stack = `${name}: ${message}\n    at render (${EXTENSION}content/range.js:120:7)`;
  return error;
}

function reject(reason) {
  let prevented = false;
  listeners.get("unhandledrejection")({ reason, preventDefault: () => { prevented = true; } });
  return prevented;
}

(async () => {
  // Apify's own errors are ignored.
  reject(new Error("Apify page error"));
  listeners.get("error")({ error: new Error("page"), message: "page", filename: "https://console.apify.com/app.js", lineno: 3 });
  await settle();
  assert.equal(stored[lifecycle.ERRORS_KEY], undefined, "page errors are not recorded");
  assert.equal(appended.length, 0, "page errors show no notice");

  // A cancelled request is not an error.
  reject(extensionError("AbortError", "Request cancelled"));
  await settle();
  assert.equal(stored[lifecycle.ERRORS_KEY], undefined);

  // An HTTP failure is recorded without a notice; the view shows it inline.
  reject(extensionError("Error", "/actor-analytics/export?month=2026-10-01&actorIds=a,b -> HTTP 500"));
  await settle();
  let errors = stored[lifecycle.ERRORS_KEY];
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "/actor-analytics/export?… -> HTTP 500", "query values are dropped");
  assert.equal(errors[0].source, "content/range.js:120");
  assert.equal(errors[0].version, "1.0.0");
  assert.equal(appended.length, 0);

  // A code fault (Apify changed a response shape) shows one notice.
  reject(extensionError("TypeError", "Cannot read properties of undefined (reading 'map')"));
  reject(extensionError("TypeError", "Cannot read properties of undefined (reading 'length')"));
  await settle();
  assert.equal(appended.length, 1, "one notice per page");
  assert.match(appended[0].children[0].textContent, /hit a problem/);

  // The record is a capped ring buffer.
  for (let index = 0; index < 30; index++) reject(extensionError("Error", `failure ${index}`));
  await settle();
  errors = stored[lifecycle.ERRORS_KEY];
  assert.equal(errors.length, lifecycle.MAX_ERRORS);
  assert.equal(errors.at(-1).message, "failure 29", "the newest errors are kept");

  // After an update the timers stop and the reload error is suppressed.
  let ticks = 0;
  let hookCalls = 0;
  lifecycle.every(() => { ticks++; }, 5);
  lifecycle.onShutdown(() => { hookCalls++; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(ticks > 0, "timers run while the extension is loaded");
  runtime.id = undefined;
  assert.equal(lifecycle.alive(), false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const ticksAfter = ticks;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ticks, ticksAfter, "timers stop once the extension is unloaded");
  assert.equal(hookCalls, 1, "shutdown hooks run once");
  const prevented = reject(extensionError("Error", "Extension context invalidated."));
  assert.equal(prevented, true, "reload errors are kept out of the console");

  console.log("Error boundary tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
