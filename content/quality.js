/*
 * Replaces the empty Actor-quality landing state with an account-wide quality
 * inbox and table. One scan fetches every Actor's scores and suggestions,
 * busiest Actors first, and is saved so the next visit paints instantly.
 */
(function () {
  const ROUTE_RE = /^(?:\/organization\/[^/]+)?\/actors\/insights\/actor-quality\/?$/;
  const OVERVIEW_CLASS = "aap-quality-overview-page";
  const HOST_CLASS = "aap-quality-overview";
  const CACHE_CLEAR_KEY = "aap.cacheClearedAt";
  const LIFECYCLE_PREFIX = "aap.qualityLifecycle:";
  const SNAPSHOT_VIEW = "quality-inbox";
  const PREVIOUS_VIEW = "quality-inbox-prev";
  // The busiest Actors are fetched at foreground priority and painted one by
  // one; the long tail runs in the background and paints in batches.
  const FOREGROUND_ACTORS = 50;
  const PERSIST_EVERY = 25;
  // Score changes compare against a scan at least this old, so a manual
  // refresh minutes after the last scan does not erase yesterday's baseline.
  const BASELINE_MIN_AGE_MS = 20 * 60 * 60 * 1000;
  const SCAN_RETRY_MS = 5 * 60 * 1000;
  const VIEW_STORE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  const MODEL = self.AAP_QUALITY_INBOX;
  const VIEW = self.AAP_QUALITY_INBOX_VIEW;
  const TODAY = self.AAP_TODAY_VIEW;

  const initialParams = new URLSearchParams(location.search);
  // Today | Inbox | Table. Today is the default; a link to a specific issue
  // or Actor opens the inbox.
  const VIEWS = { param: "qView", views: ["today", "inbox", "table"], detail: "inbox", deepLinks: ["qIssue", "qActor"] };

  const state = {
    view: window.AAP_INSIGHTS_NAV.initialView(VIEWS, initialParams),
    // The inbox entry in view: an issue key ("ops:RELIABILITY"), "changes",
    // or "hidden". null means the highest-impact issue.
    selection: initialParams.get("qIssue") || null,
    query: "",
    suggestionFilter: "all",
    workType: "all",
    sort: "impact",
    direction: "desc",
    showOriginal: false,
    expandedIssues: new Set(),
    highlightActor: initialParams.get("qActor") || null,
    scope: null,
    // Where the lifecycle is saved: by organization only (see
    // AAP_CONTEXT.decisionScope), so a new login token keeps every decision.
    lifecycleKey: null,
    restoring: false,
    snapshot: MODEL.emptySnapshot(),
    previous: null,
    lifecycle: {},
    scan: { running: false, background: false, total: 0, done: 0, failed: 0 },
    scanAttemptAt: 0,
    error: null,
    requestId: 0,
    scanTag: null,
  };

  let host = null;
  let refs = null;
  let pageThemeSignature = "";
  let qualityTooltip = null;
  let renderTimer = null;

  // After "Clear cache", every open tab reloads; a random delay per tab keeps
  // them from refetching at the same instant.
  let loadBlockedUntil = 0;

  function resetScope() {
    if (state.scanTag) AAP_API.cancel?.(state.scanTag);
    state.requestId++;
    state.scanTag = null;
    state.scope = null;
    state.lifecycleKey = null;
    state.restoring = false;
    state.snapshot = MODEL.emptySnapshot();
    state.previous = null;
    state.lifecycle = {};
    state.scan = { running: false, background: false, total: 0, done: 0, failed: 0 };
    state.scanAttemptAt = 0;
    state.error = null;
  }

  // A tab can stay open while the user logs out or switches accounts. Do not
  // keep showing the previous account's quality data in that case.
  AAP_API.onTokenChange?.(() => {
    resetScope();
    render();
  });

  chrome.storage.onChanged?.addListener((changes, area) => {
    // A decision made in another tab shows here right away; this tab's own
    // writes are skipped, so a late echo never undoes a newer decision.
    const key = area === "local" ? state.lifecycleKey : null;
    const lifecycle = key ? changes[key] : null;
    if (lifecycle && !AAP_LOCAL_STORE.isEcho(key, lifecycle.newValue) && !state.restoring) {
      state.lifecycle = lifecycle.newValue && typeof lifecycle.newValue === "object" ? lifecycle.newValue : {};
      render();
    }
    if (area !== "local" || !changes[CACHE_CLEAR_KEY]) return;
    loadBlockedUntil = Date.now() + Math.random() * 2_000;
    resetScope();
    render();
  });

  function onOverviewRoute() {
    return ROUTE_RE.test(location.pathname) && !new URLSearchParams(location.search).has("actorId");
  }

  function viewScope() {
    return self.AAP_CONTEXT.accountScope();
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function themeVariable(name) {
    for (const element of [document.documentElement, document.body].filter(Boolean)) {
      const value = getComputedStyle(element).getPropertyValue(name).trim();
      if (value) return value;
    }
    return "";
  }

  function opaqueColor(value) {
    return !!value && value !== "transparent" && !/^rgba\([^)]*,\s*0\)$/i.test(value);
  }

  function darkColor(value) {
    const rgb = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (rgb) return Number(rgb[1]) * 0.299 + Number(rgb[2]) * 0.587 + Number(rgb[3]) * 0.114 < 128;
    const hex = value.match(/^#([\da-f]{6})$/i);
    if (hex) {
      const color = hex[1];
      return parseInt(color.slice(0, 2), 16) * 0.299 + parseInt(color.slice(2, 4), 16) * 0.587 + parseInt(color.slice(4), 16) * 0.114 < 128;
    }
    return false;
  }

  function syncPageTheme() {
    const configuredBackground = themeVariable("--color-neutral-background");
    const candidates = [
      document.querySelector('[data-test="main-content"]'),
      document.querySelector("#content"),
      document.body,
      document.documentElement,
    ].filter(Boolean);
    const sampledBackground = candidates.map((element) => getComputedStyle(element).backgroundColor).find(opaqueColor) || "";
    const background = configuredBackground || sampledBackground || (document.body?.classList.contains("theme-dark") ? "#111827" : "#ffffff");
    const dark = darkColor(background);
    const text = themeVariable("--color-neutral-text") || getComputedStyle(document.body || document.documentElement).color || (dark ? "#f9fafb" : "#111827");
    const muted = themeVariable("--color-neutral-text-subtle") || (dark ? "rgba(255,255,255,0.72)" : "rgba(0,0,0,0.62)");
    const border = themeVariable("--color-neutral-border") || (dark ? "rgba(255,255,255,0.24)" : "rgba(0,0,0,0.2)");
    const backgroundMuted = themeVariable("--color-neutral-background-muted") || (dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)");
    const signature = [background, text, muted, border, backgroundMuted].join("|");
    if (signature === pageThemeSignature) return;
    pageThemeSignature = signature;
    const root = document.documentElement;
    root.style.setProperty("--aap-quality-surface", background);
    root.style.setProperty("--aap-quality-text", text);
    root.style.setProperty("--aap-quality-muted", muted);
    root.style.setProperty("--aap-quality-border", border);
    root.style.setProperty("--aap-quality-surface-muted", backgroundMuted);
  }

  function qualityContent() {
    return document.querySelector('[data-test="tabs-content"]') || document.querySelector(".CardlessTab-content");
  }

  function nativeEmptyState() {
    return qualityContent()?.querySelector('[data-test="common-empty-state"]') || null;
  }

  function actorId(actor) {
    return actor?._id || actor?.id || null;
  }

  function normalizeActors(raw) {
    const list = Array.isArray(raw) ? raw : raw?.actors || raw?.items || [];
    const seen = new Set();
    return list
      .map((actor) => ({
        id: actorId(actor),
        name: actor?.name || actorId(actor) || "Unknown actor",
        title: actor?.title || actor?.name || actorId(actor) || "Unknown actor",
        username: actor?.username || "",
        pictureUrl: actor?.pictureUrl || "",
      }))
      .filter((actor) => actor.id && !seen.has(actor.id) && seen.add(actor.id));
  }

  function actorHref(actor) {
    return `${location.pathname}?actorId=${encodeURIComponent(actor.id)}`;
  }

  function currentMonthKey(now = Date.now()) {
    return `${new Date(now).toISOString().slice(0, 7)}-01`;
  }

  // ---- Persistence ----------------------------------------------------------

  function lifecycleStorageKey() {
    return `${LIFECYCLE_PREFIX}${self.AAP_CONTEXT.decisionScope()}`;
  }

  function persistSnapshot() {
    if (!state.scope) return;
    AAP_CACHE.setView?.(SNAPSHOT_VIEW, state.snapshot, state.scope);
  }

  // Lifecycle state lives outside the cache so eviction or "Clear cache"
  // never brings back a suggestion the user dismissed.
  function persistLifecycle() {
    if (!state.lifecycleKey) return;
    AAP_LOCAL_STORE.set(state.lifecycleKey, state.lifecycle);
  }

  async function restore(scope) {
    state.restoring = true;
    const key = state.lifecycleKey;
    const requestId = state.requestId;
    try {
      const [snapshot, previous, lifecycle] = await Promise.all([
        AAP_CACHE.getView?.(SNAPSHOT_VIEW, VIEW_STORE_TTL_MS, scope),
        AAP_CACHE.getView?.(PREVIOUS_VIEW, VIEW_STORE_TTL_MS, scope),
        // Lifecycles saved before were keyed by the login token too
        // (`<key>:<account>`); getMigrated folds them in.
        AAP_LOCAL_STORE.getMigrated(key, `${key}:`, MODEL.mergeLifecycles).catch(() => undefined),
      ]);
      if (requestId !== state.requestId) return;
      if (snapshot?.hit) state.snapshot = MODEL.restoreSnapshot(snapshot.data);
      if (previous?.hit && previous.data?.scores) state.previous = previous.data;
      state.lifecycle = lifecycle && typeof lifecycle === "object" ? lifecycle : {};
    } catch {
      // Restoring is best effort; a scan rebuilds everything.
    } finally {
      if (requestId === state.requestId) {
        state.restoring = false;
        render();
        maybeScan();
      }
    }
  }

  // ---- Scan -----------------------------------------------------------------

  function snapshotIsFresh(now = Date.now()) {
    return state.snapshot.complete && now - state.snapshot.scannedAt < MODEL.ENTRY_FRESH_MS;
  }

  function maybeScan() {
    if (!state.scope || state.restoring || state.scan.running || state.showOriginal) return;
    if (Date.now() < loadBlockedUntil || Date.now() - state.scanAttemptAt < SCAN_RETRY_MS) return;
    if (snapshotIsFresh()) return;
    // A stale complete snapshot is refetched in full; an incomplete one
    // resumes where it stopped.
    const stale = state.snapshot.complete;
    startScan({ force: stale, fresh: stale, background: state.snapshot.actors.length > 0 });
  }

  // Loads the Actor list and last/this month's actor-breakdown, then ranks
  // Actors so the busiest are scanned (and listed) first.
  async function loadContext(options) {
    const { rawActors, traffic } = await window.AAP_INSIGHTS_NAV.loadActorTraffic(options);
    return { actors: MODEL.rankActors(normalizeActors(rawActors), traffic, Date.now()), traffic };
  }

  function settled(result, fallback) {
    return result.status === "fulfilled" ? result.value : fallback;
  }

  function cancelledError(results) {
    return results.find((result) => result.status === "rejected" && /cancelled/i.test(result.reason?.message || ""));
  }

  async function fetchActor(actor, options) {
    const results = await Promise.allSettled([
      AAP_API.actorQualityScores(actor.id, options),
      AAP_API.actorQualityRecommendations(actor.id, options),
      AAP_API.actorQualityBusinessValue(actor.id, options),
    ]);
    const cancelled = cancelledError(results);
    if (cancelled) throw cancelled.reason;
    return {
      scores: settled(results[0], null),
      recommendations: settled(results[1], null),
      businessValue: settled(results[2], null),
      failed: results.some((result) => result.status === "rejected"),
    };
  }

  async function startScan({ force = false, fresh = false, background = false } = {}) {
    if (state.scan.running) return;
    const requestId = ++state.requestId;
    const tag = `quality-scan-${requestId}`;
    const scope = state.scope;
    state.scanTag = tag;
    state.scanAttemptAt = Date.now();
    state.error = null;
    state.scan = { running: true, background, total: 0, done: 0, failed: 0 };
    render();

    const startedFrom = state.snapshot;
    // The scan that just finished becomes the comparison baseline, unless the
    // current baseline is recent (a refresh right after a scan keeps the
    // older baseline so its score changes stay visible).
    const baseline = startedFrom.complete
      && (!state.previous || startedFrom.scannedAt - state.previous.capturedAt >= BASELINE_MIN_AGE_MS)
      ? { capturedAt: startedFrom.scannedAt, scores: MODEL.scoresMap(startedFrom) }
      : null;
    // Until one scan has completed in this scope, suggestions are backdated
    // rather than flagged New, even if the first scan was interrupted.
    const firstScan = !startedFrom.scannedAt;

    try {
      const context = await loadContext({ priority: "foreground", tag, fresh });
      if (requestId !== state.requestId) return;
      const now = Date.now();
      const snapshot = {
        ...state.snapshot,
        startedAt: force || !state.snapshot.startedAt ? now : state.snapshot.startedAt,
        complete: false,
        actors: context.actors,
        traffic: context.traffic,
        entries: { ...state.snapshot.entries },
      };
      state.snapshot = snapshot;
      const plan = MODEL.planScan(context.actors, snapshot, now, { force });
      state.scan.total = plan.length;
      render();

      let sincePersist = 0;
      const onActor = async (actor, priority) => {
        const result = await fetchActor(actor, { priority, tag, fresh });
        if (requestId !== state.requestId) return;
        const previousEntry = snapshot.entries[actor.id];
        const entry = MODEL.compactEntry(actor, result, Date.now());
        // A failed fetch keeps the last good data instead of blanking it.
        snapshot.entries[actor.id] = entry.failed && previousEntry && !previousEntry.failed
          ? { ...previousEntry, failed: true }
          : entry;
        state.scan.done++;
        if (entry.failed) state.scan.failed++;
        if (++sincePersist >= PERSIST_EVERY) {
          sincePersist = 0;
          persistSnapshot();
        }
        scheduleRender(priority === "foreground" ? 0 : 400);
      };

      const segments = [
        [plan.slice(0, FOREGROUND_ACTORS), "foreground"],
        [plan.slice(FOREGROUND_ACTORS), "background"],
      ];
      for (const [actors, priority] of segments) {
        if (!actors.length) continue;
        await AAP_API.pooled(actors, (actor) => onActor(actor, priority), { priority });
        if (requestId !== state.requestId) return;
        state.lifecycle = MODEL.reconcileLifecycle(state.lifecycle, snapshot, Date.now(), { firstScan });
        persistLifecycle();
        persistSnapshot();
        render();
      }

      if (requestId !== state.requestId) return;
      const finishedAt = Date.now();
      const ids = new Set(context.actors.map((actor) => actor.id));
      for (const id of Object.keys(snapshot.entries)) if (!ids.has(id)) delete snapshot.entries[id];
      snapshot.complete = true;
      snapshot.scannedAt = finishedAt;
      state.lifecycle = MODEL.reconcileLifecycle(state.lifecycle, snapshot, finishedAt, { firstScan, complete: true, actorIds: [...ids] });
      persistLifecycle();
      if (baseline && Object.keys(baseline.scores).length) {
        state.previous = baseline;
        AAP_CACHE.setView?.(PREVIOUS_VIEW, baseline, scope);
      }
      persistSnapshot();
    } catch (error) {
      if (requestId !== state.requestId) return;
      if (!/cancelled/i.test(error?.message || "")) {
        state.error = `Couldn't load Actor quality data${error?.message ? `: ${error.message}` : "."}`;
      }
      persistSnapshot();
    } finally {
      if (requestId === state.requestId) {
        state.scan = { ...state.scan, running: false };
        state.scanTag = null;
        render();
      }
    }
  }

  function retryFailed() {
    state.scanAttemptAt = 0;
    startScan({ force: false, fresh: true, background: true });
  }

  function refresh() {
    if (state.scanTag) AAP_API.cancel?.(state.scanTag);
    state.requestId++;
    state.scan = { running: false, background: false, total: 0, done: 0, failed: 0 };
    AAP_API.forceFresh?.();
    startScan({ force: true, fresh: true, background: Object.keys(state.snapshot.entries).length > 0 });
  }

  // ---- Lifecycle actions ------------------------------------------------------

  function onAction(id, improvementId, action, options) {
    state.lifecycle = MODEL.applyAction(state.lifecycle, id, improvementId, action, Date.now(), options);
    persistLifecycle();
    render();
  }

  // ---- URL state --------------------------------------------------------------

  function writeUrlState() {
    const url = new URL(location.href);
    if (window.AAP_INSIGHTS_NAV.writeView(VIEWS, url, state.view)) {
      if (state.selection) url.searchParams.set("qIssue", state.selection);
      else url.searchParams.delete("qIssue");
    }
    if (url.href !== location.href) history.replaceState(history.state, "", url.href);
  }

  function selectEntry(selection) {
    state.selection = selection;
    writeUrlState();
    render();
    host?.querySelector(".aap-quality-inbox-detail")?.scrollIntoView({ block: "nearest" });
  }

  // ---- Shared derivations -------------------------------------------------------

  function actors() {
    return state.snapshot.actors;
  }

  function scannedCount() {
    return actors().filter((actor) => state.snapshot.entries[actor.id]).length;
  }

  function runsFor(actor) {
    const traffic = state.snapshot.traffic[actor.id];
    return Math.max(traffic?.current?.runs || 0, 0);
  }

  // ---- Table ------------------------------------------------------------------

  function number(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function formatInteger(value) {
    return value == null ? "–" : Number(value).toLocaleString("en-US");
  }

  function formatPercent(value) {
    return value == null ? "–" : `${(value * 100).toFixed(1)}%`;
  }

  function formatPercentile(value) {
    if (value == null) return "–";
    return `${(value * 100).toFixed(1)}th percentile`;
  }

  function plainText(value) {
    if (!value) return "";
    const parsed = new DOMParser().parseFromString(String(value), "text/html");
    return parsed.body.textContent.replace(/\s+/g, " ").trim();
  }

  function showQualityTooltip(target, text) {
    if (!text || !document.body) return;
    if (!qualityTooltip) {
      qualityTooltip = createElement("div", "aap-quality-tooltip");
      qualityTooltip.id = "aap-quality-tooltip";
      qualityTooltip.setAttribute("role", "tooltip");
      document.body.appendChild(qualityTooltip);
    }
    qualityTooltip.textContent = text;
    qualityTooltip.style.display = "block";
    const targetRect = target.getBoundingClientRect();
    const tooltipRect = qualityTooltip.getBoundingClientRect();
    const gap = 8;
    let left = targetRect.left;
    let top = targetRect.bottom + gap;
    if (left + tooltipRect.width > window.innerWidth - gap) left = window.innerWidth - tooltipRect.width - gap;
    if (top + tooltipRect.height > window.innerHeight - gap) top = targetRect.top - tooltipRect.height - gap;
    qualityTooltip.style.left = `${Math.max(gap, left)}px`;
    qualityTooltip.style.top = `${Math.max(gap, top)}px`;
  }

  function hideQualityTooltip() {
    if (qualityTooltip) qualityTooltip.style.display = "none";
  }

  // One row per Actor, joined with its scan entry, lifecycle summary, traffic
  // and a relative impact level (top fifth High, next 30% Medium).
  function tableRows(now) {
    const rows = actors().map((actor) => {
      const summary = MODEL.actorSummary(actor, state.snapshot, state.lifecycle, state.snapshot.traffic, now);
      return {
        actor,
        entry: summary.entry,
        summary,
        traffic: state.snapshot.traffic[actor.id],
        revenue: MODEL.revenueForRanking(state.snapshot.traffic[actor.id], now),
        success: MODEL.successRate(state.snapshot.traffic[actor.id]),
      };
    });
    const ranked = rows.filter((row) => row.summary.open.length && row.summary.impact > row.summary.open.length).sort((left, right) => right.summary.impact - left.summary.impact);
    const high = Math.ceil(ranked.length * 0.2);
    const medium = Math.ceil(ranked.length * 0.5);
    ranked.forEach((row, index) => {
      row.level = index < high ? "high" : index < medium ? "medium" : "low";
    });
    for (const row of rows) row.level = row.level || (row.summary.open.length ? "low" : null);
    return rows;
  }

  function sortValue(row) {
    if (state.sort === "name") return row.actor.title.toLowerCase();
    if (state.sort === "quality") return number(row.entry?.scores?.actorQuality) ?? -1;
    if (state.sort === "improvements") return row.summary.open.length;
    if (state.sort === "revenue") return row.revenue.value;
    if (state.sort === "runs") return runsFor(row.actor);
    return row.summary.impact;
  }

  function filteredRows(rows) {
    const query = state.query.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      const count = row.summary.open.length;
      if (state.suggestionFilter === "with" && count === 0) return false;
      if (state.suggestionFilter === "without" && count > 0) return false;
      if (state.workType !== "all" && !row.summary.groups.includes(state.workType)) return false;
      if (!query) return true;
      const suggestions = row.summary.open.map((item) => `${item.title} ${item.id}`).join(" ");
      return `${row.actor.title} ${row.actor.name} ${suggestions}`.toLowerCase().includes(query);
    });
    const direction = state.direction === "asc" ? 1 : -1;
    return filtered.sort((left, right) => {
      const a = sortValue(left);
      const b = sortValue(right);
      const result = typeof a === "string" ? a.localeCompare(b) : a - b;
      return (result * direction) || left.actor.title.localeCompare(right.actor.title);
    });
  }

  function actorCell(actor, total) {
    const cell = createElement("td", "aap-quality-actor-cell");
    if (total) {
      const text = createElement("span", "aap-quality-actor-name");
      text.append(createElement("strong", null, "All actors"), createElement("small", null, "Account total"));
      cell.appendChild(text);
      return cell;
    }
    const link = document.createElement("a");
    link.className = "aap-quality-actor-link";
    link.href = actorHref(actor);
    link.title = "Open Apify's detailed Actor quality view";
    if (actor.pictureUrl) {
      const image = document.createElement("img");
      image.src = actor.pictureUrl;
      image.alt = "";
      image.loading = "lazy";
      link.appendChild(image);
    }
    const text = createElement("span", "aap-quality-actor-name");
    text.append(createElement("strong", null, actor.title), createElement("small", null, actor.name));
    link.appendChild(text);
    cell.appendChild(link);
    return cell;
  }

  function qualityCell(score, detail, failed) {
    const cell = createElement("td", "aap-quality-score");
    if (score == null) {
      cell.appendChild(createElement("span", "aap-quality-empty", failed ? "Unavailable" : "–"));
      return cell;
    }
    const meter = createElement("span", "aap-quality-meter");
    const fill = createElement("span", "aap-quality-meter-fill");
    fill.style.width = `${Math.max(0, Math.min(100, score * 100))}%`;
    meter.appendChild(fill);
    cell.append(createElement("strong", null, formatPercent(score)), meter, createElement("small", null, detail));
    return cell;
  }

  function setupCell(scores) {
    const cell = createElement("td", "aap-quality-setup");
    const badges = createElement("span", "aap-quality-setup-list");
    for (const [label, present] of [["Input", scores?.hasInputSchema], ["Output", scores?.hasOutputSchema], ["README", scores?.hasReadme]]) {
      const badge = createElement("span", `aap-quality-badge ${present ? "aap-quality-badge-good" : "aap-quality-badge-missing"}`, label);
      badge.title = present ? `${label} available` : `${label} missing`;
      badges.appendChild(badge);
    }
    cell.appendChild(badges);
    return cell;
  }

  function suggestionsCell(row) {
    const cell = createElement("td", "aap-quality-insights aap-quality-improvements");
    const items = row.summary.open;
    if (!items.length) {
      cell.appendChild(createElement("span", "aap-quality-empty", row.entry?.improvements ? "None" : "–"));
      return cell;
    }
    const list = createElement("span", "aap-quality-insight-list");
    items.forEach((item, index) => {
      const description = plainText(item.detail || item.description);
      const insight = createElement("span", "aap-quality-insight-item", item.title);
      if (description) {
        insight.tabIndex = 0;
        insight.setAttribute("aria-label", `${item.title}: ${description}`);
        insight.setAttribute("aria-describedby", "aap-quality-tooltip");
        insight.addEventListener("mouseenter", () => showQualityTooltip(insight, description));
        insight.addEventListener("mouseleave", hideQualityTooltip);
        insight.addEventListener("focus", () => showQualityTooltip(insight, description));
        insight.addEventListener("blur", hideQualityTooltip);
      }
      list.appendChild(insight);
      if (index < items.length - 1) list.appendChild(createElement("span", "aap-quality-insight-separator", " · "));
    });
    cell.appendChild(list);
    const status = [];
    if (row.summary.newCount) status.push(`${row.summary.newCount} new`);
    if (row.summary.fixing) status.push(`${row.summary.fixing} fixing`);
    if (status.length) cell.appendChild(createElement("small", "aap-quality-row-status", status.join(" · ")));
    return cell;
  }

  function impactCell(level) {
    const cell = createElement("td", "aap-quality-impact");
    if (!level) {
      cell.appendChild(createElement("span", "aap-quality-empty", "–"));
      return cell;
    }
    const tone = { high: "bad", medium: "warning", low: "neutral" }[level];
    cell.appendChild(createElement("span", `aap-portfolio-signal aap-portfolio-signal-${tone}`, level[0].toUpperCase() + level.slice(1)));
    return cell;
  }

  function valueCell(value, detail) {
    const cell = createElement("td", "aap-quality-metric");
    cell.append(createElement("strong", null, value), createElement("small", null, detail));
    return cell;
  }

  function skeletonCell(className, width) {
    const cell = createElement("td", className);
    const value = createElement("span", "aap-skeleton aap-skeleton-strong");
    value.style.setProperty("--aap-skeleton-width", `${width}px`);
    const detail = createElement("span", "aap-skeleton");
    detail.style.setProperty("--aap-skeleton-width", `${Math.round(width * 0.7)}px`);
    cell.append(value, detail);
    return cell;
  }

  function tableRow(row) {
    const element = document.createElement("tr");
    if (!row.entry) {
      element.className = "aap-quality-row-loading";
      if (state.scan.running) {
        element.setAttribute("aria-busy", "true");
        element.append(actorCell(row.actor), ...[44, 110, 120, 40, 50, 40, 44].map((width) => skeletonCell("aap-quality-metric", width)));
      } else {
        const cell = createElement("td", "aap-quality-empty", "Not scanned yet");
        cell.colSpan = 7;
        element.append(actorCell(row.actor), cell);
      }
      return element;
    }
    if (row.entry.failed) element.className = "aap-quality-row-partial";
    const scores = row.entry.scores;
    element.append(
      actorCell(row.actor),
      qualityCell(number(scores?.actorQuality), formatPercentile(number(scores?.actorQualityPercentile)), row.entry.failed),
      setupCell(scores),
      suggestionsCell(row),
      impactCell(row.level),
      valueCell(row.revenue.basis ? VIEW.formatMoney(row.revenue.value) : "–", row.revenue.basis || "no revenue"),
      valueCell(formatInteger(runsFor(row.actor)), "runs this month"),
      valueCell(row.success ? formatPercent(row.success.value) : "–", row.success ? `success ${row.success.basis}` : "no runs"),
    );
    return element;
  }

  function totalRow(rows) {
    const scanned = rows.filter((row) => row.entry?.scores);
    const scores = scanned.map((row) => number(row.entry.scores.actorQuality)).filter((value) => value != null);
    const setupReady = scanned.filter((row) => row.entry.scores.hasInputSchema && row.entry.scores.hasOutputSchema && row.entry.scores.hasReadme).length;
    const suggestions = rows.reduce((sum, row) => sum + row.summary.open.length, 0);
    const revenue = rows.reduce((sum, row) => sum + row.revenue.value, 0);
    const runs = rows.reduce((sum, row) => sum + runsFor(row.actor), 0);
    const succeeded = rows.reduce((sum, row) => sum + (state.snapshot.traffic[row.actor.id]?.current?.succeeded || 0), 0);
    const element = document.createElement("tr");
    const setup = createElement("td", "aap-quality-setup");
    setup.append(createElement("strong", null, `${setupReady}/${rows.length}`), createElement("small", null, "Actors fully set up"));
    const suggestionCell = createElement("td", "aap-quality-insights aap-quality-improvements");
    suggestionCell.append(createElement("strong", null, formatInteger(suggestions)), createElement("small", null, "open suggestions"));
    element.append(
      actorCell(null, true),
      qualityCell(scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null, "average", false),
      setup,
      suggestionCell,
      impactCell(null),
      valueCell(VIEW.formatMoney(revenue), "last month or pace"),
      valueCell(formatInteger(runs), "runs this month"),
      valueCell(runs ? formatPercent(succeeded / runs) : "–", "success this month"),
    );
    return element;
  }

  function appendTableHeader(table) {
    const head = document.createElement("thead");
    const row = document.createElement("tr");
    for (const label of ["Actor", "Quality", "Setup", "Suggestions", "Impact", "Revenue", "Runs", "Success"]) {
      const header = createElement("th", null, label);
      if (label === "Setup") header.title = "Checks whether the Actor has an input schema, output schema, and README.";
      if (label === "Impact") header.title = "Suggestion weight (security and reliability first) times the Actor's revenue, runs, and users.";
      if (label === "Revenue") header.title = "The larger of last month's revenue and this month's projected pace.";
      row.appendChild(header);
    }
    head.appendChild(row);
    table.appendChild(head);
  }

  function renderTable(now) {
    const rows = tableRows(now);
    const visible = filteredRows(rows);
    hideQualityTooltip();
    refs.totalBody.replaceChildren();
    if (rows.some((row) => row.entry)) refs.totalBody.appendChild(totalRow(rows));
    refs.body.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement("tr");
      const cell = createElement("td", "aap-quality-table-empty", state.error ? "No quality data available." : actors().length ? "No Actors match this filter." : "Loading Actors…");
      cell.colSpan = 8;
      empty.appendChild(cell);
      refs.body.appendChild(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const row of visible) fragment.appendChild(tableRow(row));
    refs.body.appendChild(fragment);
  }

  // ---- Rendering --------------------------------------------------------------

  function scheduleRender(delay) {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
    }, delay);
  }

  function render() {
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    if (!refs) return;
    const now = Date.now();
    const total = actors().length;
    const scanned = scannedCount();
    refs.summary.textContent = total ? `${total.toLocaleString("en-US")} Actors` : "";
    VIEW.renderProgress(refs.progress, state.scan, state.snapshot, now);
    const failedCount = actors().filter((actor) => state.snapshot.entries[actor.id]?.failed).length;
    refs.status.replaceChildren();
    if (state.error) refs.status.appendChild(createElement("span", null, state.error));
    else if (!state.scan.running && failedCount) {
      refs.status.appendChild(createElement("span", null, `${failedCount} ${failedCount === 1 ? "Actor" : "Actors"} could not be fully loaded; showing their last known data.`));
      const retry = createElement("button", "aap-quality-more", "Retry failed");
      retry.type = "button";
      retry.addEventListener("click", retryFailed);
      refs.status.appendChild(retry);
    }
    refs.refresh.disabled = state.scan.running && !state.scan.background;
    refs.tabs.forEach((tab) => {
      const active = tab.dataset.view === state.view;
      tab.setAttribute("aria-pressed", String(active));
      tab.classList.toggle("aap-insights-nav-view-button-active", active);
    });
    refs.today.hidden = state.view !== "today";
    refs.inbox.hidden = state.view !== "inbox";
    refs.tableArea.hidden = state.view !== "table";
    refs.tableControls.hidden = state.view !== "table";
    refs.search.hidden = state.view === "today";

    if (state.view === "today") {
      TODAY.render(refs.today, { source: "quality", live: todayInput });
    } else if (state.view === "inbox") {
      const inbox = MODEL.buildInbox(actors(), state.snapshot, state.lifecycle, state.snapshot.traffic, now, { query: state.query, includeHidden: state.selection === "hidden" });
      const qualities = actors().map((actor) => state.snapshot.entries[actor.id]?.scores?.actorQuality).filter((value) => typeof value === "number");
      VIEW.renderInbox(refs.inbox, {
        inbox,
        now,
        snapshot: state.snapshot,
        scannedCount: scanned,
        scanning: state.scan.running,
        error: state.error,
        query: state.query,
        movements: state.previous ? MODEL.diffScores(actors(), state.snapshot, state.previous.scores) : [],
        previousCapturedAt: state.previous?.capturedAt || 0,
        selection: state.selection,
        averageQuality: qualities.length ? qualities.reduce((sum, value) => sum + value, 0) / qualities.length : null,
        expandedIssues: state.expandedIssues,
        highlightActor: state.highlightActor,
        actorHref,
        revenueFor: (actor) => MODEL.revenueForRanking(state.snapshot.traffic[actor.id], now),
        runsFor,
      }, {
        onAction,
        onSelect: selectEntry,
        onToggleIssue: (key) => {
          if (state.expandedIssues.has(key)) state.expandedIssues.delete(key);
          else state.expandedIssues.add(key);
          render();
        },
      });
      applyDeepLink();
    } else {
      renderTable(now);
    }
    if (total && !state.scan.running) window.AAP_INSIGHTS_NAV?.prefetchOtherTabs?.("quality");
  }

  // The Today page reads this page's live scan and writes decisions through
  // the same lifecycle actions as the inbox.
  function todayInput() {
    return {
      quality: { snapshot: state.snapshot, lifecycle: state.lifecycle, onAction },
      traffic: state.snapshot.traffic,
      scan: { running: state.scan.running && !state.snapshot.scannedAt, done: state.scan.done, total: state.scan.total },
    };
  }

  // qActor from the URL scrolls to that Actor's first suggestion once the
  // scan has settled.
  function applyDeepLink() {
    if (!host || !state.highlightActor || state.scan.running) return;
    const target = host.querySelector(`[data-actor-id="${CSS.escape(state.highlightActor)}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    state.highlightActor = null;
  }

  function setView(view) {
    if (state.view === view) return;
    state.view = view;
    writeUrlState();
    render();
  }

  function syncView() {
    const active = onOverviewRoute();
    document.documentElement.classList.toggle(OVERVIEW_CLASS, active && !state.showOriginal);
    host?.classList.toggle("aap-quality-original-mode", state.showOriginal);
    // Only the page in view shows its toggle; a late render elsewhere
    // removes it instead.
    if (active) window.AAP_INSIGHTS_NAV?.ensureViewToggle("quality", state.showOriginal ? "original" : "custom", setViewMode);
    else window.AAP_INSIGHTS_NAV?.removeViewToggle("quality");
  }

  function setViewMode(mode) {
    state.showOriginal = mode === "original";
    syncView();
    maybeScan();
  }

  function select(label, options, value, onChange, className) {
    const element = document.createElement("select");
    if (className) element.className = className;
    element.setAttribute("aria-label", label);
    for (const [optionValue, optionLabel] of options) {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = optionLabel;
      element.appendChild(option);
    }
    element.value = value;
    element.addEventListener("change", () => onChange(element.value));
    return element;
  }

  function createHost() {
    host = createElement("section", HOST_CLASS);
    host.setAttribute("aria-label", "Actor quality overview");

    const header = createElement("div", "aap-quality-header");
    const heading = createElement("div");
    heading.append(
      createElement("h2", null, "Actor quality overview"),
      createElement("p", null, "What needs your attention across all your Actors, busiest first."),
    );
    const summary = createElement("span", "aap-quality-summary");
    const progress = createElement("div", "aap-quality-inbox-progress");
    progress.setAttribute("aria-live", "polite");
    const side = createElement("div", "aap-quality-header-side");
    side.append(summary, progress);
    header.append(heading, side);

    const controls = createElement("div", "aap-quality-controls aap-insights-controls");
    // Same segmented control as the Original/Plus toggle in the tab bar.
    const tabList = createElement("div", "aap-insights-nav-view-toggle aap-quality-view-toggle");
    tabList.setAttribute("role", "group");
    tabList.setAttribute("aria-label", "Quality view");
    const tabs = [["today", "Today"], ["inbox", "Inbox"], ["table", "Table"]].map(([view, label]) => {
      const tab = createElement("button", "aap-insights-nav-view-button", label);
      tab.type = "button";
      tab.dataset.view = view;
      tab.addEventListener("click", () => setView(view));
      tabList.appendChild(tab);
      return tab;
    });
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Filter Actors or suggestions";
    search.setAttribute("aria-label", "Filter Actors or suggestions");
    search.value = state.query;
    search.addEventListener("input", () => {
      state.query = search.value;
      render();
    });

    const tableControls = createElement("span", "aap-quality-table-controls");
    const suggestionFilter = select("Filter Actors by suggestions", [["all", "All Actors"], ["with", "With suggestions"], ["without", "Without suggestions"]], state.suggestionFilter, (value) => {
      state.suggestionFilter = value;
      render();
    }, "aap-quality-suggestion-filter");
    const workType = select("Filter Actors by work type", [["all", "All work types"], ...MODEL.WORK_GROUPS.map((group) => [group.key, group.label])], state.workType, (value) => {
      state.workType = value;
      render();
    });
    const sort = select("Sort Actors by", [["impact", "Sort by Impact"], ["quality", "Sort by Quality"], ["improvements", "Sort by Suggestions"], ["revenue", "Sort by Revenue"], ["runs", "Sort by Runs"], ["name", "Sort by Name"]], state.sort, (value) => {
      state.sort = value;
      render();
    });
    const order = createElement("button", "aap-quality-order", state.direction === "asc" ? "↑ Asc" : "↓ Desc");
    order.type = "button";
    order.setAttribute("aria-label", "Toggle sort direction");
    order.title = "Switch between descending and ascending order";
    order.addEventListener("click", () => {
      state.direction = state.direction === "asc" ? "desc" : "asc";
      order.textContent = state.direction === "asc" ? "↑ Asc" : "↓ Desc";
      render();
    });
    tableControls.append(suggestionFilter, workType, sort, order);

    const refreshButton = createElement("button", "aap-quality-refresh", "Refresh");
    refreshButton.type = "button";
    refreshButton.title = "Fetch every Actor's quality data again";
    refreshButton.addEventListener("click", refresh);
    controls.append(tabList, search, tableControls, refreshButton);

    const status = createElement("div", "aap-quality-status");
    const today = createElement("div", "aap-today-pane");
    const inbox = createElement("div", "aap-quality-inbox");

    function tableShell(label, bodyKey) {
      const section = createElement("section", `aap-quality-table-section aap-table-section ${bodyKey === "totalBody" ? "aap-table-section-total" : "aap-table-section-rows"}`);
      section.setAttribute("aria-label", label);
      const shell = createElement("div", "aap-quality-table-shell aap-table-shell");
      const scroll = createElement("div", "aap-quality-table-scroll");
      const table = document.createElement("table");
      table.className = "aap-quality-table";
      table.setAttribute("aria-label", `${label} quality data`);
      appendTableHeader(table);
      const body = document.createElement("tbody");
      table.appendChild(body);
      scroll.appendChild(table);
      shell.appendChild(scroll);
      section.appendChild(shell);
      section[bodyKey] = body;
      return section;
    }
    const tableArea = createElement("div", "aap-quality-table-area");
    const totalSection = tableShell("All actors", "totalBody");
    const actorsSection = tableShell("Actors", "body");
    tableArea.append(totalSection, actorsSection);

    host.append(header, controls, status, today, inbox, tableArea);
    refs = {
      summary,
      progress,
      status,
      search,
      today,
      inbox,
      tableArea,
      tableControls,
      tabs,
      refresh: refreshButton,
      totalBody: totalSection.totalBody,
      body: actorsSection.body,
    };
    syncView();
    return host;
  }

  self.AAP_PREFETCH = self.AAP_PREFETCH || {};
  self.AAP_PREFETCH.quality = () => {
    const month = currentMonthKey();
    const previous = self.AAP_PORTFOLIO_MODEL?.previousMonthKey?.(month);
    return Promise.all([
      AAP_API.actorList({ priority: "background" }),
      AAP_API.actorBreakdown(month, [], { priority: "background" }).catch(() => null),
      previous ? AAP_API.actorBreakdown(previous, [], { priority: "background" }).catch(() => null) : null,
    ]);
  };

  function ensureHost() {
    if (!onOverviewRoute()) return;
    syncPageTheme();
    const content = qualityContent();
    if (!content) return;
    syncView();
    const empty = nativeEmptyState();
    let created = false;
    if (!host || !host.isConnected || host.parentElement !== content) {
      host?.remove();
      host = createHost();
      content.appendChild(host);
      created = true;
    }
    if (empty) empty.dataset.aapQualityNative = "hidden";
    if (created) render();
    // The scope (organization plus signed-in account) is known only once the
    // page has made its first authenticated request.
    if (!AAP_API.hasToken?.()) return;
    const scope = viewScope();
    if (state.scope !== scope) {
      resetScope();
      state.scope = scope;
      state.lifecycleKey = lifecycleStorageKey();
      render();
      restore(scope);
      return;
    }
    maybeScan();
  }

  function removeHost() {
    // Leaving the page stops the scan; what it fetched so far is kept and the
    // next visit resumes from there.
    if (state.scan.running) {
      if (state.scanTag) AAP_API.cancel?.(state.scanTag);
      state.requestId++;
      state.scanTag = null;
      state.scan = { ...state.scan, running: false };
      state.scanAttemptAt = 0;
      persistSnapshot();
    }
    document.documentElement.classList.remove(OVERVIEW_CLASS);
    window.AAP_INSIGHTS_NAV?.removeViewToggle("quality");
    hideQualityTooltip();
    host?.remove();
    host = null;
    refs = null;
  }

  const poll = setInterval(() => {
    if (onOverviewRoute()) ensureHost();
    else removeHost();
  }, 400);
  window.addEventListener("beforeunload", () => clearInterval(poll));
})();
