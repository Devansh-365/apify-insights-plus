/*
 * Pure model for the acquisition triage: sorts every Actor into one bucket
 * (Leaking, Rising, Fading, Converting, Steady, Quiet) from its detail-page
 * viewers, input-page viewers, and starters, with a plain-language reason,
 * and finds the Actors that changed bucket since the previous scan. No DOM,
 * no network, no state; content/acquisition.js owns those.
 */
(function () {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const SNAPSHOT_VERSION = 1;
  const ENTRY_FRESH_MS = DAY_MS;
  // Month-over-month change is too noisy to judge during the first week.
  const CHANGE_MIN_DAY = 8;
  // Absolute floors under the percentile thresholds, so a handful of viewers
  // never counts as real volume and 2 -> 4 viewers is never a surge.
  const MIN_VIEWERS = 3;
  const MIN_LEAK_VIEWERS = 10;
  const MIN_STARTERS = 2;
  const MIN_VIEWER_SHIFT = 5;
  const RISE_MIN = 0.3;
  const FALL_MIN = -0.25;
  // Below these, Rising still warns about the funnel and Leaking blames the
  // listing (few viewers reach the input page) rather than the input.
  const LOW_CONVERSION = 0.05;
  const FEW_REACH_INPUT = 0.15;
  const TOP_SOURCES = 3;

  const BUCKETS = [
    { key: "leaking", label: "Leaking", priority: 0, section: "act", tone: "bad", action: "Fix the listing" },
    { key: "rising", label: "Rising", priority: 0, section: "act", tone: "good", action: "Market it more" },
    { key: "fading", label: "Fading", priority: 1, section: "watch", tone: "warning", action: "Find out why" },
    { key: "converting", label: "Converting", priority: 1, section: "watch", tone: "good", action: "Double down" },
    { key: "steady", label: "Steady", priority: 2, section: "low", tone: "neutral", action: "Nothing to do" },
    { key: "quiet", label: "Quiet", priority: 2, section: "low", tone: "neutral", action: "Too little traffic to judge" },
  ];
  const BUCKET_BY_KEY = new Map(BUCKETS.map((bucket) => [bucket.key, bucket]));

  function finite(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function count(value) {
    const result = finite(value);
    return result == null ? null : Math.max(0, result);
  }

  function formatCount(value) {
    return Number(value || 0).toLocaleString("en-US");
  }

  function formatRate(value) {
    const percent = value * 100;
    if (percent > 0 && percent < 1) return "<1%";
    return `${percent < 10 ? percent.toFixed(1).replace(/\.0$/, "") : Math.round(percent)}%`;
  }

  function plural(value, one, many) {
    return `${formatCount(value)} ${value === 1 ? one : many}`;
  }

  // Same rule as lib/portfolio.js, so thresholds read the same on both pages.
  function percentile(values, fraction) {
    if (!values.length) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  }

  function bucketFor(key) {
    return BUCKET_BY_KEY.get(key) || null;
  }

  // ---- Entries and snapshot ---------------------------------------------------

  function sources(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, TOP_SOURCES).map((item) => ({
      origin: String(item?.origin || ""),
      trafficPercent: finite(item?.trafficPercent),
    }));
  }

  // One Actor's two monthly-marketing responses, reduced to what the triage
  // and table read. `previous` is null when it was not requested (the first
  // day of a month, when there is no elapsed portion to compare with).
  function compactEntry({ data, previous, failed }, now) {
    return {
      viewers: count(data?.numUniqueViewingUsers),
      inputViewers: count(data?.numUniqueConsolePageViews),
      starters: count(data?.numUniqueUsersWithRun),
      prevViewers: count(previous?.numUniqueViewingUsers),
      prevInputViewers: count(previous?.numUniqueConsolePageViews),
      prevStarters: count(previous?.numUniqueUsersWithRun),
      topReferrers: sources(data?.topReferrers),
      topCountries: sources(data?.topCountryCodes),
      failed: !!failed,
      fetchedAt: now,
    };
  }

  // `actors` and the last complete scan's thresholds travel with the entries,
  // so a warm visit paints the whole triage without a single request.
  function emptySnapshot() {
    return { version: SNAPSHOT_VERSION, startedAt: 0, scannedAt: 0, complete: false, entries: {}, actors: [], thresholds: null, traffic: {} };
  }

  function restoreSnapshot(data) {
    if (!data || data.version !== SNAPSHOT_VERSION || !data.entries || typeof data.entries !== "object") return emptySnapshot();
    return {
      version: SNAPSHOT_VERSION,
      startedAt: finite(data.startedAt) || 0,
      scannedAt: finite(data.scannedAt) || 0,
      complete: !!data.complete,
      entries: { ...data.entries },
      actors: Array.isArray(data.actors) ? data.actors.filter((actor) => actor?.id) : [],
      thresholds: data.thresholds && typeof data.thresholds === "object" ? { ...data.thresholds } : null,
      traffic: data.traffic && typeof data.traffic === "object" ? { ...data.traffic } : {},
    };
  }

  // The existing acquisition table renders API-shaped rows; this maps a triage
  // entry back so the table can show every scanned Actor without refetching.
  function tableRow(actor, entry) {
    const shape = (viewers, inputViewers, starters, extra) => (viewers == null && inputViewers == null && starters == null ? null : {
      numUniqueViewingUsers: viewers,
      numUniqueConsolePageViews: inputViewers,
      numUniqueUsersWithRun: starters,
      ...extra,
    });
    return {
      actor,
      data: shape(entry.viewers, entry.inputViewers, entry.starters, { topReferrers: entry.topReferrers || [], topCountryCodes: entry.topCountries || [] }),
      previous: shape(entry.prevViewers, entry.prevInputViewers, entry.prevStarters, {}),
      failed: !!entry.failed,
      loaded: true,
    };
  }

  // ---- Signals ------------------------------------------------------------------

  // Relative change, "new" when last month was zero, null when unknown.
  function change(current, previous) {
    if (current == null || previous == null) return null;
    if (previous === 0) return current === 0 ? 0 : "new";
    return (current - previous) / previous;
  }

  // Starters can exceed viewers (API and scheduled runs never open the page),
  // so the rate is capped at 100%.
  function conversion(entry) {
    if (!entry || !entry.viewers || entry.starters == null) return null;
    return Math.min(1, entry.starters / entry.viewers);
  }

  // Rising and Fading compare against the same point last month, which is
  // meaningless during the first week of the current month.
  function isEarlyMonth(month, now) {
    const date = new Date(now);
    const current = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    return String(month || "").slice(0, 7) === current && date.getUTCDate() < CHANGE_MIN_DAY;
  }

  // Volume and conversion thresholds relative to this account's own Actors.
  function computeThresholds(entries) {
    const usable = (entries || []).filter((entry) => entry && entry.viewers != null);
    const viewed = usable.map((entry) => entry.viewers).filter((value) => value > 0);
    const viewerFloor = Math.max(MIN_VIEWERS, Math.round(percentile(viewed, 0.25)));
    const leakFloor = Math.max(MIN_LEAK_VIEWERS, Math.round(percentile(viewed, 0.5)));
    const rates = usable.filter((entry) => entry.viewers >= viewerFloor).map(conversion).filter((value) => value != null);
    return {
      viewerFloor,
      leakFloor,
      conversionLow: percentile(rates, 0.25),
      conversionHigh: percentile(rates, 0.75),
      sample: rates.length,
    };
  }

  function changeText(value) {
    return `${value > 0 ? "up" : "down"} ${formatRate(Math.abs(value))}`;
  }

  // First match wins: a leaking funnel is fixed before traffic is pushed at
  // it, so Leaking outranks Rising.
  function assignBucket(entry, thresholds, { early = false } = {}) {
    if (!entry || entry.viewers == null) return { key: "quiet", reason: "No acquisition data this month", rate: null, viewerChange: null };
    const t = thresholds || computeThresholds([entry]);
    const viewers = entry.viewers;
    const starters = entry.starters ?? 0;
    const rate = conversion(entry);
    const viewerChange = change(viewers, entry.prevViewers);
    const shift = entry.prevViewers == null ? 0 : viewers - entry.prevViewers;
    const result = (key, reason) => ({ key, reason, rate, viewerChange });

    if (viewers >= t.leakFloor && starters <= viewers && (starters < MIN_STARTERS || rate < t.conversionLow)) {
      const reachInput = entry.inputViewers == null ? null : entry.inputViewers / viewers;
      const where = reachInput != null && reachInput < FEW_REACH_INPUT
        ? "few reach the input page, so check the README, title, and pricing"
        : "they reach the input page but don't start, so check input defaults and required fields";
      return result("leaking", `${formatCount(viewers)} viewers, ${formatCount(starters)} started (${formatRate(rate || 0)}): ${where}`);
    }
    if (!early && viewers >= t.viewerFloor && (viewerChange === "new" || (viewerChange != null && viewerChange >= RISE_MIN)) && shift >= MIN_VIEWER_SHIFT) {
      const weak = rate != null && rate < LOW_CONVERSION ? `; only ${formatRate(rate)} start it, so fix the listing too` : "";
      const growth = viewerChange === "new"
        ? `${plural(viewers, "viewer", "viewers")}, none at this point last month`
        : `Viewers ${changeText(viewerChange)} (${formatCount(entry.prevViewers)} → ${formatCount(viewers)})`;
      return result("rising", `${growth}${weak}`);
    }
    if (!early && Math.max(viewers, entry.prevViewers || 0) >= t.viewerFloor && typeof viewerChange === "number" && viewerChange <= FALL_MIN && -shift >= MIN_VIEWER_SHIFT) {
      return result("fading", `Viewers ${changeText(viewerChange)} (${formatCount(entry.prevViewers)} → ${formatCount(viewers)})`);
    }
    if (viewers >= t.viewerFloor && starters >= MIN_STARTERS && t.conversionHigh > 0 && rate >= t.conversionHigh) {
      return result("converting", `${formatRate(rate)} of viewers start it (${formatCount(starters)} of ${formatCount(viewers)}), top quarter of your Actors`);
    }
    if (viewers >= t.viewerFloor) {
      return result("steady", `${plural(viewers, "viewer", "viewers")}, ${formatCount(starters)} started, no strong signal`);
    }
    return result("quiet", viewers ? `Only ${plural(viewers, "viewer", "viewers")} this month` : "No viewers this month");
  }

  // Within a bucket, the Actor with the most at stake comes first.
  function sortValue(item) {
    const { entry } = item;
    const viewers = entry.viewers || 0;
    const previous = entry.prevViewers || 0;
    if (item.key === "rising") return viewers - previous;
    if (item.key === "fading") return previous - viewers;
    if (item.key === "converting") return entry.starters || 0;
    return viewers;
  }

  function matchesQuery(actor, query) {
    return !query || `${actor.title} ${actor.name}`.toLowerCase().includes(query);
  }

  // Buckets in display order with their Actors. Actors not scanned yet are
  // left out; Actors whose fetch failed with no earlier data are listed as
  // unavailable instead of being guessed into Quiet.
  function buildTriage(actors, snapshot, thresholds, { early = false, query = "" } = {}) {
    const needle = query.trim().toLowerCase();
    const buckets = new Map(BUCKETS.map((bucket) => [bucket.key, { ...bucket, items: [], total: 0, viewers: 0 }]));
    const unavailable = [];
    let scanned = 0;
    let viewers = 0;
    for (const actor of actors || []) {
      const entry = snapshot?.entries?.[actor.id];
      if (!entry) continue;
      if (entry.viewers == null && entry.failed) {
        unavailable.push(actor);
        continue;
      }
      scanned++;
      const assigned = assignBucket(entry, thresholds, { early });
      const bucket = buckets.get(assigned.key);
      bucket.total++;
      bucket.viewers += entry.viewers || 0;
      viewers += entry.viewers || 0;
      if (matchesQuery(actor, needle)) bucket.items.push({ actor, entry, ...assigned });
    }
    for (const bucket of buckets.values()) {
      bucket.items.sort((left, right) => sortValue(right) - sortValue(left) || String(left.actor.title).localeCompare(String(right.actor.title)));
    }
    return { buckets: [...buckets.values()], unavailable, scanned, viewers };
  }

  // ---- Changes since the previous scan ---------------------------------------------

  // The baseline keeps the counts, not the buckets: both sides are bucketed
  // with today's thresholds, so an Actor moves only when its own numbers do,
  // never because the account-wide percentiles shifted.
  const BASELINE_VERSION = 2;

  function baselineFrom(snapshot, { early = false } = {}) {
    const actors = {};
    for (const [id, entry] of Object.entries(snapshot?.entries || {})) {
      if (!entry || entry.viewers == null) continue;
      actors[id] = {
        viewers: entry.viewers,
        inputViewers: entry.inputViewers ?? null,
        starters: entry.starters ?? 0,
        prevViewers: entry.prevViewers ?? null,
        prevStarters: entry.prevStarters ?? null,
      };
    }
    return { version: BASELINE_VERSION, capturedAt: snapshot?.scannedAt || 0, early, actors };
  }

  function isBaseline(baseline) {
    return baseline?.version === BASELINE_VERSION && !!baseline.actors;
  }

  // Actors whose bucket changed since the baseline. Moves between the two
  // low-attention buckets (Steady and Quiet) are noise and left out.
  function diffBuckets(actors, snapshot, thresholds, baseline, { early = false, query = "" } = {}) {
    if (!isBaseline(baseline)) return [];
    const needle = query.trim().toLowerCase();
    const movers = [];
    for (const actor of actors || []) {
      const entry = snapshot?.entries?.[actor.id];
      const before = baseline.actors[actor.id];
      if (!entry || entry.viewers == null || !before || before.viewers == null) continue;
      const from = assignBucket(before, thresholds, { early: !!baseline.early }).key;
      const assigned = assignBucket(entry, thresholds, { early });
      if (assigned.key === from) continue;
      if (bucketFor(from).priority === 2 && bucketFor(assigned.key).priority === 2) continue;
      if (!matchesQuery(actor, needle)) continue;
      movers.push({ actor, entry, from, to: assigned.key, reason: assigned.reason, beforeViewers: before.viewers });
    }
    return movers.sort((left, right) =>
      bucketFor(left.to).priority - bucketFor(right.to).priority
      || Math.abs(right.entry.viewers - right.beforeViewers) - Math.abs(left.entry.viewers - left.beforeViewers)
      || String(left.actor.title).localeCompare(String(right.actor.title)));
  }

  self.AAP_ACQUISITION_TRIAGE = {
    BUCKETS,
    ENTRY_FRESH_MS,
    CHANGE_MIN_DAY,
    FEW_REACH_INPUT,
    bucketFor,
    percentile,
    compactEntry,
    emptySnapshot,
    restoreSnapshot,
    tableRow,
    change,
    conversion,
    isEarlyMonth,
    computeThresholds,
    assignBucket,
    buildTriage,
    baselineFrom,
    isBaseline,
    diffBuckets,
    formatRate,
  };
})();
