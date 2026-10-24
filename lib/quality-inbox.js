/*
 * Pure model for the Actor quality inbox: work-type grouping, impact ranking,
 * score-change explanations, and the per-suggestion lifecycle. No DOM, no
 * network, no state; content/quality.js owns those.
 */
(function () {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const SNAPSHOT_VERSION = 1;
  // An entry older than this is re-fetched by the next scan.
  const ENTRY_FRESH_MS = DAY_MS;
  // A suggestion counts as New for this long after it first appeared, the
  // same window Apify's own per-Actor quality page uses.
  const NEW_WINDOW_MS = 7 * DAY_MS;
  // The first scan has nothing to compare with, so its suggestions are
  // backdated past the New window instead of flagging the whole account.
  const FIRST_SCAN_BACKDATE_MS = 30 * DAY_MS;
  const CLEARED_RETENTION_MS = 30 * DAY_MS;
  // The saved lifecycle is shared by every account of an organization in
  // this browser, so a record for an Actor missing from this account's list
  // may be another account's. It is kept this long after its last change,
  // then treated as a deleted Actor's.
  const UNLISTED_RETENTION_MS = 180 * DAY_MS;
  const DEFAULT_SNOOZE_MS = 7 * DAY_MS;
  // Month-to-date figures are too noisy to project before this day.
  const PACE_MIN_DAY = 8;
  const MAX_DESCRIPTION_LENGTH = 600;
  // Apify's own quality page shows no score until an Actor has been in the
  // Store this long; before that the scores and suggestions are placeholders.
  const SCORE_DELAY_MS = DAY_MS;

  // Apify's improvement IDs are a closed set; anything new lands in "other".
  const WORK_GROUPS = [
    { key: "security", label: "Security", weight: 5, ids: ["SENSITIVE_PROPERTIES_WITHOUT_SECRET_FLAG", "PERMISSION_LEVEL"] },
    { key: "ops", label: "Operations", weight: 4, ids: ["RELIABILITY", "ISSUE_RESPONSE_TIME"] },
    { key: "schema", label: "Schema", weight: 3, ids: ["HAS_INPUT_SCHEMA", "HAS_OUTPUT_SCHEMA"] },
    { key: "pricing", label: "Pricing", weight: 2, ids: ["ACTOR_START_PRICE", "PPE_PRICING", "PPE_PRIMARY_EVENT", "PPE_PLATFORM_USAGE", "TIERED_PRICING"] },
    {
      key: "listing",
      label: "Listing & docs",
      weight: 1,
      ids: ["NO_README", "README_QUALITY", "TITLE_QUALITY", "DESCRIPTION_QUALITY", "HAS_AVATAR_IMAGE", "INPUT_PROPERTY_DESCRIPTION_QUALITY", "PUBLISH_TASK"],
    },
    { key: "other", label: "Other", weight: 1, ids: [] },
    { key: "market", label: "Market", weight: 0.5, hidden: true, ids: ["RATING", "TOTAL_USERS"] },
  ];
  const GROUP_BY_ID = new Map(WORK_GROUPS.flatMap((group) => group.ids.map((id) => [id, group])));
  const GROUP_BY_KEY = new Map(WORK_GROUPS.map((group) => [group.key, group]));

  const LIFECYCLE_STATES = ["open", "fixing", "snoozed", "dismissed", "cleared"];

  // Sub-scores that explain a quality change. Daily popularity snapshots and
  // revenue percentiles move every day on their own, so they stay out.
  const SCORE_LABELS = {
    actorQuality: "Quality score",
    actorQualityPercentile: "Quality percentile",
    health: "Health",
    runSuccessRate: "Run success rate",
    rating: "Rating",
    integrability: "Integrability",
    issueResponseTime: "Issue response time",
    pricing: "Pricing",
    hasInputSchema: "Input schema",
    hasOutputSchema: "Output schema",
    hasReadme: "README",
    hasAvatarImage: "Avatar image",
    readmeQuality: "README quality",
    inputPropertyDescriptionQuality: "Input field descriptions",
    titleQuality: "Title quality",
    descriptionQuality: "Description quality",
    inputSchemaSecurity: "Input schema security",
    maintenanceFrequency: "Maintenance frequency",
    permissionLevel: "Permission level",
    actorListing: "Store listing",
    isPPEPlatformUsagePaidByUser: "Platform usage paid by user",
  };
  const DRIVER_KEYS = Object.keys(SCORE_LABELS).filter((key) => key !== "actorQuality" && key !== "actorQualityPercentile");
  const QUALITY_CHANGE_MIN = 0.005;
  // A sub-score explains a change from half a point, as sensitive as the
  // overall score: with ~19 weighted sub-scores, a small overall move rarely
  // comes from one big jump. On its own (overall score unchanged) a
  // sub-score must move this much to be worth a row.
  const DRIVER_CHANGE_MIN = 0.005;
  const DRIVER_ONLY_MIN = 0.05;
  // Other Actors being rescored nudges the percentile, so it needs more.
  const PERCENTILE_CHANGE_MIN = 0.02;
  // Yes/no sub-scores, shown as added or removed rather than as numbers.
  const FLAG_KEYS = new Set(["hasInputSchema", "hasOutputSchema", "hasReadme", "hasAvatarImage", "isPPEPlatformUsagePaidByUser"]);
  const MAX_DRIVERS_PER_ACTOR = 3;

  function number(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  function finite(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function groupFor(id) {
    return GROUP_BY_ID.get(id) || GROUP_BY_KEY.get("other");
  }

  function lifecycleKey(actorId, improvementId) {
    return `${actorId}:${improvementId}`;
  }

  // ---- Compact entries -----------------------------------------------------

  function compactScores(scores) {
    if (!scores || typeof scores !== "object") return null;
    const result = {};
    for (const key of Object.keys(SCORE_LABELS)) {
      const raw = scores[key];
      const value = typeof raw === "boolean" ? Number(raw) : finite(raw);
      if (value != null) result[key] = Math.round(value * 10_000) / 10_000;
    }
    return result;
  }

  function trimText(value) {
    const text = String(value || "");
    return text.length > MAX_DESCRIPTION_LENGTH ? `${text.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…` : text;
  }

  // Merges praises-and-improvements and business-value suggestions into one
  // list keyed by improvement ID. Business-value items carry extra detail.
  function mergeImprovements(recommendations, businessValue) {
    const items = [];
    const seen = new Map();
    const businessItems = Array.isArray(businessValue) ? businessValue : Array.isArray(businessValue?.improvements) ? businessValue.improvements : [];
    const all = [
      ...(Array.isArray(recommendations?.improvements) ? recommendations.improvements : []),
      ...businessItems,
    ];
    for (const raw of all) {
      if (!raw || typeof raw !== "object") continue;
      const id = String(raw.id || raw.title || "").trim();
      if (!id) continue;
      const existing = seen.get(id);
      if (existing) {
        if (!existing.detail && raw.descriptionDetail) existing.detail = trimText(raw.descriptionDetail);
        if (existing.valueLift == null && raw.valueLift != null) existing.valueLift = raw.valueLift;
        continue;
      }
      const item = {
        id,
        title: String(raw.title || id),
        description: trimText(raw.description),
        detail: raw.descriptionDetail ? trimText(raw.descriptionDetail) : "",
        valueLift: raw.valueLift ?? null,
      };
      seen.set(id, item);
      items.push(item);
    }
    return items;
  }

  // When the Actor was first published: a timestamp, null when its basic
  // info has no date, or undefined when that info failed to load.
  function publishedAtFrom(basicInfo) {
    if (!basicInfo || typeof basicInfo !== "object") return undefined;
    const timestamp = Date.parse(basicInfo.firstPublishedAt || "");
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  // Why Apify has no real score for this Actor yet, following the rule its
  // own quality page uses: "unpublished" (private, never published), "new"
  // (published under a day ago), or "unscored" (no quality score). Null
  // once the score is real.
  function pendingReason(scores, publishedAt, isPublic, now) {
    if (publishedAt === null && isPublic === false) return "unpublished";
    if (publishedAt != null && now - publishedAt < SCORE_DELAY_MS) return "new";
    if (scores && finite(scores.actorQuality) == null) return "unscored";
    return null;
  }

  // One Actor's scan result, reduced to what the inbox and table read. A
  // pending Actor keeps no scores or suggestions, so its placeholders never
  // reach the inbox, Today, averages, or score changes. Neither does one
  // whose publish date failed to load: it may be a placeholder too, so the
  // entry is failed and the last good data is kept instead.
  function compactEntry(actor, { scores, recommendations, businessValue, basicInfo, publishedAt, failed }, now) {
    const published = publishedAt !== undefined ? publishedAt : publishedAtFrom(basicInfo);
    const pending = published === undefined ? null : pendingReason(scores, published, basicInfo?.isPublic, now);
    const hidden = !!pending || published === undefined;
    const praises = Array.isArray(recommendations?.praises) ? recommendations.praises : [];
    return {
      id: actor.id,
      scores: hidden ? null : compactScores(scores),
      improvements: hidden || !(recommendations || businessValue) ? null : mergeImprovements(recommendations, businessValue),
      praises: hidden ? [] : praises.map((item) => String(item?.title || "")).filter(Boolean).slice(0, 6),
      publishedAt: published ?? null,
      pending,
      failed: !!failed || published === undefined,
      fetchedAt: now,
    };
  }

  // A publish date never changes once set, so later scans reuse it. Actors
  // without one ask again: a private Actor may have been published since.
  function knownPublishedAt(entry) {
    return typeof entry?.publishedAt === "number" ? entry.publishedAt : undefined;
  }

  // Entries saved before publish dates were tracked have no publishedAt key.
  function predatesPublishDates(entry) {
    return !!entry && !("publishedAt" in entry);
  }

  function scoreDue(entry, now) {
    return entry?.pending === "new" && now >= entry.publishedAt + SCORE_DELAY_MS;
  }

  // A saved scan needs a full rescan, before its usual daily one, when it
  // still holds entries from before publish dates were tracked (their
  // placeholders would show) or a new Actor whose real score is now due.
  // Failed entries are left to the retry flow.
  function needsRescan(snapshot, now) {
    return Object.values(snapshot?.entries || {}).some((entry) => entry && !entry.failed && (predatesPublishDates(entry) || scoreDue(entry, now)));
  }

  // `actors` and `traffic` travel with the entries so a warm visit can paint
  // the whole inbox without a single request.
  function emptySnapshot() {
    return { version: SNAPSHOT_VERSION, startedAt: 0, scannedAt: 0, complete: false, entries: {}, actors: [], traffic: {} };
  }

  function restoreSnapshot(data) {
    if (!data || data.version !== SNAPSHOT_VERSION || !data.entries || typeof data.entries !== "object") return emptySnapshot();
    return {
      version: SNAPSHOT_VERSION,
      startedAt: number(data.startedAt),
      scannedAt: number(data.scannedAt),
      complete: !!data.complete,
      entries: { ...data.entries },
      actors: Array.isArray(data.actors) ? data.actors.filter((actor) => actor?.id) : [],
      traffic: data.traffic && typeof data.traffic === "object" ? { ...data.traffic } : {},
    };
  }

  function scoresMap(snapshot) {
    const result = {};
    for (const [id, entry] of Object.entries(snapshot?.entries || {})) {
      if (entry?.scores) result[id] = entry.scores;
    }
    return result;
  }

  // ---- Traffic and ranking -------------------------------------------------

  function monthDays(now) {
    const date = new Date(now);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  }

  // Month-to-date projected to a full month, once enough of it has passed.
  function pace(value, now) {
    const day = new Date(now).getUTCDate();
    if (day < PACE_MIN_DAY) return 0;
    return number(value) * monthDays(now) / day;
  }

  // Merges last month's and this month's actor-breakdown rows (as produced by
  // AAP_PORTFOLIO_MODEL.normalizeRows) into per-Actor traffic.
  function trafficFromRows(previousRows, currentRows) {
    const traffic = {};
    const add = (rows, slot) => {
      for (const row of rows || []) {
        if (!row?.id) continue;
        const target = traffic[row.id] || (traffic[row.id] = { previous: null, current: null });
        target[slot] = {
          revenue: number(row.revenue),
          runs: number(row.runs),
          succeeded: number(row.succeeded),
          payingUsers: number(row.payingUsers),
          users: number(row.payingUsers) + number(row.freeUsers),
        };
      }
    };
    add(previousRows, "previous");
    add(currentRows, "current");
    return traffic;
  }

  // The larger of last month and this month's pace, with its source, so the
  // UI can say "last month" or "pace" instead of a misleading "/mo".
  function revenueForRanking(traffic, now) {
    const previous = number(traffic?.previous?.revenue);
    const projected = pace(traffic?.current?.revenue, now);
    return projected > previous ? { value: projected, basis: "pace" } : { value: previous, basis: previous > 0 ? "last month" : null };
  }

  function trafficWeight(traffic, now) {
    const best = (key) => Math.max(number(traffic?.previous?.[key]), pace(traffic?.current?.[key], now));
    return Math.max(1,
      revenueForRanking(traffic, now).value * 100
      + best("runs") * 0.1
      + best("payingUsers") * 10
      + best("users") * 0.5);
  }

  // Run success from whichever month has runs, preferring this month.
  function successRate(traffic) {
    for (const slot of ["current", "previous"]) {
      const runs = number(traffic?.[slot]?.runs);
      if (runs > 0) return { value: number(traffic[slot].succeeded) / runs, runs, basis: slot === "current" ? "this month" : "last month" };
    }
    return null;
  }

  function rankActors(actors, trafficById, now) {
    return [...actors].sort((left, right) =>
      trafficWeight(trafficById[right.id], now) - trafficWeight(trafficById[left.id], now)
      || String(left.title).localeCompare(String(right.title)));
  }

  // ---- Scan planning -------------------------------------------------------

  function entryIsFresh(entry, now) {
    return !!entry && !entry.failed && now - number(entry.fetchedAt) < ENTRY_FRESH_MS;
  }

  // A quality entry is also re-fetched when it predates publish dates or a
  // new Actor's score is due.
  function qualityEntryIsFresh(entry, now) {
    return entryIsFresh(entry, now) && !predatesPublishDates(entry) && !scoreDue(entry, now);
  }

  // Actors the next scan must fetch, in rank order. A resumed scan skips
  // entries already fetched within the freshness window; a forced one does not.
  function planScan(rankedActors, snapshot, now, { force = false, isFresh = entryIsFresh } = {}) {
    if (force) return rankedActors.slice();
    return rankedActors.filter((actor) => !isFresh(snapshot?.entries?.[actor.id], now));
  }

  // ---- Lifecycle -----------------------------------------------------------

  function effectiveState(record, now) {
    if (!record) return "open";
    if (record.state === "snoozed" && number(record.snoozeUntil) <= now) return "open";
    return LIFECYCLE_STATES.includes(record.state) ? record.state : "open";
  }

  function isNew(record, now) {
    if (!record) return false;
    const state = effectiveState(record, now);
    return state !== "dismissed" && state !== "cleared" && now - number(record.firstSeen) < NEW_WINDOW_MS;
  }

  // Reconciles stored lifecycle records with the latest scan results. Only
  // Actors whose suggestions loaded are touched, so a partial or failed scan
  // never marks anything cleared. `complete` also drops deleted Actors.
  function reconcileLifecycle(store, snapshot, now, { firstScan = false, complete = false, actorIds = null } = {}) {
    const next = { ...(store || {}) };
    for (const [actorId, entry] of Object.entries(snapshot?.entries || {})) {
      if (entry?.pending && !entry.failed) {
        // Records from a pending Actor's placeholder suggestions are dropped,
        // so its real ones start fresh and New. The user's own decisions stay.
        for (const [key, record] of Object.entries(next)) {
          if (key.startsWith(`${actorId}:`) && !DECIDED_STATES.has(record?.state)) delete next[key];
        }
        continue;
      }
      if (!entry || entry.failed || !Array.isArray(entry.improvements)) continue;
      const present = new Set(entry.improvements.map((item) => item.id));
      for (const id of present) {
        const key = lifecycleKey(actorId, id);
        const record = next[key];
        if (!record) {
          next[key] = { state: "open", firstSeen: firstScan ? now - FIRST_SCAN_BACKDATE_MS : now, stateChangedAt: now };
        } else if (record.state === "cleared") {
          // It came back after being resolved: treat it as a new problem.
          next[key] = { state: "open", firstSeen: now, stateChangedAt: now };
        } else if (record.state === "snoozed" && number(record.snoozeUntil) <= now) {
          next[key] = { ...record, state: "open", stateChangedAt: now, snoozeUntil: undefined };
        }
      }
      for (const [key, record] of Object.entries(next)) {
        if (!key.startsWith(`${actorId}:`) || present.has(key.slice(actorId.length + 1))) continue;
        if (record.state !== "cleared") next[key] = { ...record, state: "cleared", stateChangedAt: now, clearedAt: now, clearedFrom: record.state };
      }
    }
    return pruneLifecycle(next, complete ? actorIds : null, now);
  }

  function pruneLifecycle(store, actorIds, now) {
    const listed = actorIds ? new Set(actorIds) : null;
    const next = {};
    for (const [key, record] of Object.entries(store || {})) {
      const actorId = key.slice(0, key.indexOf(":"));
      if (listed && !listed.has(actorId) && now - number(record?.stateChangedAt) > UNLISTED_RETENTION_MS) continue;
      if (record?.state === "cleared" && now - number(record.clearedAt) > CLEARED_RETENTION_MS) continue;
      next[key] = record;
    }
    return next;
  }

  // States only the user sets. A scan writes "open" and "cleared" on its own,
  // so a newer one of those must not undo the user's decision.
  const DECIDED_STATES = new Set(["fixing", "dismissed", "snoozed"]);

  function laterRecord(left, right) {
    if (!left) return right;
    const decided = Number(DECIDED_STATES.has(right?.state)) - Number(DECIDED_STATES.has(left.state));
    if (decided) return decided > 0 ? right : left;
    return number(right?.stateChangedAt) > number(left.stateChangedAt) ? right : left;
  }

  // One lifecycle store from several saved copies: each suggestion keeps the
  // user's latest decision, else its latest record.
  function mergeLifecycles(stores) {
    const merged = {};
    for (const store of stores) {
      for (const [key, record] of Object.entries(store && typeof store === "object" ? store : {})) {
        merged[key] = laterRecord(merged[key], record);
      }
    }
    return merged;
  }

  // A user action on one suggestion. Returns a new store.
  function applyAction(store, actorId, improvementId, action, now, { snoozeMs = DEFAULT_SNOOZE_MS } = {}) {
    const key = lifecycleKey(actorId, improvementId);
    const record = store?.[key] || { state: "open", firstSeen: now, stateChangedAt: now };
    const states = { fix: "fixing", dismiss: "dismissed", snooze: "snoozed", reopen: "open" };
    const state = states[action];
    if (!state) return store;
    const next = { ...record, state, stateChangedAt: now };
    if (state === "snoozed") next.snoozeUntil = now + snoozeMs;
    else delete next.snoozeUntil;
    return { ...(store || {}), [key]: next };
  }

  // ---- Inbox ---------------------------------------------------------------

  function matchesQuery(actor, improvement, query) {
    if (!query) return true;
    return `${actor.title} ${actor.name} ${improvement.title} ${improvement.id}`.toLowerCase().includes(query);
  }

  // Groups every open suggestion by work type, ranked by impact (the work
  // type's weight times the Actor's traffic). Dismissed, snoozed, and cleared
  // suggestions are counted but not listed; fixing ones stay visible.
  function buildInbox(actors, snapshot, store, trafficById, now, { query = "", includeHidden = false } = {}) {
    const needle = query.trim().toLowerCase();
    const hidden = [];
    const groups = new Map(WORK_GROUPS.map((group) => [group.key, { ...group, items: [], actorIds: new Set() }]));
    const counts = { open: 0, fixing: 0, snoozed: 0, dismissed: 0, cleared: 0, new: 0 };
    const actorsWithSuggestions = new Set();
    // Actors with at least one suggestion outside hidden (Market) groups.
    const actorsToFix = new Set();
    for (const actor of actors) {
      const entry = snapshot?.entries?.[actor.id];
      if (!entry || !Array.isArray(entry.improvements)) continue;
      const weight = trafficWeight(trafficById[actor.id], now);
      for (const improvement of entry.improvements) {
        const record = store?.[lifecycleKey(actor.id, improvement.id)];
        const state = effectiveState(record, now);
        counts[state]++;
        if (state === "dismissed" || state === "snoozed") {
          if (includeHidden && matchesQuery(actor, improvement, needle)) hidden.push({ actor, entry, improvement, state, record, isNew: false, impact: 0, traffic: weight, level: "low" });
          continue;
        }
        if (state === "cleared") continue;
        const fresh = isNew(record, now);
        if (fresh) counts.new++;
        actorsWithSuggestions.add(actor.id);
        const group = groups.get(groupFor(improvement.id).key);
        if (!group.hidden) actorsToFix.add(actor.id);
        if (!matchesQuery(actor, improvement, needle)) continue;
        group.items.push({ actor, entry, improvement, state, isNew: fresh, impact: group.weight * weight, traffic: weight });
        group.actorIds.add(actor.id);
      }
    }
    const allItems = [...groups.values()].flatMap((group) => group.items);
    assignImpactLevels(allItems);
    const result = [...groups.values()].map((group) => ({
      key: group.key,
      label: group.label,
      hidden: !!group.hidden,
      actorCount: group.actorIds.size,
      items: group.items.sort((left, right) =>
        right.impact - left.impact
        || Number(right.isNew) - Number(left.isNew)
        || String(left.actor.title).localeCompare(String(right.actor.title))),
    }));
    hidden.sort((left, right) => number(right.record?.stateChangedAt) - number(left.record?.stateChangedAt));
    return {
      groups: result,
      issues: issuesFrom(result),
      hidden,
      counts,
      actorsWithSuggestions: actorsWithSuggestions.size,
      actorsToFix: actorsToFix.size,
    };
  }

  // The same suggestion usually applies to many Actors ("Fix Actor health
  // issues" on 68 of them). Grouping by suggestion shows its text once and
  // lists the Actors under it, ordered by impact; suggestions are ordered by
  // their total impact.
  function issuesFrom(groups) {
    const issues = new Map();
    for (const group of groups) {
      for (const item of group.items) {
        const key = `${group.key}:${item.improvement.id}`;
        let issue = issues.get(key);
        if (!issue) {
          issue = {
            key,
            id: item.improvement.id,
            title: item.improvement.title,
            description: item.improvement.detail || item.improvement.description,
            groupKey: group.key,
            groupLabel: group.label,
            hidden: !!group.hidden,
            items: [],
            impact: 0,
            newCount: 0,
            highCount: 0,
          };
          issues.set(key, issue);
        }
        issue.items.push(item);
        issue.impact += item.impact;
        if (item.isNew) issue.newCount++;
        if (item.level === "high") issue.highCount++;
      }
    }
    return [...issues.values()].sort((left, right) => right.impact - left.impact || right.items.length - left.items.length || left.title.localeCompare(right.title));
  }

  // Impact levels are relative to this account: the top fifth of open
  // suggestions is High, the next 30% Medium. Suggestions on Actors with no
  // traffic at all are always Low.
  function assignImpactLevels(items) {
    const ranked = items.filter((item) => item.traffic > 1).sort((left, right) => right.impact - left.impact);
    const high = Math.ceil(ranked.length * 0.2);
    const medium = Math.ceil(ranked.length * 0.5);
    ranked.forEach((item, index) => {
      item.level = index < high ? "high" : index < medium ? "medium" : "low";
    });
    for (const item of items) item.level = item.level || "low";
  }

  // Per-Actor suggestion summary for the table view.
  function actorSummary(actor, snapshot, store, trafficById, now) {
    const entry = snapshot?.entries?.[actor.id];
    const weight = trafficWeight(trafficById[actor.id], now);
    const open = [];
    let newCount = 0;
    let fixing = 0;
    for (const improvement of Array.isArray(entry?.improvements) ? entry.improvements : []) {
      const record = store?.[lifecycleKey(actor.id, improvement.id)];
      const state = effectiveState(record, now);
      if (state === "dismissed" || state === "snoozed" || state === "cleared") continue;
      if (state === "fixing") fixing++;
      if (isNew(record, now)) newCount++;
      open.push(improvement);
    }
    const impact = open.reduce((sum, item) => sum + groupFor(item.id).weight, 0) * weight;
    return { entry, open, newCount, fixing, impact, groups: [...new Set(open.map((item) => groupFor(item.id).key))] };
  }

  // ---- Score changes -------------------------------------------------------

  // Explains each Actor's quality change since the previous completed scan
  // from the sub-scores that moved most. `reason` says what explains it:
  // "drivers" (sub-scores moved), "recalculated" (every sub-score was in
  // both scans and none moved, so Apify recalculated the score), or
  // "incomplete" (some sub-scores are missing from `missing`: the "before"
  // scan, the "now" scan, or "some" of both).
  function diffScores(actors, snapshot, previousScores) {
    if (!previousScores) return [];
    const movements = [];
    for (const actor of actors) {
      const current = snapshot?.entries?.[actor.id]?.scores;
      const previous = previousScores[actor.id];
      if (!current || !previous) continue;
      const qualityNow = finite(current.actorQuality);
      const qualityBefore = finite(previous.actorQuality);
      const pairs = DRIVER_KEYS
        .map((key) => ({ key, label: SCORE_LABELS[key], flag: FLAG_KEYS.has(key), before: finite(previous[key]), now: finite(current[key]) }))
        .filter((item) => item.before != null || item.now != null);
      const compared = pairs.filter((item) => item.before != null && item.now != null);
      const moved = (item) => Math.abs(item.now - item.before);
      const drivers = compared
        .filter((item) => moved(item) >= DRIVER_CHANGE_MIN)
        .sort((left, right) => moved(right) - moved(left))
        .slice(0, MAX_DRIVERS_PER_ACTOR);
      const qualityDelta = qualityNow != null && qualityBefore != null ? qualityNow - qualityBefore : 0;
      if (Math.abs(qualityDelta) < QUALITY_CHANGE_MIN && !drivers.some((item) => moved(item) >= DRIVER_ONLY_MIN)) continue;
      const percentileBefore = finite(previous.actorQualityPercentile);
      const percentileNow = finite(current.actorQualityPercentile);
      const hasBefore = pairs.some((item) => item.before != null);
      const hasNow = pairs.some((item) => item.now != null);
      movements.push({
        actor,
        before: qualityBefore,
        now: qualityNow,
        delta: qualityDelta,
        drivers,
        reason: drivers.length ? "drivers" : pairs.length && compared.length === pairs.length ? "recalculated" : "incomplete",
        missing: !hasBefore ? "before" : !hasNow ? "now" : compared.length < pairs.length ? "some" : null,
        percentile: percentileBefore != null && percentileNow != null && Math.abs(percentileNow - percentileBefore) >= PERCENTILE_CHANGE_MIN
          ? { before: percentileBefore, now: percentileNow }
          : null,
      });
    }
    return movements.sort((left, right) => left.delta - right.delta || String(left.actor.title).localeCompare(String(right.actor.title)));
  }

  self.AAP_QUALITY_INBOX = {
    WORK_GROUPS,
    LIFECYCLE_STATES,
    SCORE_LABELS,
    ENTRY_FRESH_MS,
    NEW_WINDOW_MS,
    SCORE_DELAY_MS,
    groupFor,
    lifecycleKey,
    compactEntry,
    knownPublishedAt,
    needsRescan,
    predatesPublishDates,
    mergeImprovements,
    emptySnapshot,
    restoreSnapshot,
    scoresMap,
    trafficFromRows,
    revenueForRanking,
    trafficWeight,
    successRate,
    rankActors,
    planScan,
    entryIsFresh,
    qualityEntryIsFresh,
    effectiveState,
    isNew,
    reconcileLifecycle,
    pruneLifecycle,
    mergeLifecycles,
    applyAction,
    buildInbox,
    actorSummary,
    diffScores,
  };
})();
