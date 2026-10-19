/*
 * Lightweight performance counters for the data layer. Every content script
 * shares one AAP_PERF per tab; a throttled snapshot is written to
 * chrome.storage.local ("aap.perf") so the popup can show live numbers.
 * Counters are cheap integer/sum updates; nothing here blocks a request.
 */
(function () {
  const STORAGE_KEY = "aap.perf";
  const FLUSH_DELAY_MS = 2_000;
  const counters = Object.create(null);
  const timings = Object.create(null);
  const marks = Object.create(null);
  const headerProbe = { checked: 0, etag: 0, lastModified: 0, cacheControl: null };
  const startedAt = Date.now();
  let flushTimer = null;

  function count(name, amount = 1) {
    counters[name] = (counters[name] || 0) + amount;
    scheduleFlush();
  }

  // Keeps count/sum/max so averages survive without storing every sample.
  function time(name, milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    const entry = timings[name] || (timings[name] = { count: 0, total: 0, max: 0 });
    entry.count++;
    entry.total += milliseconds;
    entry.max = Math.max(entry.max, milliseconds);
    scheduleFlush();
  }

  function now() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }

  // First occurrence wins: "time to first chart" should not be overwritten
  // by later re-renders in the same page load.
  function mark(name) {
    if (marks[name] != null) return;
    marks[name] = Math.round(now());
    scheduleFlush();
  }

  function recordHeaders(headers) {
    if (!headers) return;
    headerProbe.checked++;
    if (headers.etag) headerProbe.etag++;
    if (headers.lastModified) headerProbe.lastModified++;
    if (headers.cacheControl) headerProbe.cacheControl = headers.cacheControl;
    scheduleFlush();
  }

  function snapshot() {
    const averages = {};
    for (const [name, entry] of Object.entries(timings)) {
      averages[name] = { count: entry.count, avg: entry.count ? Math.round(entry.total / entry.count) : 0, max: Math.round(entry.max) };
    }
    return {
      page: typeof location === "undefined" ? "" : location.pathname,
      startedAt,
      updatedAt: Date.now(),
      counters: { ...counters },
      timings: averages,
      marks: { ...marks },
      headerProbe: { ...headerProbe },
    };
  }

  function scheduleFlush() {
    if (flushTimer != null || typeof chrome === "undefined" || !chrome.storage?.local) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try {
        chrome.storage.local.set({ [STORAGE_KEY]: snapshot() })?.catch?.(() => {});
      } catch {
        // Metrics are best effort and must never affect the page.
      }
    }, FLUSH_DELAY_MS);
  }

  self.AAP_PERF = { count, time, mark, now, recordHeaders, snapshot, STORAGE_KEY };
})();
