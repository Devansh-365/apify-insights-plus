/*
 * Loaded first in every isolated-world entry. Three jobs:
 * - Record the extension's own uncaught errors locally ("aap.errors"), so the
 *   popup can export them for a bug report. Errors from Apify's page code
 *   are ignored, and nothing leaves the device.
 * - Tell the user, once per page, when Plus code failed, and offer Apify's
 *   original view. Apify's own page is never touched.
 * - Stop the extension's timers once Chrome has unloaded the extension.
 *   After an update, reload or disable, scripts already running in an open
 *   tab keep running but lose the extension APIs.
 */
(function () {
  const ERRORS_KEY = "aap.errors";
  const MAX_ERRORS = 20;
  const MAX_MESSAGE_LENGTH = 300;
  const NOTICE_CLASS = "aap-boundary-notice";

  const extensionOrigin = (() => {
    try {
      return chrome.runtime.getURL("");
    } catch {
      return "";
    }
  })();
  const version = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return null;
    }
  })();

  const intervals = new Set();
  const shutdownHooks = [];
  let stopped = false;
  let pending = [];
  let flushTimer = null;
  let writing = Promise.resolve();
  let noticeShown = false;

  function alive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function shutdown() {
    if (stopped) return;
    stopped = true;
    for (const id of intervals) clearInterval(id);
    intervals.clear();
    for (const hook of shutdownHooks.splice(0)) {
      try {
        hook();
      } catch {
        /* a failing hook must not stop the others */
      }
    }
  }

  // setInterval that stops itself, and every other `every` timer, once the
  // extension is gone.
  function every(callback, ms) {
    const id = setInterval(() => {
      if (!alive()) {
        shutdown();
        return;
      }
      callback();
    }, ms);
    intervals.add(id);
    return id;
  }

  function onShutdown(hook) {
    if (stopped) hook();
    else shutdownHooks.push(hook);
  }

  function messageOf(error) {
    if (typeof error === "string") return error;
    return error?.message || String(error ?? "Unknown error");
  }

  function extensionReloaded(error) {
    return /extension context invalidated/i.test(messageOf(error));
  }

  // Only the extension's own code: its files are served from the
  // chrome-extension:// origin, Apify's are not.
  function fromExtension(error, filename) {
    if (!extensionOrigin) return false;
    if (typeof filename === "string" && filename.startsWith(extensionOrigin)) return true;
    return typeof error?.stack === "string" && error.stack.includes(extensionOrigin);
  }

  // Error messages can name request URLs. Keep the path for debugging, drop
  // query values (month, Actor IDs) so an exported report stays small and
  // shareable.
  function scrub(text) {
    return String(text).replace(/\?[^\s"')]*/g, "?…").slice(0, MAX_MESSAGE_LENGTH);
  }

  function sourceOf(error, filename, line) {
    const fromStack = typeof error?.stack === "string"
      ? error.stack.split("\n").find((frame) => extensionOrigin && frame.includes(extensionOrigin))
      : null;
    const raw = fromStack || (filename ? `${filename}:${line || 0}` : "");
    const match = raw.match(/chrome-extension:\/\/[^/]+\/([^\s):]+(?::\d+)?)/);
    return match ? match[1] : null;
  }

  function flush() {
    flushTimer = null;
    if (!pending.length || !alive()) {
      pending = [];
      return;
    }
    const batch = pending;
    pending = [];
    // One write at a time, so a later batch reads the earlier one's result.
    writing = writing.then(async () => {
      const result = await chrome.storage.local.get(ERRORS_KEY);
      const list = Array.isArray(result?.[ERRORS_KEY]) ? result[ERRORS_KEY] : [];
      await chrome.storage.local.set({ [ERRORS_KEY]: [...list, ...batch].slice(-MAX_ERRORS) });
    }).catch(() => {});
  }

  function record(error, filename, line) {
    pending.push({
      at: new Date().toISOString(),
      version,
      page: typeof location === "undefined" ? null : `${location.hostname}${location.pathname}`,
      message: scrub(messageOf(error)),
      source: sourceOf(error, filename, line),
    });
    if (pending.length > MAX_ERRORS) pending = pending.slice(-MAX_ERRORS);
    if (flushTimer == null) flushTimer = setTimeout(flush, 1000);
  }

  function originalViewButton() {
    return document.querySelector('.aap-insights-nav-view-button[data-aap-insights-view-mode="original"]');
  }

  function showNotice(reloaded) {
    if (noticeShown || typeof document === "undefined" || !document.body) return;
    noticeShown = true;
    const notice = document.createElement("div");
    notice.className = NOTICE_CLASS;
    notice.setAttribute("role", "status");
    const text = document.createElement("span");
    text.className = `${NOTICE_CLASS}-text`;
    const actions = document.createElement("span");
    actions.className = `${NOTICE_CLASS}-actions`;

    const button = (label, onClick) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = `${NOTICE_CLASS}-button`;
      element.textContent = label;
      element.addEventListener("click", onClick);
      actions.appendChild(element);
    };

    if (reloaded) {
      text.textContent = "Insights Plus was updated. Reload this page to keep using it.";
      button("Reload", () => location.reload());
    } else {
      text.textContent = "Insights Plus hit a problem on this page. Apify's own page still works.";
      if (originalViewButton()) {
        button("Show original view", () => {
          originalViewButton()?.click();
          notice.remove();
        });
      }
    }
    button("Dismiss", () => notice.remove());
    notice.append(text, actions);
    document.body.appendChild(notice);
  }

  // A code fault, usually Apify changing a response or page shape. Plain
  // Errors (HTTP failures, timeouts) are already shown where they happen.
  function codeFault(error) {
    return ["TypeError", "ReferenceError", "RangeError", "SyntaxError"].includes(error?.name);
  }

  function handle(error, filename, line, event) {
    if (error?.name === "AbortError" || !fromExtension(error, filename)) return;
    if (extensionReloaded(error) || !alive()) {
      // Expected after an update; the notice says how to recover, so the
      // console doesn't need the same error once per pending request.
      event?.preventDefault?.();
      shutdown();
      showNotice(true);
      return;
    }
    record(error, filename, line);
    if (codeFault(error)) showNotice(false);
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("error", (event) => handle(event.error ?? event.message, event.filename, event.lineno, event));
    window.addEventListener("unhandledrejection", (event) => handle(event.reason, null, null, event));
  }

  self.AAP_LIFECYCLE = { alive, every, onShutdown, shutdown, record, ERRORS_KEY, MAX_ERRORS };
})();
