/*
 * Pure model for the Today page: turns the acquisition and quality scans into
 * one short, ranked list of things worth doing, sized in a single unit
 * (users or dollars a month), plus the daily plan, decisions, and batches.
 * No DOM, no network, no storage; content/today.js owns those.
 */
(function () {
  const ACQ = self.AAP_ACQUISITION_TRIAGE;
  const QUALITY = self.AAP_QUALITY_INBOX;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const STORE_VERSION = 1;
  const DAILY_CAP = 5;
  // A Done item that is still flagged comes back after this long.
  const DONE_QUIET_MS = 14 * DAY_MS;
  // Dismissed and "until it gets worse" items return when what is at stake
  // grows by this factor.
  const WORSE_FACTOR = 1.5;
  const LOG_RETENTION_MS = 60 * DAY_MS;
  // Below this many users a month an item is noise, unless it is urgent.
  const MIN_USERS = 0.5;
  const BATCH_MIN = 3;
  const MAX_BATCHES = 3;
  const SNOOZES = { week: 7 * DAY_MS, month: 30 * DAY_MS };
  // Revenue per user is trusted only from Actors with at least this many users.
  const RPU_MIN_USERS = 5;
  // Share of an Actor's users (or revenue) a quality fix is assumed to win
  // back. Apify does not publish how much the quality score moves traffic,
  // so these only order the suggestions against each other and against the
  // acquisition items; the UI calls the result an estimate.
  const QUALITY_LIFT = { security: 0.1, ops: 0.15, schema: 0.05, pricing: 0.05, listing: 0.05, other: 0.03 };
  // A fading Actor is urgent only when it lost at least this share of its
  // viewers AND real users are at stake; small Actors swing by half often.
  const URGENT_FALL = -0.5;
  const URGENT_MIN_USERS = 5;
  // At most this many items of the same fix make one day's list, so it is
  // not five copies of one task (the rest wait in that fix's batch).
  const MAX_PER_FIX = 2;
  // Below this run success rate (with enough runs) a reliability fix is urgent.
  const URGENT_SUCCESS = 0.9;
  const URGENT_MIN_RUNS = 20;

  // Each kind of work: what to do, how its number reads (what fixing it would
  // gain, what is at risk, or what momentum is worth), and how to start.
  const KINDS = {
    listing: {
      verb: "Fix the listing",
      caption: "if fixed",
      hint: "Most people leave before they open the run form. Rewrite the first screen of the README, the title, and the price line.",
    },
    runform: {
      verb: "Fix the run form",
      caption: "if fixed",
      hint: "People open the run form but don't start it. Make the prefilled input work as is, and give every required field a default.",
    },
    promote: {
      verb: "Promote it",
      caption: "growing",
      hint: "Link it from your related Actors' READMEs, publish a task for its top use case, and share it where its users are.",
    },
    fading: {
      verb: "Investigate the drop",
      caption: "at risk",
      hint: "",
    },
    // A quality suggestion's verb is its own title.
    quality: {
      verb: "",
      caption: "estimate",
      hint: "",
    },
  };

  function number(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  function count(value) {
    return Math.round(number(value)).toLocaleString("en-US");
  }

  function percent(value) {
    const share = Math.abs(value) * 100;
    return `${share < 10 ? share.toFixed(1).replace(/\.0$/, "") : Math.round(share)}%`;
  }

  function median(values) {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  // Local calendar day, so "today" turns over at the user's midnight.
  function dayKey(now) {
    const date = new Date(now);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  // Month-to-date figures scaled to a whole month. The first days are capped
  // so one early visitor is not projected into hundreds.
  function monthFactor(month, now) {
    const start = Date.parse(month);
    if (!Number.isFinite(start)) return 1;
    const date = new Date(start);
    const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    if (now >= end) return 1;
    return 1 / Math.max(0.25, (now - start) / (end - start));
  }

  // The larger of last month and this month's pace for one breakdown figure.
  function monthly(traffic, key, factor) {
    return Math.max(number(traffic?.previous?.[key]), number(traffic?.current?.[key]) * factor);
  }

  // Revenue per user for each Actor with enough users, and the portfolio
  // median as the fallback for the rest.
  function revenuePerUser(trafficById, factor) {
    const own = {};
    for (const [id, traffic] of Object.entries(trafficById || {})) {
      const users = monthly(traffic, "users", factor);
      const revenue = monthly(traffic, "revenue", factor);
      if (users >= RPU_MIN_USERS && revenue > 0) own[id] = revenue / users;
    }
    return { own, fallback: median(Object.values(own)) };
  }

  // Ranks by dollars when the account earns anything, else by users.
  function sized(actorId, users, context, dollarsOverride = null) {
    const rpu = context.rpu.own[actorId] ?? context.rpu.fallback;
    const dollars = dollarsOverride ?? users * rpu;
    const paid = monthly(context.traffic[actorId], "revenue", context.factor) > 0;
    return { users, dollars, paid, score: context.rpu.fallback > 0 ? dollars + users * 1e-3 : users };
  }

  // The account's typical funnel per 100 viewers, from Actors with enough
  // traffic to judge.
  function typicalFunnel(entries, floor) {
    const usable = entries.filter((entry) => entry && entry.viewers >= floor && entry.viewers > 0);
    return {
      input: median(usable.filter((entry) => entry.inputViewers != null).map((entry) => Math.min(1, entry.inputViewers / entry.viewers))) * 100,
      starters: median(usable.map((entry) => Math.min(1, number(entry.starters) / entry.viewers))) * 100,
    };
  }

  function acquisitionCandidate(actor, entry, thresholds, context) {
    const assigned = ACQ.assignBucket(entry, thresholds, { early: context.early });
    const viewers = number(entry.viewers);
    const input = entry.inputViewers;
    const starters = number(entry.starters);
    const rate = assigned.rate ?? 0;
    const funnel = { viewers, input, starters, typical: context.typical };
    const base = { source: "acquisition", actor, funnel, change: assigned.viewerChange };
    const changeLine = (direction) => assigned.viewerChange === "new"
      ? `${count(viewers)} viewers this month, none at this point last month.`
      : `Viewers ${direction} ${percent(assigned.viewerChange)} (${count(entry.prevViewers)} → ${count(viewers)}) vs the same point last month.`;

    if (assigned.key === "leaking") {
      const target = (number(thresholds.conversionLow) + number(thresholds.conversionHigh)) / 2;
      const users = Math.max(0, target - rate) * viewers * context.factor;
      const kind = input != null && viewers > 0 && input / viewers < ACQ.FEW_REACH_INPUT ? "listing" : "runform";
      const why = input == null
        ? `${count(viewers)} opened the listing, ${count(starters)} ran it.`
        : `${count(viewers)} opened the listing, ${count(input)} opened the run form, ${count(starters)} ran it.`;
      return { ...base, kind, why, hint: KINDS[kind].hint, urgent: false, ...sized(actor.id, users, context) };
    }
    if (assigned.key === "rising") {
      let gain = Math.max(0, starters - number(entry.prevStarters));
      if (!gain) gain = Math.max(0, viewers - number(entry.prevViewers)) * rate;
      return { ...base, kind: "promote", why: changeLine("up"), hint: KINDS.promote.hint, urgent: false, ...sized(actor.id, gain * context.factor, context) };
    }
    if (assigned.key === "fading") {
      const previousRate = entry.prevViewers ? Math.min(1, number(entry.prevStarters) / entry.prevViewers) : rate;
      const lostStarters = Math.max(0, number(entry.prevStarters) - starters);
      const lost = Math.max(lostStarters, Math.max(0, number(entry.prevViewers) - viewers) * previousRate);
      // Starters fell about as much as viewers: people stopped finding it.
      // Viewers held but starters fell: something on the page or in the run
      // broke.
      const viewerDrop = entry.prevViewers ? 1 - viewers / entry.prevViewers : 0;
      const starterDrop = entry.prevStarters ? 1 - starters / entry.prevStarters : 0;
      const hint = starterDrop > viewerDrop + 0.2
        ? "Viewers dropped less than runs did, so people still find it but stop starting it. Check recent failed runs, price changes, and new reviews."
        : "Fewer people find it. Check its Store search position, whether it is marked under maintenance, and its title and description.";
      const users = lost * context.factor;
      const urgent = typeof assigned.viewerChange === "number" && assigned.viewerChange <= URGENT_FALL && users >= URGENT_MIN_USERS;
      return { ...base, kind: "fading", why: changeLine("down"), hint, urgent, ...sized(actor.id, users, context) };
    }
    return null;
  }

  // A quality fix is sized as a small share of the Actor's users, so it
  // qualifies on the Actor's own audience: anyone using or paying for it.
  function worthListing(candidate) {
    if (candidate.source === "quality") return candidate.audience >= 1 || candidate.dollars > 0;
    return candidate.users >= MIN_USERS;
  }

  function qualityCandidate(actor, improvement, context) {
    const group = QUALITY.groupFor(improvement.id);
    if (group.hidden) return null;
    const traffic = context.traffic[actor.id];
    const lift = QUALITY_LIFT[group.key] ?? QUALITY_LIFT.other;
    const users = monthly(traffic, "users", context.factor);
    const revenue = monthly(traffic, "revenue", context.factor);
    const success = QUALITY.successRate(traffic);
    let why = users || revenue
      ? `${group.label} suggestion on an Actor with ${count(users)} users${revenue >= 1 ? ` and $${count(revenue)}` : ""} a month.`
      : `${group.label} suggestion from Apify's quality check.`;
    if (group.key === "ops" && success && success.runs > 0) {
      why = `${percent(success.value)} of its ${count(success.runs)} runs ${success.basis} succeeded.`;
    }
    const urgent = group.key === "security"
      || (group.key === "ops" && !!success && success.runs >= URGENT_MIN_RUNS && success.value < URGENT_SUCCESS);
    return {
      source: "quality",
      kind: "quality",
      actor,
      improvementId: improvement.id,
      groupLabel: group.label,
      verb: improvement.title,
      why,
      hint: improvement.detail || improvement.description || "",
      urgent,
      audience: users,
      ...sized(actor.id, users * lift, context, revenue > 0 ? revenue * lift : null),
    };
  }

  function finish(candidate) {
    if (!candidate) return null;
    const key = candidate.source === "quality"
      ? `q:${candidate.actor.id}:${candidate.improvementId}`
      : `a:${candidate.kind}:${candidate.actor.id}`;
    const fixKey = candidate.source === "quality" ? `q:${candidate.improvementId}` : `a:${candidate.kind}`;
    return { ...candidate, key, fixKey, verb: candidate.verb || KINDS[candidate.kind].verb };
  }

  function rankOrder(left, right) {
    return Number(right.urgent) - Number(left.urgent)
      || right.score - left.score
      || String(left.actor.title).localeCompare(String(right.actor.title));
  }

  // Every item worth doing across both scans, ranked. `acquisition` and
  // `quality` may be null when that scan has not run yet.
  function buildCandidates({ acquisition = null, quality = null, traffic = {}, now }) {
    const month = acquisition?.month || `${new Date(now).toISOString().slice(0, 7)}-01T00:00:00.000Z`;
    const factor = monthFactor(month, now);
    const context = { traffic: traffic || {}, factor, rpu: revenuePerUser(traffic, factor), early: ACQ.isEarlyMonth(month, now) };
    const candidates = [];

    if (acquisition?.snapshot) {
      const { snapshot } = acquisition;
      const entries = snapshot.actors.map((actor) => snapshot.entries[actor.id]).filter((entry) => entry && entry.viewers != null);
      const thresholds = acquisition.thresholds || snapshot.thresholds || ACQ.computeThresholds(entries);
      context.typical = typicalFunnel(entries, thresholds.viewerFloor);
      for (const actor of snapshot.actors) {
        const entry = snapshot.entries[actor.id];
        if (!entry || entry.viewers == null) continue;
        candidates.push(finish(acquisitionCandidate(actor, entry, thresholds, context)));
      }
    }

    if (quality?.snapshot) {
      const { snapshot, lifecycle } = quality;
      for (const actor of snapshot.actors) {
        const entry = snapshot.entries[actor.id];
        if (!entry || !Array.isArray(entry.improvements)) continue;
        for (const improvement of entry.improvements) {
          const record = lifecycle?.[QUALITY.lifecycleKey(actor.id, improvement.id)];
          if (QUALITY.effectiveState(record, now) !== "open") continue;
          candidates.push(finish(qualityCandidate(actor, improvement, context)));
        }
      }
    }

    return candidates
      .filter((candidate) => candidate && (candidate.urgent || worthListing(candidate)))
      .sort(rankOrder);
  }

  // ---- Decisions --------------------------------------------------------------

  function emptyStore() {
    return { version: STORE_VERSION, plan: null, decisions: {}, log: [] };
  }

  function restoreStore(data) {
    if (!data || data.version !== STORE_VERSION) return emptyStore();
    return {
      version: STORE_VERSION,
      plan: data.plan && Array.isArray(data.plan.items) ? data.plan : null,
      decisions: data.decisions && typeof data.decisions === "object" ? { ...data.decisions } : {},
      log: Array.isArray(data.log) ? data.log.filter((entry) => entry?.key) : [],
    };
  }

  // Acquisition items Done, snoozed, or dismissed here stay out of the list
  // until their time is up or what is at stake grows. Quality items follow
  // the quality inbox's own lifecycle instead.
  function hiddenByDecision(candidate, decision, now) {
    if (!decision || candidate.source === "quality") return false;
    const worse = candidate.users > number(decision.users) * WORSE_FACTOR;
    if (decision.action === "done") return now - number(decision.at) < DONE_QUIET_MS;
    if (decision.action === "snooze") return decision.until ? now < decision.until : !worse;
    if (decision.action === "dismiss") return !worse;
    return false;
  }

  function openCandidates(candidates, store, now) {
    return candidates.filter((candidate) => !hiddenByDecision(candidate, store?.decisions?.[candidate.key], now));
  }

  // Records a decision on one item. Quality items also need the quality
  // lifecycle updated; the caller does that.
  function applyDecision(store, candidate, action, now, { snooze = "week" } = {}) {
    const next = restoreStore(store);
    const record = { action, at: now, users: candidate.users };
    if (action === "snooze") record.until = snooze === "worse" ? null : now + (SNOOZES[snooze] || SNOOZES.week);
    if (candidate.source !== "quality") next.decisions[candidate.key] = record;
    next.log = [
      ...next.log.filter((entry) => now - number(entry.at) < LOG_RETENTION_MS),
      { key: candidate.key, action, at: now, dollars: candidate.dollars, users: candidate.users, paid: candidate.paid },
    ];
    return next;
  }

  // Undoes today's decision on an item.
  function undoDecision(store, key, now) {
    const next = restoreStore(store);
    delete next.decisions[key];
    const today = dayKey(now);
    next.log = next.log.filter((entry) => entry.key !== key || dayKey(entry.at) !== today);
    return next;
  }

  function todayAction(store, key, now) {
    const today = dayKey(now);
    for (let index = (store?.log || []).length - 1; index >= 0; index--) {
      const entry = store.log[index];
      if (entry.key === key && dayKey(entry.at) === today) return entry.action;
    }
    return null;
  }

  // ---- The daily plan -----------------------------------------------------------

  function planItem(candidate) {
    return {
      key: candidate.key,
      source: candidate.source,
      kind: candidate.kind,
      fixKey: candidate.fixKey,
      actorId: candidate.actor.id,
      title: candidate.actor.title,
      verb: candidate.verb,
      users: candidate.users,
      dollars: candidate.dollars,
      paid: candidate.paid,
      urgent: candidate.urgent,
      improvementId: candidate.improvementId || null,
    };
  }

  // Today's list is chosen once a day and then stays put while scans run,
  // so the order never reshuffles under the user's cursor. Two things
  // rebuild it: a new day, and a scan finishing with newer data than the
  // list was built from (the first scan of a new account, or the daily
  // rescan). A rebuild keeps every item already handled and re-picks only
  // the untouched ones. `extra` adds items when the user asks for one more.
  // One item per Actor keeps the list varied; the rest wait in the batches.
  // `sources` maps each loaded scan to its scannedAt.
  // Whether "one more" can add anything: planToday keeps one item per Actor.
  function canExtend(plan, candidates) {
    const actors = new Set((plan?.items || []).map((item) => item.actorId));
    return candidates.some((candidate) => !actors.has(candidate.actor.id));
  }

  function planToday(store, candidates, now, { sources = {}, handled = [], extra = 0, cap = DAILY_CAP } = {}) {
    const day = dayKey(now);
    const current = store?.plan?.day === day ? store.plan : null;
    const known = current?.sources && !Array.isArray(current.sources) ? current.sources : {};
    const newer = Object.entries(sources).some(([source, scannedAt]) => !(source in known) || scannedAt > known[source]);
    if (current && !newer && !extra) return { plan: current, changed: false };

    const kept = new Set(handled);
    const items = !current ? [] : newer ? current.items.filter((item) => kept.has(item.key)) : current.items.slice();
    const size = current ? Math.max(cap, current.items.length) : cap;
    const taken = new Set(items.map((item) => item.key));
    const actors = new Set(items.map((item) => item.actorId));
    const perFix = new Map();
    for (const item of items) perFix.set(item.fixKey, (perFix.get(item.fixKey) || 0) + 1);
    // First pass keeps the list varied; the second fills any gap when there
    // are too few kinds of work to vary.
    for (const varied of [true, false]) {
      for (const candidate of candidates) {
        if (items.length >= size + extra) break;
        if (taken.has(candidate.key) || actors.has(candidate.actor.id)) continue;
        if (varied && (perFix.get(candidate.fixKey) || 0) >= MAX_PER_FIX) continue;
        items.push(planItem(candidate));
        taken.add(candidate.key);
        actors.add(candidate.actor.id);
        perFix.set(candidate.fixKey, (perFix.get(candidate.fixKey) || 0) + 1);
      }
    }
    return { plan: { day, sources: { ...known, ...sources }, items }, changed: true };
  }

  // Where each item on today's list stands. `available` lists the scans
  // loaded right now, so an item whose scan has not loaded is not mistaken
  // for resolved.
  function planStatus(plan, candidates, store, now, { available = [], lifecycle = null } = {}) {
    const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
    const loaded = new Set(available);
    return (plan?.items || []).map((item) => {
      const candidate = byKey.get(item.key) || null;
      let status = todayAction(store, item.key, now);
      if (!status && item.source === "quality" && lifecycle) {
        const record = lifecycle[QUALITY.lifecycleKey(item.actorId, item.improvementId)];
        const state = QUALITY.effectiveState(record, now);
        if (state === "fixing") status = "done";
        else if (state === "snoozed") status = "snooze";
        else if (state === "dismissed") status = "dismiss";
        else if (state === "cleared") status = "resolved";
      }
      if (!status && !candidate && loaded.has(item.source)) status = "resolved";
      return { item, candidate, status: status || "open" };
    });
  }

  // The same fix across several Actors, outside today's list, biggest first.
  function batches(candidates, plan) {
    const planned = new Set((plan?.items || []).map((item) => item.key));
    const groups = new Map();
    for (const candidate of candidates) {
      if (planned.has(candidate.key)) continue;
      let group = groups.get(candidate.fixKey);
      if (!group) {
        group = { fixKey: candidate.fixKey, verb: candidate.verb, source: candidate.source, items: [], users: 0, dollars: 0, score: 0 };
        groups.set(candidate.fixKey, group);
      }
      group.items.push(candidate);
      group.users += candidate.users;
      group.dollars += candidate.dollars;
      group.score += candidate.score;
    }
    return [...groups.values()]
      .filter((group) => group.items.length >= BATCH_MIN)
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_BATCHES);
  }

  // Snoozes still hiding their item: a dated one until its date, an
  // "until worse" one until the item grows past the factor.
  function snoozedCount(store, candidates, now) {
    const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
    return Object.entries(store?.decisions || {}).filter(([key, decision]) => {
      if (decision.action !== "snooze") return false;
      const candidate = byKey.get(key);
      return candidate ? hiddenByDecision(candidate, decision, now) : !decision.until || now < decision.until;
    }).length;
  }

  // What the last seven days of decisions added up to.
  function weekSummary(store, now) {
    const recent = (store?.log || []).filter((entry) => now - number(entry.at) < 7 * DAY_MS);
    const done = recent.filter((entry) => entry.action === "done");
    return {
      done: done.length,
      handled: recent.length,
      dollars: done.reduce((sum, entry) => sum + number(entry.dollars), 0),
      users: done.reduce((sum, entry) => sum + number(entry.users), 0),
    };
  }

  self.AAP_TODAY_MODEL = {
    DAILY_CAP,
    DONE_QUIET_MS,
    WORSE_FACTOR,
    SNOOZES,
    KINDS,
    dayKey,
    monthFactor,
    revenuePerUser,
    typicalFunnel,
    buildCandidates,
    emptyStore,
    restoreStore,
    hiddenByDecision,
    openCandidates,
    applyDecision,
    undoDecision,
    todayAction,
    canExtend,
    planToday,
    planStatus,
    batches,
    snoozedCount,
    weekSummary,
  };
})();
