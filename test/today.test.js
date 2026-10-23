const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = { self: {} };
for (const file of ["lib/quality-inbox.js", "lib/acquisition-triage.js", "lib/today.js"]) {
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context);
}
const model = context.self.AAP_TODAY_MODEL;
const json = (value) => JSON.parse(JSON.stringify(value));

const DAY = 24 * 60 * 60 * 1000;
// Oct 21 2026, noon local: past the first week, 2/3 of the month elapsed.
const NOW = new Date(2026, 9, 21, 12).getTime();
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
    failed: false,
    fetchedAt: NOW,
  };
}

const T = { viewerFloor: 5, leakFloor: 20, conversionLow: 0.05, conversionHigh: 0.3, sample: 40 };

function acquisition(entries) {
  const actors = Object.keys(entries).map((id) => actor(id));
  return { month: MONTH, thresholds: T, snapshot: { actors, entries, thresholds: T, complete: true, scannedAt: NOW } };
}

function traffic(revenue, users, runs = 0, succeeded = runs) {
  return { previous: { revenue, users, payingUsers: users, runs, succeeded }, current: null };
}

// Month factor projects month-to-date to a full month.
{
  assert.equal(model.monthFactor("2026-09-01T00:00:00.000Z", NOW), 1, "a past month is already whole");
  const factor = model.monthFactor(MONTH, NOW);
  assert.ok(factor > 1.4 && factor < 1.6, `about 31/20.5, got ${factor}`);
  assert.equal(model.monthFactor(MONTH, Date.UTC(2026, 9, 1, 6)), 4, "the first days are capped");
}

// Leaking splits by where people drop off and is sized in users.
{
  const candidates = model.buildCandidates({
    acquisition: acquisition({
      listing: entry(120, 0, { inputViewers: 3 }),
      runform: entry(100, 1, { inputViewers: 60 }),
      steady: entry(25, 4),
    }),
    now: NOW,
  });
  const byKey = Object.fromEntries(candidates.map((item) => [item.key, item]));
  assert.ok(byKey["a:convert:listing"], "few reach the run form: fix the listing");
  assert.ok(byKey["a:convert:runform"], "many reach the run form: fix the run form");
  assert.equal(byKey["a:convert:listing"].verb, "Fix the listing");
  assert.match(byKey["a:convert:listing"].why, /120 opened the listing, 3 opened the run form, 0 ran it/);
  assert.ok(!candidates.some((item) => item.actor.id === "steady"), "nothing to do on a steady Actor");
  // Target is midway between the bottom and top quarter (17.5%); 120 viewers
  // at 0% miss 21 users so far this month, about 31 projected.
  const users = byKey["a:convert:listing"].users;
  assert.ok(users > 28 && users < 34, `got ${users}`);
}

// Dollars use the Actor's own revenue per user, else the portfolio median,
// and rank above users when the account earns anything.
{
  const candidates = model.buildCandidates({
    acquisition: acquisition({
      rich: entry(60, 0, { inputViewers: 3 }),
      free: entry(80, 0, { inputViewers: 3 }),
    }),
    traffic: { rich: traffic(500, 50), other: traffic(100, 50) },
    now: NOW,
  });
  const rich = candidates.find((item) => item.actor.id === "rich");
  const free = candidates.find((item) => item.actor.id === "free");
  assert.equal(rich.paid, true);
  assert.equal(free.paid, false);
  assert.ok(Math.abs(rich.dollars - rich.users * 10) < 1e-9, "its own $10 per user");
  assert.ok(Math.abs(free.dollars - free.users * 6) < 1e-9, "median of $10 and $2 per user");
  assert.equal(candidates[0].actor.id, "rich", "more dollars at stake despite fewer viewers");
}

// Rising and fading are sized by the starters gained or lost; a steep fall
// is urgent and ranks first.
{
  const candidates = model.buildCandidates({
    acquisition: acquisition({
      rising: entry(60, 10, { prevViewers: 20, prevStarters: 4 }),
      fading: entry(10, 1, { prevViewers: 40, prevStarters: 8 }),
    }),
    now: NOW,
  });
  assert.deepEqual(json(candidates.map((item) => [item.kind, item.urgent])), [["fading", true], ["promote", false]]);
  assert.match(candidates[0].why, /Viewers down 75% \(40 → 10\)/);
  assert.match(candidates[0].hint, /stop starting it|Fewer people find it/);
}

// Quality suggestions: open ones only, Market hidden, reliability urgent
// when runs fail, sized as a share of the Actor's revenue.
{
  const actors = [actor("q1"), actor("q2")];
  const snapshot = {
    actors,
    entries: {
      q1: { improvements: [{ id: "RELIABILITY", title: "Fix Actor health issues", description: "Runs fail." }, { id: "TOTAL_USERS", title: "Grow your user base" }] },
      q2: { improvements: [{ id: "README_QUALITY", title: "Improve the README" }] },
    },
  };
  const lifecycle = { "q2:README_QUALITY": { state: "dismissed", firstSeen: 0, stateChangedAt: NOW } };
  const candidates = model.buildCandidates({
    quality: { snapshot, lifecycle },
    traffic: { q1: traffic(200, 40, 100, 70), q2: traffic(50, 10) },
    now: NOW,
  });
  assert.deepEqual(json(candidates.map((item) => item.key)), ["q:q1:RELIABILITY"]);
  assert.equal(candidates[0].urgent, true, "70% success on 100 runs");
  assert.match(candidates[0].why, /70% of its 100 runs last month succeeded/);
  assert.ok(Math.abs(candidates[0].dollars - 200 * 0.15) < 1e-9);
}

// A small quality fix still lists when the Actor has real users, and drops
// when nobody uses it.
{
  const snapshot = {
    actors: [actor("used"), actor("unused")],
    entries: {
      used: { improvements: [{ id: "HAS_OUTPUT_SCHEMA", title: "Add an output schema" }] },
      unused: { improvements: [{ id: "HAS_OUTPUT_SCHEMA", title: "Add an output schema" }] },
    },
  };
  const candidates = model.buildCandidates({ quality: { snapshot, lifecycle: {} }, traffic: { used: traffic(0, 5) }, now: NOW });
  assert.deepEqual(json(candidates.map((item) => item.key)), ["q:used:HAS_OUTPUT_SCHEMA"]);
}

// Today's plan: capped, one item per Actor, frozen for the day, refilled when
// a missing scan arrives, extended on request, rebuilt the next day.
{
  const entries = {};
  for (let index = 0; index < 8; index++) entries[`a${index}`] = entry(200 - index * 10, 0, { inputViewers: 3 });
  const candidates = model.buildCandidates({ acquisition: acquisition(entries), now: NOW });
  let store = model.emptyStore();
  const first = model.planToday(store, candidates, NOW, { sources: { acquisition: 1 } });
  assert.equal(first.changed, true);
  assert.equal(first.plan.items.length, 5);
  assert.deepEqual(json(first.plan.items.map((item) => item.actorId)), ["a0", "a1", "a2", "a3", "a4"]);
  store = { ...store, plan: first.plan };

  const again = model.planToday(store, candidates.slice().reverse(), NOW + 1000, { sources: { acquisition: 1 } });
  assert.equal(again.changed, false, "the list stays put within the day");

  const quality = { ...candidates[5], source: "quality", key: "q:zz:RELIABILITY", fixKey: "q:RELIABILITY", actor: actor("zz") };
  const widened = model.planToday(store, [quality, ...candidates], NOW, { sources: { acquisition: 1, quality: 1 }, handled: [first.plan.items[3].key] });
  assert.equal(widened.changed, true);
  assert.equal(widened.plan.items.length, 5);
  assert.equal(widened.plan.items[0].key, first.plan.items[3].key, "a handled item stays");
  assert.equal(widened.plan.items[1].key, "q:zz:RELIABILITY", "a new scan re-picks untouched items");
  const rescanned = model.planToday({ ...store, plan: widened.plan }, candidates, NOW, { sources: { acquisition: 1, quality: 1 } });
  assert.equal(rescanned.changed, false, "the same scans do not rebuild");

  const more = model.planToday(store, candidates, NOW, { sources: { acquisition: 1 }, extra: 1 });
  assert.equal(more.plan.items.length, 6);
  assert.equal(more.plan.items[5].actorId, "a5");

  const tomorrow = model.planToday(store, candidates.slice(2), NOW + DAY, { sources: { acquisition: 1 } });
  assert.equal(tomorrow.changed, true);
  assert.equal(tomorrow.plan.items[0].actorId, "a2");
}

// Decisions: done hides for two weeks, snooze until a date or until worse,
// dismiss until worse; undo clears today's decision.
{
  const [candidate] = model.buildCandidates({ acquisition: acquisition({ x: entry(120, 0, { inputViewers: 3 }) }), now: NOW });
  let store = model.applyDecision(model.emptyStore(), candidate, "done", NOW);
  assert.equal(model.openCandidates([candidate], store, NOW + DAY).length, 0);
  assert.equal(model.openCandidates([candidate], store, NOW + 15 * DAY).length, 1, "still flagged after two weeks");
  assert.equal(model.todayAction(store, candidate.key, NOW), "done");
  assert.equal(model.weekSummary(store, NOW).done, 1);

  store = model.applyDecision(model.emptyStore(), candidate, "snooze", NOW, { snooze: "week" });
  assert.equal(model.openCandidates([candidate], store, NOW + 6 * DAY).length, 0);
  assert.equal(model.openCandidates([candidate], store, NOW + 8 * DAY).length, 1);

  store = model.applyDecision(model.emptyStore(), candidate, "snooze", NOW, { snooze: "worse" });
  assert.equal(model.openCandidates([candidate], store, NOW + 60 * DAY).length, 0, "not worse yet");
  assert.equal(model.openCandidates([{ ...candidate, users: candidate.users * 2 }], store, NOW).length, 1, "worse: back");

  store = model.applyDecision(model.emptyStore(), candidate, "dismiss", NOW);
  assert.equal(model.openCandidates([candidate], store, NOW + 90 * DAY).length, 0);
  store = model.undoDecision(store, candidate.key, NOW);
  assert.equal(model.openCandidates([candidate], store, NOW).length, 1);
  assert.equal(model.todayAction(store, candidate.key, NOW), null);
}

// Plan status: decided, resolved by a rescan, or handled in the quality inbox.
{
  const candidates = model.buildCandidates({
    acquisition: acquisition({ a: entry(120, 0, { inputViewers: 3 }), b: entry(110, 0, { inputViewers: 3 }), c: entry(100, 0, { inputViewers: 3 }) }),
    now: NOW,
  });
  const { plan } = model.planToday(model.emptyStore(), candidates, NOW, { sources: { acquisition: 1 } });
  plan.items.push({ key: "q:d:RELIABILITY", source: "quality", actorId: "d", improvementId: "RELIABILITY", title: "d", verb: "Fix", users: 1, dollars: 1 });
  const store = model.applyDecision({ ...model.emptyStore(), plan }, candidates[0], "done", NOW);
  const lifecycle = { "d:RELIABILITY": { state: "fixing", firstSeen: 0, stateChangedAt: NOW } };
  const status = model.planStatus(plan, candidates.slice(0, 2), store, NOW, { available: ["acquisition", "quality"], lifecycle });
  assert.deepEqual(json(status.map((item) => item.status)), ["done", "open", "resolved", "done"]);
  const unloaded = model.planStatus(plan, [], store, NOW, { available: [] });
  assert.equal(unloaded[1].status, "open", "a scan that has not loaded never resolves items");
}

// Batches group the same fix outside today's list.
{
  const entries = {};
  for (let index = 0; index < 9; index++) entries[`b${index}`] = entry(200 - index * 10, 0, { inputViewers: 3 });
  const candidates = model.buildCandidates({ acquisition: acquisition(entries), now: NOW });
  const { plan } = model.planToday(model.emptyStore(), candidates, NOW, { sources: { acquisition: 1 } });
  const groups = model.batches(candidates, plan);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].fixKey, "a:listing");
  assert.equal(groups[0].items.length, 4, "the 4 Actors not already on today's list");
}

// "One more" only when some Actor is not on the list yet, since the list
// keeps one item per Actor.
{
  const candidates = model.buildCandidates({
    acquisition: acquisition({ x: entry(120, 0, { inputViewers: 3 }), y: entry(110, 0, { inputViewers: 3 }) }),
    now: NOW,
  });
  const { plan } = model.planToday(model.emptyStore(), candidates, NOW, { sources: { acquisition: 1 }, cap: 1 });
  assert.equal(model.canExtend(plan, candidates), true);
  const second = { ...candidates[0], key: "a:promote:x", fixKey: "a:promote" };
  assert.equal(model.canExtend(plan, [candidates[0], second]), false, "only the same Actor's other work is left");
}

// A snooze "until worse" stops counting once the item is back.
{
  const [candidate] = model.buildCandidates({ acquisition: acquisition({ x: entry(120, 0, { inputViewers: 3 }) }), now: NOW });
  const store = model.applyDecision(model.emptyStore(), candidate, "snooze", NOW, { snooze: "worse" });
  assert.equal(model.snoozedCount(store, [candidate], NOW), 1);
  assert.equal(model.snoozedCount(store, [{ ...candidate, users: candidate.users * 2 }], NOW), 0);
  assert.equal(model.snoozedCount(store, [], NOW), 1, "not flagged now: still snoozed");
}

// A Done item stays done when the daily rescan flips it from "fix the
// listing" to "fix the run form": both are the same problem and share a key.
{
  const before = model.buildCandidates({ acquisition: acquisition({ x: entry(120, 0, { inputViewers: 3 }) }), now: NOW });
  const after = model.buildCandidates({ acquisition: acquisition({ x: entry(120, 0, { inputViewers: 70 }) }), now: NOW });
  assert.equal(before[0].kind, "listing");
  assert.equal(after[0].kind, "runform");
  assert.equal(after[0].key, before[0].key);
  const store = model.applyDecision(model.emptyStore(), before[0], "done", NOW);
  assert.equal(model.openCandidates(after, store, NOW + DAY).length, 0, "still done after the rescan");
}

// Today's progress survives a rescan with newer data: handled items stay on
// the list with their status, and only untouched ones are re-picked.
{
  const entries = {};
  for (let index = 0; index < 6; index++) entries[`r${index}`] = entry(200 - index * 10, 0, { inputViewers: 3 });
  const candidates = model.buildCandidates({ acquisition: acquisition(entries), now: NOW });
  let store = model.emptyStore();
  store = { ...store, plan: model.planToday(store, candidates, NOW, { sources: { acquisition: 1 } }).plan };
  store = model.applyDecision(store, candidates[0], "done", NOW);
  store = model.applyDecision(store, candidates[1], "dismiss", NOW);
  // The saved copy round-trips through storage between scans.
  store = model.restoreStore(json(store));
  const open = model.openCandidates(candidates, store, NOW);
  const handled = model.planStatus(store.plan, open, store, NOW, { available: ["acquisition"] })
    .filter((item) => item.status !== "open").map((item) => item.item.key);
  const rebuilt = model.planToday(store, open, NOW + 1000, { sources: { acquisition: 2 }, handled });
  assert.equal(rebuilt.changed, true);
  const status = model.planStatus(rebuilt.plan, open, store, NOW + 1000, { available: ["acquisition"] });
  assert.deepEqual(json(status.slice(0, 2).map((item) => [item.item.actorId, item.status])), [["r0", "done"], ["r1", "dismiss"]]);
}

// Items for Actors the account does not have (a deleted one, or another
// account's in the same browser) leave the list and the gap is refilled.
{
  const candidates = model.buildCandidates({
    acquisition: acquisition({ x: entry(120, 0, { inputViewers: 3 }), y: entry(110, 0, { inputViewers: 3 }) }),
    now: NOW,
  });
  const plan = { day: model.dayKey(NOW), sources: { acquisition: 1 }, items: [{ key: "a:convert:gone", actorId: "gone", source: "acquisition" }] };
  const next = model.planToday({ ...model.emptyStore(), plan }, candidates, NOW, { sources: { acquisition: 1 }, actorIds: new Set(["x", "y"]) });
  assert.equal(next.changed, true);
  assert.deepEqual(json(next.plan.items.map((item) => item.actorId)), ["x", "y"]);
}

// Stores saved before kinds were grouped load under the grouped keys, and
// copies saved under older login tokens merge into one.
{
  const legacy = {
    version: 1,
    plan: { day: "2026-10-20", sources: {}, items: [{ key: "a:listing:x", actorId: "x" }] },
    decisions: { "a:listing:x": { action: "dismiss", at: 1 }, "a:runform:x": { action: "done", at: 5 } },
    log: [{ key: "a:runform:x", action: "done", at: 5 }],
  };
  const restored = model.restoreStore(legacy);
  assert.deepEqual(Object.keys(restored.decisions), ["a:convert:x"]);
  assert.equal(restored.decisions["a:convert:x"].action, "done", "the later decision wins");
  assert.equal(restored.plan.items[0].key, "a:convert:x");
  assert.equal(restored.log[0].key, "a:convert:x");

  const newer = {
    version: 1,
    plan: { day: "2026-10-21", sources: {}, items: [{ key: "a:promote:y", actorId: "y" }] },
    decisions: { "a:convert:x": { action: "snooze", at: 9, until: 99 }, "a:promote:y": { action: "done", at: 7 } },
    log: [{ key: "a:runform:x", action: "done", at: 5 }, { key: "a:promote:y", action: "done", at: 7 }],
  };
  const merged = model.mergeStores([legacy, newer]);
  assert.equal(merged.decisions["a:convert:x"].action, "snooze");
  assert.equal(merged.decisions["a:promote:y"].action, "done");
  assert.deepEqual(json(merged.log.map((entry) => entry.at)), [5, 7], "each logged action once");
  assert.equal(merged.plan.day, "2026-10-21", "the latest day's plan");
  assert.equal(merged.version, 2);
  assert.deepEqual(json(model.mergeStores([merged, legacy, newer])), json(merged), "merging again changes nothing");

  // Two copies that both planned today keep both lists, one item per Actor.
  const day = "2026-10-21";
  const mine = { version: 2, plan: { day, sources: { acquisition: 5 }, items: [{ key: "a:convert:x", actorId: "x" }, { key: "a:promote:y", actorId: "y" }] }, decisions: {}, log: [] };
  const theirs = { version: 2, plan: { day, sources: { acquisition: 9 }, items: [{ key: "a:fading:y", actorId: "y" }, { key: "a:promote:z", actorId: "z" }] }, decisions: {}, log: [] };
  const both = model.mergeStores([mine, theirs]).plan;
  assert.deepEqual(json(both.items.map((item) => item.key)), ["a:convert:x", "a:promote:y", "a:promote:z"]);
  assert.equal(both.sources.acquisition, 9);
}

// The store is shared by an organization's accounts in this browser, so
// the week card and the snoozed count only count this account's Actors.
{
  const [candidate] = model.buildCandidates({ acquisition: acquisition({ x: entry(120, 0, { inputViewers: 3 }) }), now: NOW });
  let store = model.applyDecision(model.emptyStore(), candidate, "done", NOW);
  assert.equal(store.log[0].actorId, "x");
  store.log.push({ key: "q:other:RELIABILITY", action: "done", at: NOW, dollars: 50, users: 3 });
  store.decisions["a:convert:other"] = { action: "snooze", at: NOW, until: NOW + DAY };
  assert.equal(model.weekSummary(store, NOW).done, 2);
  assert.equal(model.weekSummary(store, NOW, new Set(["x"])).done, 1);
  assert.equal(model.snoozedCount(store, [], NOW, new Set(["x"])), 0);
  assert.equal(model.snoozedCount(store, [], NOW, new Set(["other"])), 1);
}

assert.equal(model.restoreStore({ version: 0 }).log.length, 0);
console.log("today tests passed");
