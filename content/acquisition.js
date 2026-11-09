/*
 * Replaces the single-selection acquisition view with an account-wide triage
 * and table. The triage scans every Actor once a day, busiest first, sorts
 * each into a bucket (Leaking, Rising, ...), and is saved so the next visit
 * paints instantly. The table keeps the original page-by-page loading and
 * reuses the triage scan's rows when they exist.
 */
(function () {
  const ROUTE_RE = /^(?:\/organization\/[^/]+)?\/actors\/insights\/acquisition\/?$/;
  const OVERVIEW_CLASS = "aap-acquisition-overview-page";
  const HOST_CLASS = "aap-acquisition-overview";
  const ACTOR_PAGE_SIZE = 25;
  const CACHE_CLEAR_KEY = "aap.cacheClearedAt";
  const SNAPSHOT_VIEW = "acquisition-triage";
  const PREVIOUS_VIEW = "acquisition-triage-prev";
  // The busiest Actors are fetched at foreground priority and painted one by
  // one; the long tail runs in the background and paints in batches.
  const FOREGROUND_ACTORS = 50;
  const PERSIST_EVERY = 25;
  // Bucket changes compare against a scan at least this old, so a manual
  // refresh minutes after a scan never compares the day with itself.
  const BASELINE_MIN_AGE_MS = 20 * 60 * 60 * 1000;
  const SCAN_RETRY_MS = 5 * 60 * 1000;
  const VIEW_STORE_TTL_MS = 40 * 24 * 60 * 60 * 1000;

  const MODEL = self.AAP_ACQUISITION_TRIAGE;
  const VIEW = self.AAP_ACQUISITION_TRIAGE_VIEW;
  // Ranking, traffic, and scan planning are shared with the quality inbox.
  const QUALITY = self.AAP_QUALITY_INBOX;

  // Matches lib/api.js's cacheTtl(): current-month data settles quickly and
  // is worth re-checking every minute; historical months are effectively
  // final, so re-check them far less often.
  const CURRENT_MONTH_REFRESH_TTL_MS = 60 * 1000;
  const HISTORICAL_REFRESH_TTL_MS = 15 * 60 * 1000;

  const initialParams = new URLSearchParams(location.search);
  // Today | Triage | Table. Today is the default; a link to a specific
  // bucket or Actor opens the triage.
  const VIEWS = { param: "aView", views: ["today", "triage", "table"], detail: "triage", deepLinks: ["aBucket", "aActor"] };

  // Today and Triage both read the triage scan; Table reads the month's rows.
  function usesTriage(view) {
    return view !== "table";
  }

  const state = {
    view: window.AAP_INSIGHTS_NAV.initialView(VIEWS, initialParams),
    // The triage entry in view: a bucket key or "movers". null means the
    // changes since yesterday, else the most urgent non-empty bucket.
    selection: initialParams.get("aBucket") || null,
    highlightActor: initialParams.get("aActor") || null,
    expanded: new Set(),
    triage: emptyTriage(),
    actors: [],
    rows: [],
    total: null,
    totalPrevious: null,
    monthStartAt: null,
    query: "",
    sort: "viewers",
    direction: "desc",
    showOriginal: false,
    loading: false,
    error: null,
    completed: 0,
    detailLoading: false,
    totalLoaded: false,
    requestId: 0,
    loadedAt: 0,
    organization: null,
  };

  let host = null;
  let refs = null;
  let pageThemeSignature = "";
  let renderTimer = null;

  function emptyTriage() {
    return {
      scope: null,
      month: null,
      restoring: false,
      snapshot: MODEL.emptySnapshot(),
      previous: null,
      scan: { running: false, background: false, total: 0, done: 0, failed: 0 },
      scanAttemptAt: 0,
      error: null,
      requestId: 0,
      tag: null,
    };
  }

  function resetTriage() {
    if (state.triage.tag) AAP_API.cancel?.(state.triage.tag);
    const requestId = state.triage.requestId + 1;
    state.triage = { ...emptyTriage(), requestId };
  }

  AAP_API.onTokenChange?.(() => {
    // A tab can stay open while the user logs out or switches accounts. Do
    // not keep showing the previous account's acquisition data in that case.
    resetTriage();
    state.requestId++;
    state.loading = false;
    state.detailLoading = false;
    state.monthStartAt = null;
    state.total = null;
    state.totalPrevious = null;
    state.totalLoaded = false;
    state.actors = [];
    state.rows = [];
    state.loadedAt = 0;
    state.organization = null;
  });

  // After "Clear cache", every open tab reloads; a random delay per tab keeps
  // them from refetching at the same instant.
  let loadBlockedUntil = 0;

  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes[CACHE_CLEAR_KEY]) return;
    loadBlockedUntil = Date.now() + Math.random() * 2_000;
    resetTriage();
    state.requestId++;
    state.loading = false;
    state.detailLoading = false;
    state.monthStartAt = null;
    state.total = null;
    state.totalPrevious = null;
    state.totalLoaded = false;
    state.actors = [];
    state.rows = [];
    state.loadedAt = 0;
    state.organization = null;
    render();
  });

  // A closed-and-reopened tab loses all in-memory state, so on a fresh page
  // load there is otherwise no way to avoid a full reload even for data that
  // was just fetched a minute ago. Paint the last durably-cached table for
  // the currently selected month immediately, then let ensureHost()'s normal
  // TTL/silent-refresh path (see beginLoad()) decide whether to quietly
  // bring it up to date.
  //
  // ensureHost() waits on restoreSettled before it will trigger a load.
  // Without this, its 400ms poll starts firing as soon as the page's DOM
  // exists, which is usually faster than AAP_API.whenReady() below (that
  // needs the page to make its own first authenticated request) - so the
  // poll would reliably win the race and call beginLoad() for real before
  // this restore ever got to check the durable cache.
  let restoreSettled = false;
  (async () => {
    try {
      await AAP_API.whenReady?.();
      if (state.requestId) return;
      const month = monthStartAt();
      const cached = await AAP_CACHE.getView("acquisition", refreshTtl(month), viewScope(month));
      if (!cached.hit || state.requestId) return;
      state.monthStartAt = month;
      state.organization = organizationScope();
      state.actors = cached.data.actors || [];
      state.rows = cached.data.rows || [];
      state.total = cached.data.total ?? null;
      state.totalPrevious = cached.data.totalPrevious ?? null;
      state.totalLoaded = cached.data.totalLoaded ?? false;
      state.requestId = 1;
      state.loadedAt = cached.updatedAt;
      render();
    } catch {
      // Best effort only; ensureHost() still triggers a normal load either way.
    } finally {
      restoreSettled = true;
    }
  })();

  function onOverviewRoute() {
    return ROUTE_RE.test(location.pathname) && !new URLSearchParams(location.search).has("actorId") && (self.AAP_FEATURES?.enabled("acquisition") ?? true);
  }

  // Hides the native page as soon as the feature switches are read.
  self.AAP_FEATURES?.onChange(() => {
    if (onOverviewRoute()) document.documentElement.classList.add(OVERVIEW_CLASS);
  });

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
    root.style.setProperty("--aap-acquisition-surface", background);
    root.style.setProperty("--aap-acquisition-text", text);
    root.style.setProperty("--aap-acquisition-muted", muted);
    root.style.setProperty("--aap-acquisition-border", border);
    root.style.setProperty("--aap-acquisition-surface-muted", backgroundMuted);
  }

  function acquisitionContent() {
    return document.querySelector('[data-test="tabs-content"]') || document.querySelector(".CardlessTab-content");
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
        pictureUrl: actor?.pictureUrl || "",
      }))
      .filter((actor) => actor.id && !seen.has(actor.id) && seen.add(actor.id));
  }

  function monthStartAt() {
    const period = new URLSearchParams(location.search).get("timePeriod");
    if (/^\d{4}-\d{2}$/.test(period || "")) return `${period}-01T00:00:00.000Z`;
    return currentCalendarMonthStartAt();
  }

  function organizationScope() {
    return self.AAP_CONTEXT?.organizationKey?.() || "personal";
  }

  function viewScope(month) {
    return `${organizationScope()}:${month}:${AAP_API.authScope?.() || ""}`;
  }

  function monthLabel(value) {
    return value ? new Date(value).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" }) : "selected month";
  }

  function currentCalendarMonthStartAt() {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01T00:00:00.000Z`;
  }

  function refreshTtl(month) {
    return month === currentCalendarMonthStartAt() ? CURRENT_MONTH_REFRESH_TTL_MS : HISTORICAL_REFRESH_TTL_MS;
  }

  function previousMonthStartAt(value) {
    const date = new Date(value);
    date.setUTCMonth(date.getUTCMonth() - 1);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01T00:00:00.000Z`;
  }

  // Apify compares the selected month with the same elapsed portion of the
  // previous month when the selected month is still in progress. Historical
  // months are compared in full. This must be passed to the previous-month
  // request or the percentage will be calculated against the wrong baseline.
  function comparisonPortion(month) {
    const selected = new Date(month);
    const now = new Date();
    if (
      selected.getUTCFullYear() !== now.getUTCFullYear()
      || selected.getUTCMonth() !== now.getUTCMonth()
    ) return 1;
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    return Math.min(1, Math.max(0, (now.getUTCDate() - 1) / daysInMonth));
  }

  function number(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function metric(row, key) {
    return number(row?.data?.[key]);
  }

  function change(row, key) {
    const current = metric(row, key);
    const previous = number(row?.previous?.[key]);
    if (current == null || previous == null) return null;
    if (previous === 0) return current === 0 ? 0 : "new";
    return (current - previous) / previous;
  }

  function formatTrafficPercent(value) {
    const percent = number(value);
    return percent == null ? "–" : `${percent.toFixed(2)}%`;
  }

  function formatChange(value) {
    if (value === "new") return "↑ new";
    if (value == null) return "–";
    if (value === 0) return "→ 0.0%";
    return `${value > 0 ? "↑" : "↓"} ${Math.abs(value * 100).toFixed(1)}%`;
  }

  async function loadActor(actor, month, previousMonth, portion) {
    const results = await Promise.allSettled([
      AAP_API.acquisitionData(month, [actor.id], { priority: "foreground" }),
      AAP_API.acquisitionData(previousMonth, [actor.id], { portionOfMonthElapsed: portion, priority: "foreground" }),
    ]);
    return {
      actor,
      data: results[0].status === "fulfilled" ? results[0].value : null,
      previous: results[1].status === "fulfilled" ? results[1].value : null,
      failed: results.some((result) => result.status === "rejected"),
      loaded: true,
    };
  }

  async function loadActorRows(actors, month, previousMonth, portion, requestId, silent) {
    const completedBefore = state.completed;
    const rows = await AAP_API.pooled(
      actors,
      (actor) => loadActor(actor, month, previousMonth, portion),
      (completed) => {
        if (requestId !== state.requestId || silent) return;
        state.completed = completedBefore + completed;
        render();
      },
      { priority: silent ? "background" : "foreground" },
    );
    return rows.map((row, index) => row || {
      actor: actors[index],
      data: null,
      previous: null,
      failed: true,
      loaded: true,
    });
  }

  function placeholderRow(actor) {
    return { actor, data: null, previous: null, failed: false, loaded: false, loading: true };
  }

  function mergeRows(rows) {
    const byId = new Map(state.rows.map((row) => [row.actor.id, row]));
    for (const row of rows || []) byId.set(row.actor.id, row);
    state.rows = state.actors.filter((actor) => byId.has(actor.id)).map((actor) => byId.get(actor.id));
  }

  function ensureRows(actors) {
    const existing = new Set(state.rows.map((row) => row.actor.id));
    state.rows.push(...actors.filter((actor) => !existing.has(actor.id)).map(placeholderRow));
    const order = new Map(state.actors.map((actor, index) => [actor.id, index]));
    state.rows.sort((left, right) => order.get(left.actor.id) - order.get(right.actor.id));
  }

  function actorMatches(actor, query) {
    return `${actor.title} ${actor.name}`.toLowerCase().includes(query.trim().toLowerCase());
  }

  async function loadActors(actors, month, previousMonth, portion, requestId, silent = false) {
    if (!actors.length || state.detailLoading) return;
    state.detailLoading = true;
    ensureRows(actors);
    if (!silent) render();
    try {
      const rows = await loadActorRows(actors, month, previousMonth, portion, requestId, silent);
      if (requestId !== state.requestId) return;
      mergeRows(rows);
      AAP_CACHE.setView?.("acquisition", {
        actors: state.actors,
        rows: state.rows,
        total: state.total,
        totalPrevious: state.totalPrevious,
        totalLoaded: state.totalLoaded,
      }, viewScope(month));
    } finally {
      if (requestId === state.requestId) {
        state.detailLoading = false;
        render();
      }
    }
  }

  // Scrolling near the end of the table loads the next page of Actors.
  let autoLoadTimer = null;
  function autoLoadMore() {
    if (!refs?.sentinel || state.view !== "table" || state.loading || state.detailLoading || state.showOriginal || state.query.trim()) return;
    if (coveredIds().size >= state.actors.length) return;
    if (!window.AAP_INSIGHTS_NAV?.sentinelNearViewport?.(refs.sentinel)) return;
    loadMoreActors(false).then(() => queueAutoLoad()).catch(() => {});
  }

  function queueAutoLoad() {
    clearTimeout(autoLoadTimer);
    autoLoadTimer = setTimeout(autoLoadMore, 300);
  }

  self.AAP_PREFETCH = self.AAP_PREFETCH || {};
  self.AAP_PREFETCH.acquisition = () => {
    const month = currentCalendarMonthStartAt();
    const breakdownMonth = month.slice(0, 10);
    const previousBreakdownMonth = self.AAP_PORTFOLIO_MODEL?.previousMonthKey?.(breakdownMonth);
    return Promise.allSettled([
      AAP_API.actorList({ priority: "background" }),
      // The triage ranks its scan by these; the Portfolio uses them too.
      AAP_API.actorBreakdown(breakdownMonth, [], { priority: "background" }),
      previousBreakdownMonth ? AAP_API.actorBreakdown(previousBreakdownMonth, [], { priority: "background" }) : null,
      AAP_API.acquisitionData(month, [], { priority: "background" }),
      AAP_API.acquisitionData(previousMonthStartAt(month), [], { portionOfMonthElapsed: comparisonPortion(month), priority: "background" }),
    ]);
  };

  async function loadMoreActors(loadAll = false) {
    if (state.detailLoading || !state.actors.length || !state.monthStartAt) return;
    const requestId = state.requestId;
    const loadedIds = coveredIds();
    const remaining = state.actors.filter((actor) => !loadedIds.has(actor.id));
    const portion = comparisonPortion(state.monthStartAt);
    if (!remaining.length) return;
    if (loadAll) {
      for (let index = 0; index < remaining.length; index += ACTOR_PAGE_SIZE) {
        if (requestId !== state.requestId) return;
        await loadActors(remaining.slice(index, index + ACTOR_PAGE_SIZE), state.monthStartAt, previousMonthStartAt(state.monthStartAt), portion, requestId);
      }
    } else {
      await loadActors(remaining.slice(0, ACTOR_PAGE_SIZE), state.monthStartAt, previousMonthStartAt(state.monthStartAt), portion, requestId);
    }
  }

  async function loadSearchMatches() {
    if (state.view !== "table" || state.detailLoading || !state.query.trim() || !state.actors.length) return;
    const loadedIds = coveredIds();
    const matches = state.actors.filter((actor) => actorMatches(actor, state.query) && !loadedIds.has(actor.id));
    if (!matches.length) return;
    await loadActors(matches, state.monthStartAt, previousMonthStartAt(state.monthStartAt), comparisonPortion(state.monthStartAt), state.requestId);
  }

  // ---- Triage scan ------------------------------------------------------------

  // The triage snapshot for the month the table shows, if one is loaded.
  function triageSnapshotFor(month) {
    return month && state.triage.month === month && state.triage.scope ? state.triage.snapshot : null;
  }

  // Table rows: rows the table loaded itself, plus every other Actor the
  // triage scan already has, so the table never refetches scanned Actors.
  function displayRows() {
    const snapshot = triageSnapshotFor(state.monthStartAt);
    if (!snapshot) return state.rows;
    const byId = new Map(state.rows.map((row) => [row.actor.id, row]));
    for (const actor of state.actors) {
      const entry = snapshot.entries[actor.id];
      if (byId.get(actor.id)?.loaded || !entry || entry.viewers == null) continue;
      byId.set(actor.id, MODEL.tableRow(actor, entry));
    }
    return state.actors.filter((actor) => byId.has(actor.id)).map((actor) => byId.get(actor.id));
  }

  function coveredIds() {
    return new Set(displayRows().map((row) => row.actor.id));
  }

  function persistTriage() {
    if (!state.triage.scope) return;
    AAP_CACHE.setView?.(SNAPSHOT_VIEW, state.triage.snapshot, state.triage.scope);
  }

  async function restoreTriage(scope) {
    const triage = state.triage;
    triage.restoring = true;
    const requestId = triage.requestId;
    try {
      const [snapshot, previous] = await Promise.all([
        AAP_CACHE.getView?.(SNAPSHOT_VIEW, VIEW_STORE_TTL_MS, scope),
        AAP_CACHE.getView?.(PREVIOUS_VIEW, VIEW_STORE_TTL_MS, scope),
      ]);
      if (requestId !== state.triage.requestId) return;
      if (snapshot?.hit) triage.snapshot = MODEL.restoreSnapshot(snapshot.data);
      // An older baseline format kept buckets, not counts; it is dropped and
      // the next day's scan starts a new one.
      if (previous?.hit && MODEL.isBaseline(previous.data)) triage.previous = previous.data;
    } catch {
      // Restoring is best effort; a scan rebuilds everything.
    } finally {
      if (requestId === state.triage.requestId) {
        triage.restoring = false;
        render();
        maybeScanTriage();
      }
    }
  }

  function triageIsFresh(now = Date.now()) {
    const { snapshot } = state.triage;
    return snapshot.complete && now - snapshot.scannedAt < MODEL.ENTRY_FRESH_MS;
  }

  function maybeScanTriage() {
    const triage = state.triage;
    if (!triage.scope || triage.restoring || triage.scan.running || state.showOriginal || !usesTriage(state.view)) return;
    // Today covers this month only; an older month's scan would never show.
    if (state.view === "today" && triage.month !== currentCalendarMonthStartAt()) return;
    if (Date.now() < loadBlockedUntil || Date.now() - triage.scanAttemptAt < SCAN_RETRY_MS) return;
    if (triageIsFresh()) return;
    // A stale complete snapshot is refetched in full; an incomplete one
    // resumes where it stopped.
    const stale = triage.snapshot.complete;
    startTriageScan({ force: stale, fresh: stale, background: triage.snapshot.actors.length > 0 });
  }

  // Loads the Actor list and last/this month's actor-breakdown (usually warm
  // from the Portfolio or Quality pages), then ranks Actors so the busiest
  // are scanned first.
  async function loadTriageContext(options) {
    const { rawActors, traffic } = await window.AAP_INSIGHTS_NAV.loadActorTraffic(options);
    return { actors: QUALITY.rankActors(normalizeActors(rawActors), traffic, Date.now()), traffic };
  }

  function settled(result, fallback) {
    return result.status === "fulfilled" ? result.value : fallback;
  }

  // Two requests per Actor: the month and the same elapsed portion of the
  // previous month. On the first day there is no elapsed portion, so the
  // comparison request is skipped rather than reading back zeros.
  async function fetchAcquisition(actor, month, portion, options) {
    const requests = [AAP_API.acquisitionData(month, [actor.id], options)];
    if (portion > 0) requests.push(AAP_API.acquisitionData(previousMonthStartAt(month), [actor.id], { ...options, portionOfMonthElapsed: portion }));
    const results = await Promise.allSettled(requests);
    const cancelled = results.find((result) => result.status === "rejected" && /cancelled/i.test(result.reason?.message || ""));
    if (cancelled) throw cancelled.reason;
    return {
      data: settled(results[0], null),
      previous: results[1] ? settled(results[1], null) : null,
      failed: results.some((result) => result.status === "rejected"),
    };
  }

  function actorEntries(snapshot) {
    return snapshot.actors.map((actor) => snapshot.entries[actor.id]).filter(Boolean);
  }

  // While a scan runs, buckets use the last complete scan's thresholds so
  // they do not shift as each Actor arrives; a first scan has none yet, so
  // its buckets are provisional until it finishes.
  function triageThresholds() {
    const { snapshot, scan } = state.triage;
    if (scan.running && snapshot.thresholds) return { thresholds: snapshot.thresholds, provisional: false };
    return { thresholds: MODEL.computeThresholds(actorEntries(snapshot)), provisional: scan.running };
  }

  function triageEarly(now = Date.now()) {
    return MODEL.isEarlyMonth(state.triage.month, now);
  }

  async function startTriageScan({ force = false, fresh = false, background = false } = {}) {
    const triage = state.triage;
    if (triage.scan.running) return;
    const requestId = ++triage.requestId;
    const tag = `acquisition-scan-${requestId}`;
    const { scope, month } = triage;
    triage.tag = tag;
    triage.scanAttemptAt = Date.now();
    triage.error = null;
    triage.scan = { running: true, background, total: 0, done: 0, failed: 0 };
    render();

    const startedFrom = triage.snapshot;
    // The previous complete scan becomes the comparison baseline once it is
    // about a day old, so a refresh minutes after a scan never compares the
    // day with itself. It is saved now so changes show while this scan runs,
    // and survive an interrupted scan.
    if (startedFrom.complete
      && triage.scanAttemptAt - startedFrom.scannedAt >= BASELINE_MIN_AGE_MS
      && startedFrom.scannedAt > (triage.previous?.capturedAt || 0)) {
      triage.previous = MODEL.baselineFrom(startedFrom, { early: MODEL.isEarlyMonth(month, startedFrom.scannedAt) });
      AAP_CACHE.setView?.(PREVIOUS_VIEW, triage.previous, scope);
    }

    try {
      const { actors, traffic } = await loadTriageContext({ priority: "foreground", tag, fresh });
      if (requestId !== state.triage.requestId) return;
      const now = Date.now();
      const portion = comparisonPortion(month);
      const snapshot = {
        ...triage.snapshot,
        startedAt: force || !triage.snapshot.startedAt ? now : triage.snapshot.startedAt,
        complete: false,
        actors,
        traffic,
        entries: { ...triage.snapshot.entries },
      };
      triage.snapshot = snapshot;
      const plan = QUALITY.planScan(actors, snapshot, now, { force });
      triage.scan.total = plan.length;
      render();

      let sincePersist = 0;
      const onActor = async (actor, priority) => {
        const result = await fetchAcquisition(actor, month, portion, { priority, tag, fresh });
        if (requestId !== state.triage.requestId) return;
        const previousEntry = snapshot.entries[actor.id];
        const entry = MODEL.compactEntry(result, Date.now());
        // A failed fetch keeps the last good data instead of blanking it.
        snapshot.entries[actor.id] = entry.failed && previousEntry && previousEntry.viewers != null
          ? { ...previousEntry, failed: true }
          : entry;
        triage.scan.done++;
        if (entry.failed) triage.scan.failed++;
        if (++sincePersist >= PERSIST_EVERY) {
          sincePersist = 0;
          persistTriage();
        }
        scheduleRender(priority === "foreground" ? 0 : 400);
      };

      const segments = [
        [plan.slice(0, FOREGROUND_ACTORS), "foreground"],
        [plan.slice(FOREGROUND_ACTORS), "background"],
      ];
      for (const [list, priority] of segments) {
        if (!list.length) continue;
        await AAP_API.pooled(list, (actor) => onActor(actor, priority), { priority });
        if (requestId !== state.triage.requestId) return;
        persistTriage();
        render();
      }

      const ids = new Set(actors.map((actor) => actor.id));
      for (const id of Object.keys(snapshot.entries)) if (!ids.has(id)) delete snapshot.entries[id];
      snapshot.complete = true;
      snapshot.scannedAt = Date.now();
      snapshot.thresholds = MODEL.computeThresholds(actorEntries(snapshot));
      persistTriage();
    } catch (error) {
      if (requestId !== state.triage.requestId) return;
      if (!/cancelled/i.test(error?.message || "")) {
        triage.error = AAPF.loadError("acquisition data", error);
      }
      persistTriage();
    } finally {
      if (requestId === state.triage.requestId) {
        triage.scan = { ...triage.scan, running: false };
        triage.tag = null;
        render();
      }
    }
  }

  function retryTriageFailed() {
    state.triage.scanAttemptAt = 0;
    startTriageScan({ force: false, fresh: true, background: true });
  }

  function refreshTriage() {
    const triage = state.triage;
    if (!triage.scope) return;
    if (triage.tag) AAP_API.cancel?.(triage.tag);
    triage.requestId++;
    triage.tag = null;
    triage.scan = { running: false, background: false, total: 0, done: 0, failed: 0 };
    startTriageScan({ force: true, fresh: true, background: Object.keys(triage.snapshot.entries).length > 0 });
  }

  // ---- URL state ----------------------------------------------------------------

  function writeUrlState() {
    const url = new URL(location.href);
    if (window.AAP_INSIGHTS_NAV.writeView(VIEWS, url, state.view)) {
      if (state.selection) url.searchParams.set("aBucket", state.selection);
      else url.searchParams.delete("aBucket");
    }
    if (url.href !== location.href) history.replaceState(history.state, "", url.href);
  }

  function selectEntry(selection) {
    state.selection = selection;
    writeUrlState();
    render();
    host?.querySelector(".aap-quality-inbox-detail")?.scrollIntoView({ block: "nearest" });
  }

  function actorHref(actor) {
    const url = new URL(location.href);
    for (const key of ["aView", "aBucket", "aActor"]) url.searchParams.delete(key);
    url.searchParams.set("actorId", actor.id);
    return `${url.pathname}${url.search}`;
  }

  // aActor from the URL opens that Actor's bucket and scrolls to it once the
  // scan has settled.
  function applyDeepLink() {
    if (!host || !state.highlightActor || state.triage.scan.running) return;
    const target = host.querySelector(`.aap-acquisition-triage [data-actor-id="${CSS.escape(state.highlightActor)}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    state.highlightActor = null;
  }

  function triageTotals() {
    if (!state.totalLoaded || state.monthStartAt !== state.triage.month || !state.total) return null;
    const comparable = comparisonPortion(state.monthStartAt) > 0 && state.totalPrevious;
    return {
      viewers: number(state.total.numUniqueViewingUsers),
      prevViewers: comparable ? number(state.totalPrevious.numUniqueViewingUsers) : null,
      starters: number(state.total.numUniqueUsersWithRun),
      prevStarters: comparable ? number(state.totalPrevious.numUniqueUsersWithRun) : null,
    };
  }

  function renderTriagePane(now) {
    const triage = state.triage;
    const { snapshot } = triage;
    const { thresholds, provisional } = triageThresholds();
    const early = triageEarly(now);
    const result = MODEL.buildTriage(snapshot.actors, snapshot, thresholds, { early, query: state.query });
    const movers = MODEL.diffBuckets(snapshot.actors, snapshot, thresholds, triage.previous, { early, query: state.query });
    let selection = state.selection;
    if (!selection && state.highlightActor) {
      selection = result.buckets.find((bucket) => bucket.items.some((item) => item.actor.id === state.highlightActor))?.key || null;
    }
    VIEW.renderTriage(refs.triage, {
      triage: result,
      thresholds,
      provisional,
      early,
      movers,
      baselineAt: triage.previous?.capturedAt || 0,
      selection,
      expanded: state.expanded,
      query: state.query,
      scanning: triage.scan.running,
      error: triage.error,
      totals: triageTotals(),
      highlightActor: state.highlightActor,
      actorHref,
    }, {
      onSelect: selectEntry,
      onToggle: (key) => {
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        render();
      },
    });
    applyDeepLink();
  }

  // Bucket per Actor for the table's chips and Bucket sort.
  function tableBuckets() {
    const snapshot = triageSnapshotFor(state.monthStartAt);
    if (!snapshot) return new Map();
    const { thresholds } = triageThresholds();
    const early = triageEarly();
    const result = new Map();
    for (const actor of state.actors) {
      const entry = snapshot.entries[actor.id];
      if (entry && entry.viewers != null) result.set(actor.id, MODEL.assignBucket(entry, thresholds, { early }).key);
    }
    return result;
  }

  function formatInteger(value) {
    return value == null ? "–" : Number(value).toLocaleString("en-US");
  }

  function originLabel(origin) {
    return origin || "Direct / unknown";
  }

  function actorCell(actor, total, bucket) {
    const cell = createElement("td", "aap-acquisition-actor-cell");
    if (total) {
      const text = createElement("span", "aap-acquisition-actor-name");
      text.append(createElement("strong", null, "All actors"), createElement("small", null, "account total"));
      cell.appendChild(text);
      return cell;
    }
    const link = document.createElement("a");
    link.className = "aap-acquisition-actor-link";
    const url = new URL(location.href);
    url.searchParams.set("actorId", actor.id);
    link.href = `${url.pathname}${url.search}`;
    link.title = "Open Apify's detailed acquisition view";
    if (actor.pictureUrl) {
      const image = document.createElement("img");
      image.src = actor.pictureUrl;
      image.alt = "";
      image.loading = "lazy";
      link.appendChild(image);
    }
    const text = createElement("span", "aap-acquisition-actor-name");
    text.append(createElement("strong", null, actor.title), createElement("small", null, actor.name));
    if (bucket) text.appendChild(VIEW.bucketSignal(bucket));
    link.appendChild(text);
    cell.appendChild(link);
    return cell;
  }

  function skeleton(width, strong = false) {
    const bar = createElement("span", strong ? "aap-skeleton aap-skeleton-strong" : "aap-skeleton");
    bar.style.setProperty("--aap-skeleton-width", `${width}px`);
    return bar;
  }

  function metricCell(row, key, sublabel) {
    const cell = createElement("td", "aap-acquisition-metric");
    if (row.loading) {
      cell.append(skeleton(44, true), skeleton(36), skeleton(64));
      return cell;
    }
    const delta = change(row, key);
    const changeLabel = createElement("small", `aap-acquisition-change ${delta === "new" || (delta != null && delta > 0) ? "aap-acquisition-change-positive" : delta != null && delta < 0 ? "aap-acquisition-change-negative" : ""}`, formatChange(delta));
    changeLabel.title = "Change compared with the previous month";
    cell.append(createElement("strong", null, formatInteger(metric(row, key))), changeLabel, createElement("small", null, sublabel));
    return cell;
  }

  function sourceCell(row, key, emptyText) {
    const cell = createElement("td", "aap-acquisition-source");
    if (row.loading) {
      cell.append(skeleton(120), skeleton(96), skeleton(108));
      return cell;
    }
    const items = Array.isArray(row?.data?.[key]) ? row.data[key] : [];
    if (!items.length) {
      cell.appendChild(createElement("span", "aap-acquisition-empty", emptyText));
      return cell;
    }
    const allValues = items.map((item, index) => `${index + 1}. ${originLabel(item.origin)} — ${formatTrafficPercent(item.trafficPercent)}`).join("\n");
    const list = createElement("span", "aap-acquisition-source-list");
    list.title = allValues;
    list.setAttribute("aria-label", allValues.replace(/\n/g, ", "));
    items.slice(0, 3).forEach((item) => {
      const line = createElement("span", "aap-acquisition-source-line");
      line.append(createElement("span", "aap-acquisition-source-label", originLabel(item.origin)), createElement("small", null, formatTrafficPercent(item.trafficPercent)));
      list.appendChild(line);
    });
    cell.appendChild(list);
    return cell;
  }

  // Bucket sort puts the most urgent bucket first in descending order.
  function bucketRank(buckets, row) {
    const bucket = MODEL.bucketFor(buckets.get(row.actor.id));
    return bucket ? MODEL.BUCKETS.length - MODEL.BUCKETS.indexOf(bucket) : 0;
  }

  function sortRows(rows, buckets) {
    return rows.sort((a, b) => {
      let result = 0;
      if (state.sort === "name") result = a.actor.title.localeCompare(b.actor.title);
      else if (state.sort === "bucket") result = (bucketRank(buckets, a) - bucketRank(buckets, b)) || ((metric(a, "numUniqueViewingUsers") || 0) - (metric(b, "numUniqueViewingUsers") || 0));
      else if (state.sort === "input") result = (metric(a, "numUniqueConsolePageViews") || 0) - (metric(b, "numUniqueConsolePageViews") || 0);
      else if (state.sort === "started") result = (metric(a, "numUniqueUsersWithRun") || 0) - (metric(b, "numUniqueUsersWithRun") || 0);
      else result = (metric(a, "numUniqueViewingUsers") || 0) - (metric(b, "numUniqueViewingUsers") || 0);
      return (result * (state.direction === "asc" ? 1 : -1)) || a.actor.title.localeCompare(b.actor.title);
    });
  }

  function filteredRows(rows, buckets) {
    const query = state.query.trim().toLowerCase();
    return sortRows(rows.filter((row) => !query || `${row.actor.title} ${row.actor.name}`.toLowerCase().includes(query)), buckets);
  }

  function appendTableHeader(table) {
    const head = document.createElement("thead");
    const row = document.createElement("tr");
    for (const [label, title] of [
      ["Actor", ""],
      ["Actor detail", "Unique users who viewed the Actor detail page."],
      ["Input page", "Unique users who viewed the Actor input page."],
      ["Actor started", "Unique users who started the Actor."],
      ["Top referrer", "The most common source domain for detail viewers."],
      ["Top country", "The country contributing the most detail viewers."],
    ]) {
      const header = createElement("th", null, label);
      if (title) header.title = title;
      row.appendChild(header);
    }
    head.appendChild(row);
    table.appendChild(head);
  }

  function tableRow(row, total, bucket) {
    const tableRow = document.createElement("tr");
    if (row.loading) tableRow.className = "aap-acquisition-row-loading";
    else if (row.failed) tableRow.className = "aap-acquisition-row-partial";
    tableRow.append(
      actorCell(row.actor, total, bucket),
      metricCell(row, "numUniqueViewingUsers", "unique viewers"),
      metricCell(row, "numUniqueConsolePageViews", "unique viewers"),
      metricCell(row, "numUniqueUsersWithRun", "unique starters"),
      sourceCell(row, "topReferrers", "–"),
      sourceCell(row, "topCountryCodes", "–"),
    );
    return tableRow;
  }

  function emptyTableRow(message) {
    const row = document.createElement("tr");
    const cell = createElement("td", "aap-acquisition-table-empty", message);
    cell.colSpan = 6;
    row.appendChild(cell);
    return row;
  }

  function syncView() {
    const active = onOverviewRoute();
    document.documentElement.classList.toggle(OVERVIEW_CLASS, active && !state.showOriginal);
    host?.classList.toggle("aap-acquisition-original-mode", state.showOriginal);
    // Only the page in view shows its toggle; a late render elsewhere
    // removes it instead.
    if (active) window.AAP_INSIGHTS_NAV?.ensureViewToggle("acquisition", state.showOriginal ? "original" : "custom", setViewMode);
    else window.AAP_INSIGHTS_NAV?.removeViewToggle("acquisition");
  }

  function setViewMode(mode) {
    state.showOriginal = mode === "original";
    syncView();
    if (!state.showOriginal && !state.requestId) beginLoad(monthStartAt(), false);
    maybeScanTriage();
  }

  // Triage | Table. The table loads its first page on demand; Actors the
  // triage scan already has are shown without refetching.
  function setView(view) {
    if (state.view === view) return;
    state.view = view;
    writeUrlState();
    render();
    if (usesTriage(view)) maybeScanTriage();
    else if (state.monthStartAt && !state.loading && !coveredIds().size) loadMoreActors(false).catch(() => {});
  }

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
    // With the Today list switched off, its tab goes and Triage opens instead.
    const todayOn = self.AAP_FEATURES?.enabled("today") ?? true;
    if (!todayOn && state.view === "today") state.view = VIEWS.detail;
    const now = Date.now();
    const triageView = state.view === "triage";
    const todayView = state.view === "today";
    const tableView = state.view === "table";
    refs.tabs.forEach((tab) => {
      const active = tab.dataset.view === state.view;
      tab.hidden = tab.dataset.view === "today" && !todayOn;
      tab.setAttribute("aria-pressed", String(active));
      tab.classList.toggle("aap-insights-nav-view-button-active", active);
    });
    refs.today.hidden = !todayView;
    refs.triage.hidden = !triageView;
    refs.tableArea.hidden = !tableView;
    refs.tableControls.forEach((element) => { element.hidden = !tableView; });
    refs.search.hidden = todayView;
    if (tableView) renderTable();
    else renderTriageHeader(now);
    if (triageView) renderTriagePane(now);
    if (todayView) self.AAP_TODAY_VIEW.render(refs.today, { source: "acquisition", live: todayInput });
    if (!state.loading && state.actors.length && !state.triage.scan.running) window.AAP_INSIGHTS_NAV?.prefetchOtherTabs?.("acquisition");
  }

  // The Today page reads this page's live triage scan. It covers this month,
  // so with an older month picked it says so instead.
  function todayInput() {
    const triage = state.triage;
    if (triage.month && triage.month !== currentCalendarMonthStartAt()) return { unavailable: "Today covers this month. Pick the current month to see today's list." };
    return {
      acquisition: { snapshot: triage.snapshot, thresholds: triageThresholds().thresholds, month: triage.month },
      traffic: triage.snapshot.traffic,
      scan: { running: triage.scan.running && !triage.snapshot.scannedAt, done: triage.scan.done, total: triage.scan.total },
    };
  }

  function renderTriageHeader(now) {
    const { snapshot, scan, error } = state.triage;
    const total = snapshot.actors.length;
    refs.summary.textContent = total ? `${total.toLocaleString("en-US")} Actors · ${monthLabel(state.triage.month)}` : "";
    VIEW.renderProgress(refs.progress, scan, snapshot, now);
    const failedCount = snapshot.actors.filter((actor) => snapshot.entries[actor.id]?.failed).length;
    refs.status.replaceChildren();
    if (error) refs.status.appendChild(createElement("span", null, error));
    else if (!scan.running && failedCount) {
      refs.status.appendChild(createElement("span", null, `${failedCount} ${failedCount === 1 ? "Actor" : "Actors"} could not be fully loaded; showing their last known data.`));
      const retry = createElement("button", "aap-acquisition-more", "Retry failed");
      retry.type = "button";
      retry.addEventListener("click", retryTriageFailed);
      refs.status.appendChild(retry);
    }
  }

  function renderTable() {
    const buckets = tableBuckets();
    const allRows = displayRows();
    const rows = filteredRows([...allRows], buckets);
    const loadedCount = allRows.filter((row) => row.loaded).length;
    refs.progress.replaceChildren();
    refs.summary.textContent = state.loading
      ? `Loading Actor list${state.actors.length ? ` · ${state.completed} of ${state.rows.length} details` : ""} · ${monthLabel(state.monthStartAt)}…`
      : `Showing ${rows.length} matching Actors · ${loadedCount} details loaded · ${state.actors.length} total · ${monthLabel(state.monthStartAt)}`;
    refs.status.textContent = state.error || "";

    refs.totalBody.replaceChildren();
    if (state.totalLoaded) {
      refs.totalBody.appendChild(tableRow({
        actor: { id: "__all__", title: "All actors", name: "Account total" },
        data: state.total,
        previous: state.totalPrevious,
        failed: !state.total,
      }, true));
    } else if (!state.loading) {
      refs.totalBody.appendChild(emptyTableRow("Total acquisition data unavailable."));
    }

    refs.body.replaceChildren();
    if (!rows.length) {
      if (!state.loading) refs.body.appendChild(emptyTableRow(state.error ? "No acquisition data available." : "No Actors match this filter."));
    } else {
      const fragment = document.createDocumentFragment();
      for (const row of rows) fragment.appendChild(tableRow(row, false, buckets.get(row.actor.id)));
      refs.body.appendChild(fragment);
    }

    const remaining = Math.max(0, state.actors.length - allRows.length);
    if (refs.more) {
      refs.more.hidden = !remaining;
      refs.more.disabled = state.detailLoading;
      refs.more.textContent = state.detailLoading ? "Loading…" : `Load more Actors (${Math.min(ACTOR_PAGE_SIZE, remaining)})`;
    }
    if (refs.all) {
      refs.all.hidden = !remaining;
      refs.all.disabled = state.detailLoading;
      refs.all.textContent = state.detailLoading ? "Loading…" : "Load all Actors";
    }
    if (!state.loading && !state.detailLoading) queueAutoLoad();
  }

  function createHost() {
    host = createElement("section", HOST_CLASS);
    host.setAttribute("aria-label", "Actor acquisition overview");

    const header = createElement("div", "aap-acquisition-header");
    const heading = createElement("div");
    heading.append(
      createElement("h2", null, "Actor acquisition overview"),
      createElement("p", null, "Which Actors are gaining attention, losing it, or losing the people who find them."),
    );
    const summary = createElement("span", "aap-acquisition-summary");
    const progress = createElement("div", "aap-quality-inbox-progress aap-acquisition-progress");
    progress.setAttribute("aria-live", "polite");
    const side = createElement("div", "aap-acquisition-header-side");
    side.append(summary, progress);
    header.append(heading, side);

    const controls = createElement("div", "aap-acquisition-controls aap-insights-controls");
    // Same segmented control as the Original/Plus toggle in the tab bar.
    const tabList = createElement("div", "aap-insights-nav-view-toggle aap-acquisition-view-toggle");
    tabList.setAttribute("role", "group");
    tabList.setAttribute("aria-label", "Acquisition view");
    const tabs = [["today", "Today"], ["triage", "Triage"], ["table", "Table"]].map(([view, label]) => {
      const tab = createElement("button", "aap-insights-nav-view-button", label);
      tab.type = "button";
      tab.dataset.view = view;
      tab.addEventListener("click", () => setView(view));
      tabList.appendChild(tab);
      return tab;
    });
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Filter Actors";
    search.setAttribute("aria-label", "Filter Actors");
    search.addEventListener("input", () => {
      state.query = search.value;
      render();
      loadSearchMatches().catch(() => {});
    });
    const sort = document.createElement("select");
    sort.setAttribute("aria-label", "Sort Actors by");
    for (const [value, label] of [["viewers", "Actor detail"], ["input", "Input page"], ["started", "Actor started"], ["bucket", "Bucket"], ["name", "Name"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `Sort by ${label}`;
      sort.appendChild(option);
    }
    sort.addEventListener("change", () => {
      state.sort = sort.value;
      render();
    });
    const order = createElement("button", "aap-acquisition-order", "↓ Desc");
    order.type = "button";
    order.setAttribute("aria-label", "Toggle sort direction");
    order.title = "Switch between descending and ascending order";
    order.addEventListener("click", () => {
      state.direction = state.direction === "asc" ? "desc" : "asc";
      order.textContent = state.direction === "asc" ? "↑ Asc" : "↓ Desc";
      render();
    });
    const refresh = createElement("button", "aap-acquisition-refresh", "Refresh");
    refresh.type = "button";
    refresh.title = "Fetch every Actor's acquisition data again";
    refresh.addEventListener("click", () => {
      AAP_API.forceFresh?.();
      if (usesTriage(state.view)) refreshTriage();
      beginLoad(monthStartAt(), true);
    });
    const more = createElement("button", "aap-acquisition-more", "Load more Actors");
    more.type = "button";
    more.addEventListener("click", () => loadMoreActors(false));
    const all = createElement("button", "aap-acquisition-more", "Load all Actors");
    all.type = "button";
    all.addEventListener("click", () => loadMoreActors(true));
    const tableControls = createElement("span", "aap-acquisition-table-controls");
    tableControls.append(sort, order);
    const tableActions = createElement("span", "aap-acquisition-table-controls");
    tableActions.append(more, all);
    controls.append(tabList, search, tableControls, refresh, tableActions);

    const status = createElement("div", "aap-acquisition-status");
    const triage = createElement("div", "aap-acquisition-triage");
    function tableShell(label, bodyKey) {
      const section = createElement("section", `aap-acquisition-table-section aap-table-section ${bodyKey === "totalBody" ? "aap-acquisition-total-section aap-table-section-total" : "aap-acquisition-actors-section aap-table-section-rows"}`);
      section.setAttribute("aria-label", label);
      const shell = createElement("div", "aap-acquisition-table-shell aap-table-shell");
      const scroll = createElement("div", "aap-acquisition-table-scroll");
      const table = document.createElement("table");
      table.className = "aap-acquisition-table";
      table.setAttribute("aria-label", `${label} acquisition data`);
      appendTableHeader(table);
      const body = document.createElement("tbody");
      table.appendChild(body);
      scroll.appendChild(table);
      shell.appendChild(scroll);
      section.appendChild(shell);
      section[bodyKey] = body;
      return section;
    }
    const totalSection = tableShell("All actors", "totalBody");
    const actorsSection = tableShell("Actors", "body");
    const sentinel = createElement("div", "aap-load-sentinel");
    sentinel.setAttribute("aria-hidden", "true");
    const tableArea = createElement("div", "aap-acquisition-table-area");
    tableArea.append(totalSection, actorsSection, sentinel);
    const today = createElement("div", "aap-today-pane");
    host.append(header, controls, status, today, triage, tableArea);
    window.AAP_INSIGHTS_NAV?.watchSentinel?.(sentinel, autoLoadMore);
    refs = {
      summary,
      progress,
      status,
      tabs,
      search,
      today,
      triage,
      tableArea,
      tableControls: [tableControls, tableActions],
      more,
      all,
      sentinel,
      totalBody: totalSection.totalBody,
      body: actorsSection.body,
    };
    syncView();
    return host;
  }

  function ensureHost() {
    if (!onOverviewRoute()) return;
    syncPageTheme();
    const content = acquisitionContent();
    if (!content) return;
    syncView();
    const charts = content.querySelector('[class*="InsightsChartsWrapper"]');
    const mount = charts?.parentElement || content;
    let created = false;
    if (!host || !host.isConnected || host.parentElement !== mount) {
      host?.remove();
      host = createHost();
      if (charts?.parentElement === mount) mount.insertBefore(host, charts);
      else mount.appendChild(host);
      created = true;
    }
    if (created) render();
    const organization = organizationScope();
    if (state.organization !== organization) {
      state.requestId++;
      state.loading = false;
      state.detailLoading = false;
      state.monthStartAt = null;
      state.total = null;
      state.totalPrevious = null;
      state.totalLoaded = false;
      state.actors = [];
      state.rows = [];
      state.loadedAt = 0;
      state.organization = organization;
      render();
    }
    const month = monthStartAt();
    // The triage scope (organization, month, signed-in account) is known only
    // once the page has made its first authenticated request.
    if (AAP_API.hasToken?.()) {
      const scope = viewScope(month);
      if (state.triage.scope !== scope) {
        resetTriage();
        state.triage.scope = scope;
        state.triage.month = month;
        render();
        restoreTriage(scope);
      } else {
        maybeScanTriage();
      }
    }
    if (state.showOriginal || !restoreSettled || Date.now() < loadBlockedUntil) return;
    if (!state.requestId || state.monthStartAt !== month) { beginLoad(month, false); return; }
    if (Date.now() - state.loadedAt > refreshTtl(month)) beginLoad(month, false, true);
  }

  function removeHost() {
    // Leaving the page stops the triage scan; what it fetched so far is kept
    // and the next visit resumes from there.
    const triage = state.triage;
    if (triage.scan.running) {
      if (triage.tag) AAP_API.cancel?.(triage.tag);
      triage.requestId++;
      triage.tag = null;
      triage.scan = { ...triage.scan, running: false };
      triage.scanAttemptAt = 0;
      persistTriage();
    }
    document.documentElement.classList.remove(OVERVIEW_CLASS);
    window.AAP_INSIGHTS_NAV?.removeViewToggle("acquisition");
    host?.remove();
    host = null;
    refs = null;
  }

  async function beginLoad(month, force, silent = false) {
    if (state.loading && state.monthStartAt === month) return;
    if (!force && !silent && state.requestId && state.monthStartAt === month) return;
    const requestId = ++state.requestId;
    state.organization = organizationScope();
    state.loadedAt = Date.now();
    if (!silent) {
      state.loading = true;
      state.error = null;
      state.monthStartAt = month;
      state.actors = [];
      state.rows = [];
      state.completed = 0;
      state.total = null;
      state.totalPrevious = null;
      state.totalLoaded = false;
      state.detailLoading = false;
      render();
    }
    try {
      const previousMonth = previousMonthStartAt(month);
      const portion = comparisonPortion(month);
      const [rawActors, totals] = await Promise.all([
        AAP_API.actorList(),
        Promise.allSettled([
          AAP_API.acquisitionData(month, []),
          AAP_API.acquisitionData(previousMonth, [], { portionOfMonthElapsed: portion }),
        ]),
      ]);
      const actors = normalizeActors(rawActors);
      if (requestId !== state.requestId) return;
      state.monthStartAt = month;
      state.actors = actors;
      state.total = totals[0].status === "fulfilled" ? totals[0].value : null;
      state.totalPrevious = totals[1].status === "fulfilled" ? totals[1].value : null;
      state.totalLoaded = true;
      // The triage view needs only the totals here; the table loads its
      // first page of Actors the triage scan has not covered.
      const covered = coveredIds();
      const firstPage = state.view === "table" ? actors.filter((actor) => !covered.has(actor.id)).slice(0, ACTOR_PAGE_SIZE) : [];
      if (!silent) {
        state.rows = firstPage.map(placeholderRow);
        render();
      }
      const actorsToLoad = silent
        ? state.rows.filter((row) => row.loaded).map((row) => row.actor)
        : firstPage;
      await loadActors(actorsToLoad, month, previousMonth, portion, requestId, silent);
      if (requestId !== state.requestId) return;
    } catch (error) {
      if (requestId === state.requestId && !silent) state.error = AAPF.loadError("acquisition data", error);
    } finally {
      if (requestId === state.requestId) {
        state.loading = false;
        render();
        loadSearchMatches().catch(() => {});
      }
    }
  }

  // The Today switch applies to an open page; the poll handles the rest.
  self.AAP_FEATURES?.onChange(() => render());
  const poll = AAP_LIFECYCLE.every(() => {
    if (onOverviewRoute()) ensureHost();
    else removeHost();
  }, 400);
  window.addEventListener("beforeunload", () => clearInterval(poll));
})();
