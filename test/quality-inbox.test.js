const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { self: {} };
vm.runInNewContext(fs.readFileSync("lib/quality-inbox.js", "utf8"), context);
const model = context.self.AAP_QUALITY_INBOX;

const DAY = 24 * 60 * 60 * 1000;
// Oct 19: past the pace threshold, in a 31-day month.
const NOW = Date.UTC(2026, 9, 19, 12);
const EARLY = Date.UTC(2026, 9, 3, 12);

function actor(id, title = `Actor ${id}`) {
  return { id, title, name: id, username: "dev", pictureUrl: "" };
}

function snapshotWith(entries) {
  const snapshot = model.emptySnapshot();
  for (const [id, improvements] of Object.entries(entries)) {
    snapshot.entries[id] = { id, scores: { actorQuality: 0.8 }, improvements: improvements.map((itemId) => ({ id: itemId, title: itemId, description: "" })), praises: [], failed: false, fetchedAt: NOW };
  }
  return snapshot;
}

// Every known improvement ID lands in its work group; unknown IDs go to Other.
{
  const expected = {
    SENSITIVE_PROPERTIES_WITHOUT_SECRET_FLAG: "security", PERMISSION_LEVEL: "security",
    RELIABILITY: "ops", ISSUE_RESPONSE_TIME: "ops",
    HAS_INPUT_SCHEMA: "schema", HAS_OUTPUT_SCHEMA: "schema",
    ACTOR_START_PRICE: "pricing", PPE_PRICING: "pricing", PPE_PRIMARY_EVENT: "pricing", PPE_PLATFORM_USAGE: "pricing", TIERED_PRICING: "pricing",
    NO_README: "listing", README_QUALITY: "listing", TITLE_QUALITY: "listing", DESCRIPTION_QUALITY: "listing",
    HAS_AVATAR_IMAGE: "listing", INPUT_PROPERTY_DESCRIPTION_QUALITY: "listing", PUBLISH_TASK: "listing",
    RATING: "market", TOTAL_USERS: "market",
  };
  assert.equal(Object.keys(expected).length, 20);
  for (const [id, group] of Object.entries(expected)) assert.equal(model.groupFor(id).key, group, id);
  assert.equal(model.groupFor("SOMETHING_NEW").key, "other");
  assert.equal(model.WORK_GROUPS.find((group) => group.key === "market").hidden, true);
}

// Suggestions from both endpoints merge by ID, keeping business-value detail.
{
  const merged = model.mergeImprovements(
    { praises: [], improvements: [{ id: "NO_README", title: "Add a README", description: "x" }] },
    [{ id: "NO_README", title: "Add a README", description: "x", descriptionDetail: "more", valueLift: 0.12 }, { id: "TOTAL_USERS", title: "Grow", description: "y" }],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].detail, "more");
  assert.equal(merged[0].valueLift, 0.12);
  const entry = model.compactEntry(actor("a"), {
    scores: { actorQuality: 0.81234567, totalUsersSnapshotDay3Percentile: 0.5, readmeQuality: 0.4 },
    recommendations: { praises: [{ title: "Fast" }], improvements: [] },
    businessValue: [],
  }, NOW);
  assert.equal(entry.scores.actorQuality, 0.8123, "scores are rounded");
  assert.equal(entry.scores.totalUsersSnapshotDay3Percentile, undefined, "noisy popularity snapshots are not stored");
  assert.deepEqual([...entry.improvements], []);
  assert.deepEqual([...entry.praises], ["Fast"]);
}

// Ranking: last month vs. this month's pace, and free Actors still count.
{
  const traffic = model.trafficFromRows(
    [{ id: "paid", revenue: 100, runs: 50, payingUsers: 5, freeUsers: 1 }, { id: "free", revenue: 0, runs: 9000, payingUsers: 0, freeUsers: 400 }],
    [{ id: "paid", revenue: 95, runs: 40, payingUsers: 5, freeUsers: 0 }],
  );
  const paidRevenue = model.revenueForRanking(traffic.paid, NOW);
  assert.equal(paidRevenue.basis, "pace", "this month's pace beats last month");
  assert.ok(Math.abs(paidRevenue.value - 95 * 31 / 19) < 1e-9);
  const early = model.revenueForRanking(traffic.paid, EARLY);
  assert.deepEqual({ ...early }, { value: 100, basis: "last month" }, "pace is ignored early in the month");
  assert.equal(model.revenueForRanking(undefined, NOW).basis, null);
  assert.ok(model.trafficWeight(traffic.free, NOW) > 100, "a heavy free Actor gets real weight");
  assert.equal(model.trafficWeight(undefined, NOW), 1);
  const ranked = model.rankActors([actor("none"), actor("free"), actor("paid")], traffic, NOW).map((item) => item.id);
  assert.deepEqual([...ranked], ["paid", "free", "none"]);
  assert.equal(model.successRate({ current: { runs: 10, succeeded: 9 } }).value, 0.9);
  assert.equal(model.successRate({ current: { runs: 0 }, previous: { runs: 4, succeeded: 2 } }).basis, "last month");
}

// Scan planning resumes: fresh entries are skipped unless forced.
{
  const actors = [actor("a"), actor("b"), actor("c")];
  const snapshot = model.emptySnapshot();
  snapshot.entries.a = { id: "a", fetchedAt: NOW - 60_000, failed: false };
  snapshot.entries.b = { id: "b", fetchedAt: NOW - 2 * DAY, failed: false };
  snapshot.entries.c = { id: "c", fetchedAt: NOW - 60_000, failed: true };
  assert.deepEqual([...model.planScan(actors, snapshot, NOW).map((item) => item.id)], ["b", "c"]);
  assert.equal(model.planScan(actors, snapshot, NOW, { force: true }).length, 3);
  const restored = model.restoreSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(Object.keys(restored.entries).length, 3);
  assert.equal(Object.keys(model.restoreSnapshot({ version: 0, entries: { a: {} } }).entries).length, 0, "an old schema starts over");
  const withContext = model.restoreSnapshot({ ...model.emptySnapshot(), actors: [actor("a"), { title: "no id" }], traffic: { a: { previous: null } } });
  assert.deepEqual([...withContext.actors.map((item) => item.id)], ["a"], "the Actor list travels with the snapshot");
  assert.ok(withContext.traffic.a);
}

// Lifecycle: the first scan flags nothing as New; later suggestions are New
// for 7 days; resolved ones clear; snoozes expire; partial scans never clear.
{
  let store = model.reconcileLifecycle({}, snapshotWith({ a: ["NO_README"] }), NOW, { firstScan: true });
  assert.equal(model.isNew(store["a:NO_README"], NOW), false, "first scan backdates");

  const later = NOW + DAY;
  store = model.reconcileLifecycle(store, snapshotWith({ a: ["NO_README", "RELIABILITY"] }), later);
  assert.equal(model.isNew(store["a:RELIABILITY"], later), true);
  assert.equal(model.isNew(store["a:RELIABILITY"], later + 8 * DAY), false, "New lasts 7 days");

  store = model.applyAction(store, "a", "NO_README", "fix", later);
  assert.equal(model.effectiveState(store["a:NO_README"], later), "fixing");
  store = model.reconcileLifecycle(store, snapshotWith({ a: ["RELIABILITY"] }), later + DAY);
  assert.equal(store["a:NO_README"].state, "cleared", "a fixed suggestion clears once Apify drops it");
  assert.equal(store["a:NO_README"].clearedFrom, "fixing");

  store = model.reconcileLifecycle(store, snapshotWith({ a: ["NO_README", "RELIABILITY"] }), later + 2 * DAY);
  assert.equal(store["a:NO_README"].state, "open", "a cleared suggestion that returns reopens");
  assert.equal(model.isNew(store["a:NO_README"], later + 2 * DAY), true);

  store = model.applyAction(store, "a", "RELIABILITY", "snooze", later, { snoozeMs: DAY });
  assert.equal(model.effectiveState(store["a:RELIABILITY"], later + DAY / 2), "snoozed");
  assert.equal(model.effectiveState(store["a:RELIABILITY"], later + 2 * DAY), "open", "snooze expires");

  store = model.applyAction(store, "a", "RELIABILITY", "dismiss", later);
  assert.equal(model.isNew(store["a:RELIABILITY"], later), false, "dismissed is never New");

  const failed = snapshotWith({ a: [] });
  failed.entries.a.failed = true;
  const untouched = model.reconcileLifecycle(store, failed, later + 3 * DAY);
  assert.equal(untouched["a:NO_README"].state, "open", "a failed fetch never clears suggestions");

  const pruned = model.reconcileLifecycle(store, snapshotWith({ b: [] }), later + 3 * DAY, { complete: true, actorIds: ["b"] });
  assert.ok(pruned["a:NO_README"], "an unlisted Actor's records are kept: they may be another account's");
  const longGone = model.reconcileLifecycle(store, snapshotWith({ b: [] }), later + 200 * DAY, { complete: true, actorIds: ["b"] });
  assert.equal(Object.keys(longGone).some((key) => key.startsWith("a:")), false, "and dropped half a year after their last change");
  const partial = model.reconcileLifecycle(store, snapshotWith({ b: [] }), later + 3 * DAY, { actorIds: ["b"] });
  assert.ok(partial["a:NO_README"], "a partial scan keeps unscanned Actors");

  const old = model.pruneLifecycle({ "a:X": { state: "cleared", clearedAt: NOW - 31 * DAY } }, null, NOW);
  assert.equal(Object.keys(old).length, 0, "cleared entries are pruned after 30 days");
}

// Inbox: grouped by work type, ranked by type weight times traffic, with
// dismissed/snoozed hidden and Market marked hidden.
{
  const actors = [actor("big", "Big"), actor("small", "Small")];
  const traffic = model.trafficFromRows([{ id: "big", revenue: 500, runs: 1000, payingUsers: 20, freeUsers: 5 }, { id: "small", revenue: 1, runs: 5, payingUsers: 0, freeUsers: 1 }], []);
  const snapshot = snapshotWith({ big: ["TITLE_QUALITY", "TOTAL_USERS"], small: ["SENSITIVE_PROPERTIES_WITHOUT_SECRET_FLAG", "TITLE_QUALITY", "README_QUALITY"] });
  let store = model.reconcileLifecycle({}, snapshot, NOW, { firstScan: true });
  store = model.applyAction(store, "small", "README_QUALITY", "dismiss", NOW);
  const inbox = model.buildInbox(actors, snapshot, store, traffic, NOW);
  const group = (key) => inbox.groups.find((item) => item.key === key);
  assert.equal(group("security").items.length, 1);
  assert.deepEqual([...group("listing").items.map((item) => item.actor.id)], ["big", "small"], "higher traffic first within a group");
  assert.equal(group("listing").actorCount, 2);
  assert.equal(group("market").hidden, true);
  assert.equal(inbox.counts.dismissed, 1);
  assert.equal(inbox.hidden.length, 0, "hidden suggestions are listed only on request");
  const withHidden = model.buildInbox(actors, snapshot, store, traffic, NOW, { includeHidden: true });
  assert.deepEqual([...withHidden.hidden.map((item) => item.improvement.id)], ["README_QUALITY"]);
  assert.equal(inbox.actorsWithSuggestions, 2);
  assert.equal(inbox.actorsToFix, 2, "Market-only Actors do not count as needing a fix");
  const title = inbox.issues.find((issue) => issue.id === "TITLE_QUALITY");
  assert.deepEqual([...title.items.map((item) => item.actor.id)], ["big", "small"], "one issue lists every Actor it applies to");
  assert.equal(inbox.issues.filter((issue) => issue.id === "TITLE_QUALITY").length, 1);
  assert.ok(inbox.issues.findIndex((issue) => issue.id === "TITLE_QUALITY") < inbox.issues.findIndex((issue) => issue.id === "TOTAL_USERS"), "issues are ordered by total impact");
  const marketOnly = model.buildInbox([actor("m")], snapshotWith({ m: ["TOTAL_USERS"] }), {}, {}, NOW);
  assert.equal(marketOnly.actorsWithSuggestions, 1);
  assert.equal(marketOnly.actorsToFix, 0);
  assert.ok(group("listing").items.every((item) => ["high", "medium", "low"].includes(item.level)));
  assert.equal(model.buildInbox(actors, snapshot, store, traffic, NOW, { query: "secret" }).groups.reduce((sum, item) => sum + item.items.length, 0), 1, "search matches suggestion IDs");

  // One security issue outranks several listing tweaks at equal traffic.
  const even = model.trafficFromRows([{ id: "s", revenue: 10 }, { id: "l", revenue: 10 }], []);
  const security = model.actorSummary(actor("s"), snapshotWith({ s: ["PERMISSION_LEVEL"] }), {}, even, NOW);
  const listing = model.actorSummary(actor("l"), snapshotWith({ l: ["TITLE_QUALITY", "README_QUALITY", "HAS_AVATAR_IMAGE"] }), {}, even, NOW);
  assert.ok(security.impact > listing.impact);
}

// Score changes are explained by the sub-scores that moved most.
{
  const actors = [actor("a"), actor("b"), actor("c")];
  const snapshot = model.emptySnapshot();
  snapshot.entries.a = { scores: { actorQuality: 0.7, readmeQuality: 0.4, runSuccessRate: 0.95 } };
  snapshot.entries.b = { scores: { actorQuality: 0.9, readmeQuality: 0.9 } };
  snapshot.entries.c = { scores: { actorQuality: 0.85 } };
  const previous = { a: { actorQuality: 0.8, readmeQuality: 0.8, runSuccessRate: 0.96 }, b: { actorQuality: 0.9, readmeQuality: 0.9 } };
  const movements = model.diffScores(actors, snapshot, previous);
  assert.equal(movements.length, 1, "unchanged and new Actors are not movements");
  assert.equal(movements[0].actor.id, "a");
  assert.ok(Math.abs(movements[0].delta + 0.1) < 1e-9);
  assert.deepEqual([...movements[0].drivers.map((item) => item.key)], ["readmeQuality"], "small sub-score wobble is ignored");
  assert.deepEqual([...model.diffScores(actors, snapshot, null)], []);
}

// A 500-Actor snapshot stays well inside the 2 MB view-entry limit.
{
  const snapshot = model.emptySnapshot();
  const scores = Object.fromEntries(Object.keys(model.SCORE_LABELS).map((key) => [key, 0.123456]));
  for (let index = 0; index < 500; index++) {
    const id = `actor${String(index).padStart(12, "0")}`;
    snapshot.entries[id] = model.compactEntry(actor(id), {
      scores,
      recommendations: {
        praises: [{ title: "Actor running smoothly" }, { title: "Clearly defined input schema" }],
        improvements: [{ id: "README_QUALITY", title: "Improve your README", description: "d".repeat(400) }],
      },
      businessValue: [{ id: "TOTAL_USERS", title: "Grow your user base", description: "d".repeat(400), descriptionDetail: "e".repeat(400), valueLift: 0.1 }],
    }, NOW);
  }
  const size = JSON.stringify(snapshot).length;
  assert.ok(size < 1_500_000, `snapshot is ${size} bytes before compression`);
}

// Lifecycles saved under older login tokens merge: each suggestion keeps
// its most recently changed record.
{
  const copies = [
    { "a:X": { state: "fixing", stateChangedAt: 10 }, "a:Y": { state: "dismissed", stateChangedAt: 3 }, "c:W": { state: "open", stateChangedAt: 1 } },
    // A later token's first scan recorded these as open on its own.
    { "a:X": { state: "open", stateChangedAt: 40 }, "a:Y": { state: "open", stateChangedAt: 50 }, "b:Z": { state: "snoozed", stateChangedAt: 8, snoozeUntil: 99 }, "c:W": { state: "cleared", stateChangedAt: 9 } },
  ];
  const merged = model.mergeLifecycles(copies);
  assert.deepEqual(JSON.parse(JSON.stringify(merged)), {
    "a:X": { state: "fixing", stateChangedAt: 10 },
    "a:Y": { state: "dismissed", stateChangedAt: 3 },
    "c:W": { state: "cleared", stateChangedAt: 9 },
    "b:Z": { state: "snoozed", stateChangedAt: 8, snoozeUntil: 99 },
  }, "the user's decision beats a newer automatic record");
  assert.deepEqual(model.mergeLifecycles([merged, ...copies]), merged, "merging again changes nothing");
}

console.log("quality inbox tests passed");
