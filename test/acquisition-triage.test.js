const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { self: {} };
vm.runInNewContext(fs.readFileSync("lib/acquisition-triage.js", "utf8"), context);
const model = context.self.AAP_ACQUISITION_TRIAGE;

const DAY = 24 * 60 * 60 * 1000;
// Oct 19 2026: past the first week of the month.
const NOW = Date.UTC(2026, 9, 19, 12);
const MONTH = "2026-10-01T00:00:00.000Z";

function actor(id, title = `Actor ${id}`) {
  return { id, title, name: id, pictureUrl: "" };
}

function entry(viewers, starters, extra = {}) {
  return {
    viewers,
    inputViewers: extra.inputViewers ?? Math.round(viewers * 0.5),
    starters,
    prevViewers: extra.prevViewers ?? viewers,
    prevInputViewers: null,
    prevStarters: extra.prevStarters ?? starters,
    topReferrers: [],
    topCountries: [],
    failed: !!extra.failed,
    fetchedAt: extra.fetchedAt ?? NOW,
  };
}

// Fixed thresholds keep the rule tests independent of the distribution.
const T = { viewerFloor: 5, leakFloor: 20, conversionLow: 0.05, conversionHigh: 0.3, sample: 40 };

function bucket(value, options) {
  return model.assignBucket(value, T, options).key;
}

// compactEntry keeps the three counts, the comparison, and top-3 sources.
{
  const compact = model.compactEntry({
    data: {
      numUniqueViewingUsers: 97,
      numUniqueConsolePageViews: 2,
      numUniqueUsersWithRun: 2,
      topReferrers: [{ origin: "", trafficPercent: 98 }, { origin: "apify.com", trafficPercent: 2 }, { origin: "a", trafficPercent: 0 }, { origin: "b", trafficPercent: 0 }],
      topCountryCodes: [{ origin: "CN", trafficPercent: 41 }],
    },
    previous: { numUniqueViewingUsers: 38, numUniqueConsolePageViews: 6, numUniqueUsersWithRun: 0 },
    failed: false,
  }, NOW);
  assert.equal(compact.viewers, 97);
  assert.equal(compact.inputViewers, 2);
  assert.equal(compact.starters, 2);
  assert.equal(compact.prevViewers, 38);
  assert.equal(compact.prevStarters, 0);
  assert.equal(compact.topReferrers.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(compact.topCountries)), [{ origin: "CN", trafficPercent: 41 }]);
  assert.equal(compact.fetchedAt, NOW);

  // No comparison request (first day of the month): prev fields stay null.
  const firstDay = model.compactEntry({ data: { numUniqueViewingUsers: 4 }, previous: null, failed: false }, NOW);
  assert.equal(firstDay.prevViewers, null);
  assert.equal(model.change(firstDay.viewers, firstDay.prevViewers), null);

  const row = model.tableRow(actor("a"), compact);
  assert.equal(row.data.numUniqueViewingUsers, 97);
  assert.equal(row.previous.numUniqueViewingUsers, 38);
  assert.equal(row.data.topCountryCodes[0].origin, "CN");
  assert.equal(row.loaded, true);
}

// Thresholds come from the account's own distribution, with floors.
{
  const entries = [0, 0, 1, 2, 4, 8, 10, 12, 20, 40, 60, 90].map((viewers) => entry(viewers, Math.round(viewers * 0.1)));
  const t = model.computeThresholds(entries);
  assert.equal(t.viewerFloor, 4, "P25 of non-zero viewers");
  assert.equal(t.leakFloor, 12, "P50 of non-zero viewers");
  assert.ok(t.conversionHigh >= t.conversionLow);
  // A tiny account never drops below the absolute floors.
  const tiny = model.computeThresholds([entry(1, 0), entry(2, 1)]);
  assert.equal(tiny.viewerFloor, 3);
  assert.equal(tiny.leakFloor, 10);
  assert.equal(model.percentile([], 0.5), 0);
  assert.equal(model.percentile([7], 0.9), 7);
}

// Each bucket's rule.
{
  assert.equal(bucket(entry(50, 0)), "leaking", "viewers but no starters");
  assert.equal(bucket(entry(80, 2)), "leaking", "2.5% start rate is below the bottom quarter");
  assert.equal(bucket(entry(30, 2, { prevViewers: 20 })), "rising", "up 50% with a passable rate");
  assert.equal(bucket(entry(12, 2, { prevViewers: 0 })), "rising", "new this month");
  assert.equal(bucket(entry(15, 2, { prevViewers: 30 })), "fading", "down 50%");
  assert.equal(bucket(entry(20, 8)), "converting", "40% start rate, top quarter");
  assert.equal(bucket(entry(25, 4, { prevViewers: 24 })), "steady");
  assert.equal(bucket(entry(2, 0)), "quiet");
  assert.equal(bucket(entry(0, 0, { prevViewers: 0 })), "quiet");
  assert.match(model.assignBucket(entry(0, 0), T).reason, /No viewers/);
}

// Floors: small numbers never surge, and Leaking needs real volume.
{
  assert.equal(bucket(entry(6, 1, { prevViewers: 3 })), "steady", "3 -> 6 viewers is +100% but only 3 more people");
  assert.equal(bucket(entry(12, 0)), "steady", "below the leak floor is not Leaking");
  assert.equal(bucket(entry(4, 0, { prevViewers: 40 })), "fading", "a collapse from real volume still counts");
}

// First match wins: a growing Actor with a broken funnel is Leaking.
{
  assert.equal(bucket(entry(60, 0, { prevViewers: 20 })), "leaking");
  // Rising with a weak (but not bottom-quarter) rate still warns.
  const weak = model.assignBucket(entry(60, 2, { prevViewers: 20 }), { ...T, conversionLow: 0.01 });
  assert.equal(weak.key, "rising");
  assert.match(weak.reason, /fix the listing too/);
}

// Leaking names the step where people drop off.
{
  const readme = model.assignBucket(entry(97, 2, { inputViewers: 2 }), T);
  assert.match(readme.reason, /README/);
  const input = model.assignBucket(entry(97, 2, { inputViewers: 60 }), T);
  assert.match(input.reason, /input defaults/);
}

// Starters can exceed viewers (API runs); never Leaking, rate capped at 100%.
{
  const api = model.assignBucket(entry(25, 40), T);
  assert.notEqual(api.key, "leaking");
  assert.equal(api.rate, 1);
}

// Early month suppresses Rising and Fading only.
{
  assert.equal(model.isEarlyMonth(MONTH, Date.UTC(2026, 9, 3)), true);
  assert.equal(model.isEarlyMonth(MONTH, NOW), false);
  assert.equal(model.isEarlyMonth("2026-09-01T00:00:00.000Z", Date.UTC(2026, 9, 3)), false, "a past month is never early");
  assert.equal(bucket(entry(30, 2, { prevViewers: 20 }), { early: true }), "steady");
  assert.equal(bucket(entry(15, 2, { prevViewers: 30 }), { early: true }), "steady");
  assert.equal(bucket(entry(50, 0), { early: true }), "leaking");
}

// buildTriage: every scanned Actor lands in exactly one bucket, in order.
{
  const actors = ["a", "b", "c", "d", "e", "f", "g"].map((id) => actor(id));
  const snapshot = model.emptySnapshot();
  snapshot.entries = {
    a: entry(50, 0),
    b: entry(90, 1),
    c: entry(30, 2, { prevViewers: 20 }),
    d: entry(20, 8),
    e: entry(2, 0),
    f: { ...entry(null, null), viewers: null, failed: true },
  };
  const triage = model.buildTriage(actors, snapshot, T);
  assert.deepEqual([...triage.buckets.map((item) => item.key)], ["leaking", "rising", "fading", "converting", "steady", "quiet"]);
  const byKey = Object.fromEntries(triage.buckets.map((item) => [item.key, item]));
  assert.deepEqual([...byKey.leaking.items.map((item) => item.actor.id)], ["b", "a"], "most viewers first");
  assert.equal(byKey.rising.items[0].actor.id, "c");
  assert.equal(byKey.converting.items[0].actor.id, "d");
  assert.equal(byKey.quiet.items[0].actor.id, "e");
  assert.deepEqual([...triage.unavailable.map((item) => item.id)], ["f"]);
  assert.equal(triage.scanned, 5, "g is not scanned yet; f is unavailable");
  assert.equal(triage.buckets.reduce((sum, item) => sum + item.items.length, 0), 5);

  const filtered = model.buildTriage(actors, snapshot, T, { query: "actor b" });
  assert.equal(filtered.buckets.reduce((sum, item) => sum + item.items.length, 0), 1);
  assert.equal(filtered.buckets.find((item) => item.key === "leaking").total, 2, "totals ignore the filter");
}

// diffBuckets: changes since the baseline, most urgent first; Steady <-> Quiet is noise.
{
  const actors = ["a", "b", "c", "d"].map((id) => actor(id));
  const before = model.emptySnapshot();
  before.scannedAt = NOW - DAY;
  before.entries = { a: entry(2, 0), b: entry(20, 8), c: entry(25, 4), d: entry(25, 4) };
  const baseline = model.baselineFrom(before);
  assert.equal(baseline.capturedAt, NOW - DAY);
  assert.equal(baseline.version, 2);
  assert.equal(baseline.actors.b.viewers, 20);
  assert.equal(model.isBaseline(baseline), true);

  const after = model.emptySnapshot();
  after.entries = { a: entry(40, 3, { prevViewers: 10 }), b: entry(25, 4), c: entry(2, 0), d: entry(25, 4) };
  const movers = model.diffBuckets(actors, after, T, baseline);
  assert.deepEqual(JSON.parse(JSON.stringify(movers.map((item) => [item.actor.id, item.from, item.to]))), [["a", "quiet", "rising"], ["b", "converting", "steady"]]);
  assert.equal(movers[0].beforeViewers, 2);
  assert.equal(model.diffBuckets(actors, after, T, null).length, 0);

  // Same numbers never move, however much the thresholds shift.
  const shifted = { ...T, conversionLow: 0.01, leakFloor: 200 };
  assert.equal(model.diffBuckets(actors, before, shifted, baseline).length, 0);

  // A baseline from the old format (buckets, no counts) is ignored.
  const legacy = { capturedAt: NOW - DAY, actors: { a: { viewers: 2, starters: 0, bucket: "quiet" } } };
  assert.equal(model.isBaseline(legacy), false);
  assert.equal(model.diffBuckets(actors, after, T, legacy).length, 0);

  // A baseline taken in the first week keeps its early-month judgement.
  const early = model.baselineFrom({ scannedAt: NOW - DAY, entries: { a: entry(30, 2, { prevViewers: 20 }) } }, { early: true });
  const later = model.emptySnapshot();
  later.entries = { a: entry(30, 2, { prevViewers: 20 }) };
  const moved = model.diffBuckets(actors, later, T, early);
  assert.deepEqual(JSON.parse(JSON.stringify(moved.map((item) => [item.from, item.to]))), [["steady", "rising"]]);
}

// Snapshot restore and size.
{
  assert.equal(model.restoreSnapshot({ version: 0, entries: {} }).version, 1);
  assert.equal(model.restoreSnapshot(null).complete, false);
  const snapshot = model.emptySnapshot();
  for (let index = 0; index < 500; index++) {
    const id = `actor${String(index).padStart(12, "0")}`;
    snapshot.actors.push({ id, name: `some-actor-name-${index}`, title: `Some Actor Title Number ${index}: Data Scraper`, pictureUrl: `https://images.apifyusercontent.com/${id}/avatar.png` });
    snapshot.entries[id] = {
      ...entry(97, 12, { prevViewers: 38 }),
      topReferrers: [{ origin: "www.google.com", trafficPercent: 3.49 }, { origin: "apify.com", trafficPercent: 2.29 }, { origin: "console.apify.com", trafficPercent: 1.1 }],
      topCountries: [{ origin: "CN", trafficPercent: 48.86 }, { origin: "SG", trafficPercent: 24.79 }, { origin: "US", trafficPercent: 9.13 }],
    };
  }
  snapshot.thresholds = T;
  const size = JSON.stringify(snapshot).length;
  assert.ok(size < 500_000, `snapshot is ${size} bytes`);
  const restored = model.restoreSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(restored.actors.length, 500);
  assert.equal(restored.thresholds.viewerFloor, 5);
}

console.log("acquisition triage tests passed");
