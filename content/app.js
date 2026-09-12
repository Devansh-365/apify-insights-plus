/*
 * Overlays the native Monetization chart on
 * https://console.apify.com/actors/insights/monetization with our own
 * canvas, plus a small toolbar inserted just above it: one metric selector
 * (Revenue, Runs, or Results). Revenue is always stacked by Actor.
 * Hovering any day shows a tooltip with that day's full stats plus the top
 * Actors (10 by default, configurable from the toolbar popup) by whichever
 * metric is active. We draw our own chart (rather
 * than reaching into Apify's) because it's a black-box Chart.js canvas with
 * no exposed instance to restyle or hook into.
 *
 * The Insights page is a client-routed SPA and never changes the URL when
 * you flip months, so we can't read "which month is shown" from
 * location.href. Instead token-sniffer.js (MAIN world) watches the page's
 * own XHR/fetch calls and tells us the `month` query param of each one. The
 * bearer token itself is supplied by the extension service worker.
 *
 * The account-wide Revenue/Costs/Runs/Results headline numbers were only
 * ever fetched once per month load, so they'd drift from Apify's own chart
 * (which keeps recomputing) the longer a tab stayed open on a still-settling
 * day. We now re-poll those same two endpoints on a timer (see
 * DAY_METRICS_REFRESH_MS) so they stay live. A "Show original Apify chart"
 * toolbar toggle un-hides the native canvas for a direct side-by-side check
 * against our numbers.
 */
(function () {
  // Personal accounts see /actors/insights/monetization; organization
  // accounts get an /organization/<orgId> path prefix for the same page.
  // Match both — the org's analytics requests carry the org context in the
  // token the sniffer picks up, so nothing else needs to change.
  const ROUTE_RE = /^(?:\/organization\/[^/]+)?\/actors\/insights\/monetization\/?$/;
  const onInsightsRoute = () => ROUTE_RE.test(location.pathname);
  const OVERLAY_CLASS = "aap-overlay";
  const OVERLAY_PAGE_CLASS = "aap-overlay-page";
  const NATIVE_VISIBLE_CLASS = "aap-overlay-native-visible";
  const OVERLAY_READY_CLASS = "aap-overlay-ready";
  const RANGE_MODE_CLASS = "aap-range-mode";
  const ORIGINAL_MODE_CLASS = "aap-monetization-original-mode";
  const TOOLBAR_CLASS = "aap-toolbar-row";
  const PALETTE = ["#2dd4bf", "#60a5fa", "#f472b6", "#facc15", "#a78bfa", "#fb923c", "#34d399", "#f87171"];
  const OTHER_COLOR = "#6b7280";
  const TOP_N = PALETTE.length;
  // How many Actors the click-to-pin tooltip table lists, ranked by the
  // active headline metric. Configurable from the extension's toolbar popup
  // (Settings section) — this is just the fallback until that pref loads.
  const DEFAULT_TOOLTIP_ACTOR_COUNT = 10;
  const METRICS = [
    { key: "revenue", label: "Revenue", color: "#12966f", kind: "bar" }, // matches Apify's own chart bar color
    { key: "runs", label: "Runs", color: "#22d3ee", kind: "line" },
    { key: "results", label: "Results", color: "#fb7185", kind: "line" },
  ];
  const AXIS_LABEL_COLOR = "#374151";
  const GRID_COLOR = "rgba(17, 24, 39, 0.14)";

  const PREF_KEYS = {
    metric: "aap.metric",
    // Read the old multi-select preference once so existing installs keep
    // their last choice after the toolbar is simplified to one selector.
    legacyMetricsOn: "aap.metricsOn",
    showNative: "aap.showNativeOn",
    tooltipActorCount: "aap.tooltipActorCount",
  };
  const MAX_TOOLTIP_ACTOR_COUNT = 50;

  // How often to re-fetch the cheap account-wide day totals while a month
  // stays loaded, so a long-open tab doesn't show numbers from whenever it
  // was first opened (recent days keep settling on Apify's side too).
  const DAY_METRICS_REFRESH_MS = 60_000;

  // How often a still-open tab re-runs the full per-Actor index. Without
  // this, the breakdown was indexed exactly once per page load, so a tab
  // opened before today's first paid run showed "No paid Actor activity this
  // day" for today forever (while the account-wide totals, refreshed every
  // minute, plainly showed revenue). Matches the cache TTL — re-running
  // sooner would just be served the same fresh cache and no-op.
  const BREAKDOWN_REFRESH_MS = 15 * 60 * 1000;

  const state = {
    month: null, // "2026-07-01", from the page's own requests
    actorIds: [], // native "Actor" filter, sniffed from those same requests ([] = all)
  };

  let customChartReady = false;
  let activeMetric = "revenue";

  // Add this before the first overlay poll. The native chart remains visible
  // until the replacement reports a successful draw, so a slow request or a
  // rendering problem never leaves an empty chart area.
  if (onInsightsRoute()) document.documentElement.classList.add(OVERLAY_PAGE_CLASS);

  // Which organization's console we're looking at ("" = personal account).
  // Part of every scope/cache key so switching personal <-> org in the same
  // tab can't serve one account's cached breakdown to the other.
  function currentOrg() {
    return (location.pathname.match(/^\/organization\/([^/]+)/) || [])[1] || "";
  }

  // One string identifying what should currently be rendered: month +
  // account + filter. Everything that loads or lands async compares against
  // this, so a month switch, an account switch, and a filter switch are all
  // handled identically.
  function buildScopeKey(month, actorIds) {
    return `${month}|${currentOrg()}|${AAP_API.authScope?.() || "anonymous"}|${actorIds.join(",")}`;
  }

  function scopeKey() {
    return state.month ? buildScopeKey(state.month, state.actorIds) : null;
  }

  function storageGet(keys) {
    try {
      if (typeof chrome === "undefined" || !chrome.storage?.local) return Promise.resolve({});
      const result = chrome.storage.local.get(keys);
      return result && typeof result.then === "function" ? result.catch(() => ({})) : Promise.resolve(result || {});
    } catch {
      return Promise.resolve({});
    }
  }

  function storageSet(values) {
    try {
      if (typeof chrome === "undefined" || !chrome.storage?.local) return;
      const result = chrome.storage.local.set(values);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // Preferences are optional; never let persistence break the chart.
    }
  }

  storageGet(Object.values(PREF_KEYS)).then((r) => {
    const storedMetric = r[PREF_KEYS.metric];
    if (METRICS.some((metric) => metric.key === storedMetric)) activeMetric = storedMetric;
    else if (r[PREF_KEYS.legacyMetricsOn]) {
      activeMetric = METRICS.find((metric) => r[PREF_KEYS.legacyMetricsOn][metric.key])?.key || "revenue";
    }
    showNativeOn = !!r[PREF_KEYS.showNative];
    syncOverlayPage();
    if (r[PREF_KEYS.tooltipActorCount] > 0) {
      tooltipActorCount = Math.min(MAX_TOOLTIP_ACTOR_COUNT, Math.round(Number(r[PREF_KEYS.tooltipActorCount])));
    }
    syncToolbar();
    drawChart();
  });

  // The tooltip actor count is set from the toolbar popup (a separate
  // context from this content script), not from anything in this page, so
  // pick up a change made there live rather than requiring a reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[PREF_KEYS.tooltipActorCount]) return;
    const next = changes[PREF_KEYS.tooltipActorCount].newValue;
    tooltipActorCount = next > 0
      ? Math.min(MAX_TOOLTIP_ACTOR_COUNT, Math.round(Number(next)))
      : DEFAULT_TOOLTIP_ACTOR_COUNT;
    renderTooltip();
  });

  // This only ever records *which month the page is currently showing* — it
  // does NOT trigger loading. The very first request of a page load reliably
  // fires before the chart (our DOM anchor) exists, so a "load on event"
  // design would permanently mark that month as handled and never retry once
  // the anchor shows up. The poll below is the single place that decides
  // whether to (re)load, once it can confirm there's somewhere to render.
  window.addEventListener("aap-request-seen", (e) => {
    const { month, actorIds } = e.detail;
    if (!month) return;
    state.month = month;
    // Sorted so the same filter always yields the same scopeKey/cache key
    // regardless of the order the page put the ids in the query string.
    state.actorIds = [...(actorIds || [])].sort();
  });
  window.dispatchEvent(new Event("aap-request-info")); // replay metadata from early page requests

  // ---- SPA route watcher ---------------------------------------------------
  let lastPath = null;
  setInterval(() => {
    const path = location.pathname;
    if (path === lastPath) return;
    lastPath = path;
    if (!onInsightsRoute()) unmountOverlay();
  }, 500);

  // ---- DOM anchoring --------------------------------------------------------
  // The wrapper Apify renders its Chart.js canvas into — a plain, statically
  // positioned <div> with exactly one <canvas> child.
  function findChartWrapper() {
    return document.querySelector('[class*="PaidActorProfitMarginChart"]');
  }

  function syncOverlayPage() {
    const active = onInsightsRoute();
    const rangeMode = document.documentElement.classList.contains(RANGE_MODE_CLASS);
    const originalMode = document.documentElement.classList.contains(ORIGINAL_MODE_CLASS);
    document.documentElement.classList.toggle(OVERLAY_PAGE_CLASS, active);
    document.documentElement.classList.toggle(NATIVE_VISIBLE_CLASS, active && showNativeOn);
    document.documentElement.classList.toggle(OVERLAY_READY_CLASS, active && customChartReady && !rangeMode && !showNativeOn && !originalMode);
  }

  function syncNativeCanvas(wrapper) {
    if (!wrapper || document.documentElement.classList.contains(RANGE_MODE_CLASS)) return;
    const nativeCanvas = wrapper.querySelector("canvas:not(.aap-chart):not(.aap-range-chart)");
    if (!nativeCanvas) return;
    const originalMode = document.documentElement.classList.contains(ORIGINAL_MODE_CLASS);
    const visible = showNativeOn || originalMode || !customChartReady;
    const nextVisibility = visible ? "" : "hidden";
    if (nativeCanvas.style.visibility !== nextVisibility) {
      nativeCanvas.style.visibility = nextVisibility;
      if (nextVisibility === "hidden") nativeCanvas.dispatchEvent(new MouseEvent("mouseout"));
    }
  }

  function setCustomChartReady(ready) {
    customChartReady = !!ready;
    syncOverlayPage();
    syncNativeCanvas(findChartWrapper());
  }

  // Ensures: the toolbar sits just above the chart wrapper, the native canvas
  // stays available as a fallback, and our own canvas + tooltip exist inside
  // the wrapper. Safe to call repeatedly
  // — it's the single place that (re)creates anything that went missing,
  // whether that's on first paint or after Apify's own React tree re-renders
  // the wrapper and wipes out nodes it doesn't recognize.
  function ensureOverlay() {
    const wrapper = findChartWrapper();
    if (!wrapper) return null;

    const rangeMode = document.documentElement.classList.contains(RANGE_MODE_CLASS);

    // visibility:hidden, not display:none — the wrapper has no height of its
    // own, it's sized by the canvas; hiding via display would collapse it to
    // 0px and our absolutely-positioned overlay would have nothing to fill.
    // When "Show original Apify chart" is on, we flip this the other way:
    // the native canvas is shown and our own overlay is display:none'd.
    if (!rangeMode) syncNativeCanvas(wrapper);
    if (getComputedStyle(wrapper).position === "static") wrapper.style.position = "relative";

    ensureToolbar(wrapper);

    let overlay = wrapper.querySelector(`.${OVERLAY_CLASS}`);
    if (!overlay) {
      // The Console may replace the chart subtree while the SPA is settling.
      // A new canvas has not been drawn yet, so revoke readiness before hiding
      // the native canvas again.
      setCustomChartReady(false);
      overlay = document.createElement("div");
      overlay.className = OVERLAY_CLASS;
      wrapper.appendChild(overlay);
    }

    let canvas = overlay.querySelector(".aap-chart");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "aap-chart";
      overlay.appendChild(canvas);

      // Hover shows a live preview that follows the cursor (as before) and
      // is not interactive — pointer-events is off by default. Clicking a
      // day's bar "pins" the tooltip: it stops following the mouse and
      // becomes clickable (see PIN below) so the sort headers actually work.
      canvas.addEventListener("mousemove", onHover);
      canvas.addEventListener("mouseleave", () => {
        if (pinnedDay == null) hideTooltip();
      });
      canvas.addEventListener("click", onChartClick);
    }

    // Keep one tooltip outside the chart's clipped ancestors. Reusing it also
    // prevents duplicate tooltips when React replaces only the chart subtree.
    let tooltip = document.querySelector(".aap-tooltip");
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.className = "aap-tooltip";
      tooltip.style.display = "none";
      tooltip.addEventListener("click", onTooltipClick);
      document.body.appendChild(tooltip);
    }

    overlay.style.display = showNativeOn || rangeMode ? "none" : "";
    if (showNativeOn || document.documentElement.classList.contains(ORIGINAL_MODE_CLASS)) hideTooltip();
    return overlay;
  }

  // The toolbar lives just above the chart wrapper (as its previous sibling,
  // in normal flow) rather than floating over the canvas, so it doesn't sit
  // on top of the graph.
  function ensureToolbar(wrapper) {
    const existing = wrapper.previousElementSibling;
    if (existing?.classList.contains(TOOLBAR_CLASS)) {
      const complete = existing.querySelector(".aap-metric-select")
        && existing.querySelector(".aap-native-checkbox");
      if (complete) return existing;
      // Upgrade a toolbar left in the DOM by an older extension version.
      existing.remove();
    }

    const toolbar = document.createElement("div");
    toolbar.className = TOOLBAR_CLASS;

    const metricLabel = document.createElement("label");
    metricLabel.className = "aap-toggle aap-metric-control";
    metricLabel.appendChild(document.createTextNode("Metric"));
    const metricSelect = document.createElement("select");
    metricSelect.className = "aap-metric-select";
    metricSelect.setAttribute("aria-label", "Chart metric");
    for (const metric of METRICS) {
      const option = document.createElement("option");
      option.value = metric.key;
      option.textContent = metric.label;
      metricSelect.appendChild(option);
    }
    metricSelect.addEventListener("change", () => {
      activeMetric = METRICS.some((metric) => metric.key === metricSelect.value) ? metricSelect.value : "revenue";
      storageSet({ [PREF_KEYS.metric]: activeMetric });
      syncToolbar();
      drawChart();
    });
    metricLabel.appendChild(metricSelect);
    toolbar.appendChild(metricLabel);

    const nativeLabel = document.createElement("label");
    nativeLabel.className = "aap-toggle";
    const nativeBox = document.createElement("input");
    nativeBox.type = "checkbox";
    nativeBox.className = "aap-toggle-checkbox aap-native-checkbox";
    nativeBox.addEventListener("change", () => {
      showNativeOn = nativeBox.checked;
      storageSet({ [PREF_KEYS.showNative]: showNativeOn });
      syncOverlayPage();
      drawChart();
    });
    nativeLabel.appendChild(nativeBox);
    nativeLabel.appendChild(document.createTextNode("Show original Apify chart"));
    toolbar.appendChild(nativeLabel);

    const status = document.createElement("span");
    status.className = "aap-status";
    toolbar.appendChild(status);

    wrapper.insertAdjacentElement("beforebegin", toolbar);
    syncToolbar();
    return toolbar;
  }

  // Reflects the current chart settings onto whatever toolbar controls
  // currently exist (creation happens in ensureToolbar; this just keeps them
  // in sync after a state change or a poll-driven recreation).
  function syncToolbar() {
    const wrapper = findChartWrapper();
    const toolbar = wrapper?.previousElementSibling?.classList.contains(TOOLBAR_CLASS)
      ? wrapper.previousElementSibling
      : null;
    if (!toolbar) return;
    const metricSelect = toolbar.querySelector(".aap-metric-select");
    if (metricSelect) metricSelect.value = activeMetric;
    const nativeBox = toolbar.querySelector(".aap-native-checkbox");
    if (nativeBox) nativeBox.checked = showNativeOn;
  }

  function unmountOverlay() {
    const wrapper = findChartWrapper();
    const overlay = wrapper?.querySelector(`.${OVERLAY_CLASS}`);
    if (overlay) overlay.remove();
    if (wrapper?.previousElementSibling?.classList.contains(TOOLBAR_CLASS)) {
      wrapper.previousElementSibling.remove();
    }
    const nativeCanvas = wrapper?.querySelector("canvas:not(.aap-chart)");
    if (nativeCanvas) nativeCanvas.style.visibility = "";
    document.querySelector(".aap-tooltip")?.remove();
    // The tooltip element is gone, but the pin/day state is separate JS
    // state — without resetting it here, navigating back to the Insights
    // page later would find pinnedDay still set and onHover would keep
    // silently no-op'ing forever (it defers entirely to a pinned tooltip).
    pinnedDay = null;
    tooltipDay = null;
    loadedKey = null;
    lastData = null;
    customChartReady = false;
    syncOverlayPage();
  }

  // Single trigger point, polled: the anchor may not exist yet on first
  // paint, AND the Console's own React tree periodically reconciles that
  // wrapper and wipes out nodes it doesn't recognize (including re-showing
  // the native canvas). Every 400ms: make sure the overlay/toolbar exist and
  // the native canvas is hidden, load whichever month we've most recently
  // learned about if we haven't already, and otherwise just redraw.
  let loadedKey = null;
  const poll = setInterval(() => {
    syncOverlayPage();
    if (!onInsightsRoute()) return;
    // Custom mode has its own five-chart renderer and always represents all
    // Actors. Do not start the month-view index in the background while it is
    // hidden; this saves requests and avoids two renderers competing for the
    // same monetization canvas during the mode switch.
    if (document.documentElement.classList.contains(RANGE_MODE_CLASS)) return;
    const overlay = ensureOverlay();
    if (!overlay) return;
    const key = scopeKey();
    if (key && key !== loadedKey) {
      loadedKey = key;
      resetChartForScope();
      loadAndRender(state.month, state.actorIds).catch(() => {}); // sets dayMetricsFetchedAt itself on success
      return;
    }
    if (key && Date.now() - dayMetricsFetchedAt > DAY_METRICS_REFRESH_MS) {
      refreshDayMetrics(state.month, state.actorIds);
    }
    // Periodically re-run the whole load (cache check + re-index once the
    // cache has gone stale) so a long-open tab's per-Actor breakdown keeps up
    // with today — see BREAKDOWN_REFRESH_MS. loadAndRender stamps
    // breakdownRefreshedAt itself, which also covers the initial load.
    if (key && lastData && !lastData.indexing && Date.now() - breakdownRefreshedAt > BREAKDOWN_REFRESH_MS) {
      loadAndRender(state.month, state.actorIds).catch(() => {});
      return;
    }
    if (lastData) drawChart();
  }, 400);
  window.addEventListener("beforeunload", () => clearInterval(poll));

  // Re-fetches just the account-wide day totals (not the per-Actor
  // breakdown) so the headline Revenue/Costs/Runs/Results stay live for as
  // long as the tab is left open on this page, instead of freezing at
  // whatever they were when the month was first loaded.
  async function refreshDayMetrics(month, actorIds) {
    if (dayMetricsFetching) return null;
    dayMetricsFetching = true;
    const key = buildScopeKey(month, actorIds);
    try {
      const [margin, runs] = await Promise.all([
        AAP_API.profitMargin(month, actorIds),
        AAP_API.runStatistics(month, actorIds),
      ]);
      if (key !== scopeKey()) return; // user switched month/filter mid-flight
      dayMetricsFetchedAt = Date.now();
      const dayMetrics = buildDayMetrics(margin, runs);
      setData({ dayMetrics });
      return dayMetrics;
    } catch {
      dayMetricsFetchedAt = Date.now(); // back off; retry after the next interval regardless
      return null;
    } finally {
      dayMetricsFetching = false;
    }
  }

  // ---- data ------------------------------------------------------------
  let indexRun = 0; // guards against a stale index finishing after a month switch
  let lastData = null; // { month, dayMetrics, daily, actorCount, indexedAt, loading, indexing, progress, error }
  let showNativeOn = false;
  let tooltipActorCount = DEFAULT_TOOLTIP_ACTOR_COUNT;
  let colorByActorId = new Map();
  let dayMetricsFetchedAt = 0;
  let dayMetricsFetching = false;
  let breakdownRefreshedAt = 0;

  AAP_API.onTokenChange?.(() => {
    // A token change means the authenticated account may have changed. Drop
    // the current view and invalidate every in-flight per-Actor continuation.
    loadedKey = null;
    resetChartForScope();
  });

  function resetChartForScope() {
    indexRun++;
    lastData = null;
    colorByActorId = new Map();
    dayMetricsFetchedAt = 0;
    breakdownRefreshedAt = 0;
    customChartReady = false;
    hideTooltip();
    syncOverlayPage();
  }

  // True when some day has revenue in the account-wide totals but no rows in
  // the per-Actor breakdown — the signature of a breakdown indexed before
  // that day's first paid activity (typically: a cache written earlier today,
  // or right after the UTC day rolled over). Any day with real revenue must
  // have at least one earning Actor, so this can't false-positive on a
  // legitimately quiet day.
  function breakdownMissingRevenueDay(daily, dayMetrics) {
    return Object.entries(dayMetrics || {}).some(
      ([day, m]) => m.revenue > 0 && !daily?.[day]?.length,
    );
  }

  async function loadAndRender(month, actorIds) {
    const overlay = ensureOverlay();
    if (!overlay) return;
    const loadKey = buildScopeKey(month, actorIds);
    breakdownRefreshedAt = Date.now(); // pace the poll's periodic re-run
    // Publish loading state before the cache and network awaits. This keeps a
    // visible status in the toolbar even while the native chart remains the
    // safe fallback underneath the custom renderer.
    setData({ month, loading: true, error: null, progress: null });
    await AAP_API.whenReady?.();
    if (loadKey !== scopeKey()) return;
    // Use a token-derived namespace without storing the token itself. This
    // prevents a cached personal account view from being shown after a
    // logout/login switch in the same browser profile.
    const scope = [AAP_API.authScope?.() || "anonymous", currentOrg() || "personal", actorIds.join(",")].join("|");

    let cached = null;
    try {
      cached = await AAP_CACHE.get(month, scope);
    } catch {
      // A cache failure should only cost us the cache; live API data can still
      // render normally.
    }
    if (loadKey !== scopeKey()) return;
    let daily = cached?.daily || null;
    let actorCount = cached?.actorCount ?? null;
    let indexedAt = cached?.updatedAt ?? null;
    let indexing = !cached || cached.stale;
    if (daily) colorByActorId = buildColorMap(daily);

    if (cached?.dayMetrics) setData({ month, daily, actorCount, indexedAt, indexing, loading: true, dayMetrics: cached.dayMetrics, progress: null });
    else setData({ month, daily, actorCount, indexedAt, indexing, loading: true, progress: null });

    // Always fetch the cheap day totals (scoped to the native Actor filter,
    // if any) so the chart is accurate even while (or instead of) a full
    // re-index runs. Shares refreshDayMetrics with the periodic poll so the
    // two never race.
    const freshDayMetrics = await refreshDayMetrics(month, actorIds);
    if (loadKey !== scopeKey()) return;
    let dayMetrics = freshDayMetrics || cached?.dayMetrics || lastData?.dayMetrics || null;

    // A cache can be fresh by TTL yet already wrong: indexed before today's
    // first paid run, it has no per-Actor rows for a day the just-fetched
    // account totals show revenue on, and the tooltip would claim "No paid
    // Actor activity" for a day that plainly earned. Re-index despite the TTL.
    if (!indexing && breakdownMissingRevenueDay(daily, dayMetrics)) indexing = true;

    if (!indexing) {
      setData({ loading: false, indexing: false, progress: null });
      return;
    }

    const myRun = ++indexRun;
    try {
      const raw = await AAP_API.actorBreakdown(month, actorIds);
      const breakdown = Array.isArray(raw) ? raw : raw?.monetizationPerActor || [];
      const paidActors = breakdown
        .map((item) => ({
          actorId: item.actor?._id,
          actorName: item.actor?.title || item.actor?.name || item.actor?._id,
          totalRevenueUsd: item.earningsStats?.totalRevenueUsd ?? 0,
          totalCostUsd: item.earningsStats?.totalCostUsd ?? 0,
        }))
        .filter((a) => a.actorId && (a.totalRevenueUsd > 0 || a.totalCostUsd > 0));

      // The chart only assigns colors to the top Actors and folds the rest
      // into its accurate account-wide "Other actors" segment. Index no more
      // than the configured tooltip limit (at least the eight colored Actors)
      // so large accounts do not generate an unnecessary request storm.
      const indexLimit = Math.max(TOP_N, Math.min(50, Number(tooltipActorCount) || DEFAULT_TOOLTIP_ACTOR_COUNT));
      const indexedActors = paidActors
        .slice()
        .sort((a, b) => b.totalRevenueUsd - a.totalRevenueUsd || b.totalCostUsd - a.totalCostUsd)
        .slice(0, indexLimit);
      const perActor = await AAP_API.pooled(
        indexedActors,
        async (actor) => {
          const [margin, runs] = await Promise.all([
            AAP_API.profitMargin(month, [actor.actorId]),
            AAP_API.runStatistics(month, [actor.actorId]),
          ]);
          return { actor, margin, runs };
        },
        (done, total) => {
          if (myRun !== indexRun) return;
          setData({ month, daily, actorCount: paidActors.length, indexedAt, indexing: true, dayMetrics, progress: { done, total } });
        },
      );
      if (myRun !== indexRun) return; // a newer month started loading

      daily = buildDailyIndex(perActor);
      colorByActorId = buildColorMap(daily);
      actorCount = paidActors.length;
      indexedAt = Date.now();

      // A handful of per-Actor fetches can transiently fail (a network blip,
      // the auth token racing readiness right after page load — see
      // pooled()'s per-item catch). Caching that partial result would lock in
      // an undercounted breakdown for the full 15-minute TTL, silently, since
      // indexing:false looks identical to a clean run. Only cache complete
      // passes; a partial one still renders (better than nothing) but the
      // next page load retries instead of serving stale wrong data.
      const failedCount = perActor.filter((e) => e === null).length;
      if (failedCount === 0) {
        try {
          await AAP_CACHE.set(month, scope, { daily, actorCount, dayMetrics, filtered: actorIds.length > 0 });
        } catch {
          // Cached breakdowns are an optimization, not a prerequisite for a
          // correct chart in the current tab.
        }
      }
      setData({ month, daily, actorCount, indexedAt, indexing: false, dayMetrics, progress: null });
    } catch (err) {
      if (myRun !== indexRun) return;
      setData({ month, daily, actorCount, indexedAt, indexing: false, dayMetrics, progress: null, error: String(err) });
    }
  }

  // Merges profit-margin + run-statistics into
  // { [date]: { revenue, cost, profit, margin, runs, results, successRate } }.
  //
  // profit-margin returns BOTH `payingUsersUsd` and `allUsersUsd` per day.
  // The Console's own chart (and its "only paying users generate revenue and
  // costs" caption) uses `payingUsersUsd` — `allUsersUsd` is a superset that
  // folds in free-tier usage, which inflates Revenue/Costs above what Apify
  // itself displays. Use payingUsersUsd to match.
  function buildDayMetrics(margin, runs) {
    const days = new Set([
      ...Object.keys(margin?.dailyProfitMarginStats || {}),
      ...Object.keys(runs?.dailyStats || {}),
    ]);
    const out = {};
    for (const day of days) {
      const m = margin?.dailyProfitMarginStats?.[day]?.payingUsersUsd;
      const r = runs?.dailyStats?.[day];
      out[day] = {
        revenue: m?.revenueUsd ?? 0,
        cost: m?.costUsd ?? 0,
        profit: m?.profitUsd ?? 0,
        margin: m?.margin ?? null,
        runs: r?.TOTAL ?? 0,
        results: r?.RESULTS ?? 0,
        successRate: r?.TOTAL ? r.SUCCEEDED / r.TOTAL : null,
      };
    }
    return out;
  }

  function metricValue(day, metric) {
    const value = Number((lastData.dayMetrics || {})[day]?.[metric]);
    return Number.isFinite(value) ? value : 0;
  }

  // The month chart renders one metric at a time. The range view remains the
  // place to compare all metrics in separate charts.
  function primaryMetric() {
    return activeMetric;
  }

  // perActor: [{ actor, margin, runs }] -> { [date]: [{ actorId, name, revenue, cost, profit, margin, runs, results, successRate }] }
  function buildDailyIndex(perActor) {
    const daily = {};
    for (const entry of perActor) {
      if (!entry) continue;
      const { actor, margin, runs } = entry;
      const marginByDay = margin?.dailyProfitMarginStats || {};
      const runsByDay = runs?.dailyStats || {};
      const days = new Set([...Object.keys(marginByDay), ...Object.keys(runsByDay)]);
      for (const day of days) {
        const m = marginByDay[day]?.payingUsersUsd; // see buildDayMetrics
        const r = runsByDay[day];
        if (!m && !r) continue;
        const row = {
          actorId: actor.actorId,
          name: actor.actorName,
          revenue: m?.revenueUsd ?? 0,
          cost: m?.costUsd ?? 0,
          profit: m?.profitUsd ?? 0,
          margin: m?.margin ?? null,
          runs: r?.TOTAL ?? null,
          results: r?.RESULTS ?? null,
          successRate: r && r.TOTAL ? r.SUCCEEDED / r.TOTAL : null,
        };
        if (!row.revenue && !row.cost && !row.runs) continue;
        (daily[day] ||= []).push(row);
      }
    }
    return daily;
  }

  // Assigns a stable color per Actor, ranked by total revenue across the
  // whole indexed month — so an Actor's color stays the same from day to day
  // (and across metric switches) instead of being re-picked per day/metric.
  function buildColorMap(daily) {
    const totals = new Map();
    for (const rows of Object.values(daily)) {
      for (const row of rows) {
        totals.set(row.actorId, (totals.get(row.actorId) || 0) + row.revenue);
      }
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const map = new Map();
    ranked.slice(0, TOP_N).forEach(([actorId], i) => map.set(actorId, PALETTE[i]));
    return map;
  }

  function setData(data) {
    lastData = { ...lastData, ...data };
    drawChart();
  }

  // ---- chart drawing ------------------------------------------------------
  // A single metric and scale keeps the month chart readable and prevents the
  // dual-axis layout from making one series appear flat beside another.
  const PAD = { top: 12, bottom: 22 };
  const TICK_TARGET = 8; // max gridline steps above $0 — Apify's own chart shows 0/50/.../400

  // Single source of truth for the plot's horizontal padding. drawChart and
  // onHover MUST agree or hover would map the cursor to the wrong day.
  function plotPads() {
    return {
      left: 16,
      right: 16,
    };
  }

  // Picks a "nice" step (1/2/5 x a power of ten) and lets the gridline COUNT
  // vary to cover the data, e.g. 360 -> steps of 50 over 8 ticks (axis 400).
  // This is what Apify's own chart does. Forcing a fixed tick count instead
  // makes the step itself absorb all the rounding — 360 over a fixed 7 needs
  // a step > 51.4, whose next nice value is 100, blowing the axis out to 700,
  // nearly double the tallest bar.
  function niceScale(maxValue) {
    if (maxValue <= 0) return { max: TICK_TARGET, ticks: TICK_TARGET };
    const rawStep = maxValue / TICK_TARGET;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    // Round UP to the next nice step so ticks never exceeds TICK_TARGET —
    // ceil() below then trims the count back down to just cover the data.
    const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    const step = niceNorm * mag;
    const ticks = Math.max(1, Math.ceil(maxValue / step));
    return { max: step * ticks, ticks };
  }

  function renderChart() {
    const overlay = ensureOverlay();
    if (!overlay || !lastData) {
      setCustomChartReady(false);
      return;
    }
    syncToolbar();

    const wrapper = overlay.parentElement;
    const toolbar = wrapper.previousElementSibling;
    const status = toolbar?.querySelector(".aap-status");
    if (status) {
      if (lastData.error) {
        status.textContent = `Couldn't load Actor data (${lastData.error}).`;
      } else if (lastData.progress) {
        status.textContent = `Indexing Actors… ${lastData.progress.done}/${lastData.progress.total}`;
      } else if (lastData.indexing) {
        status.textContent = "Indexing Actors…";
      } else if (lastData.loading) {
        status.textContent = "Loading chart…";
      } else {
        status.textContent = "";
      }
    }

    const canvas = overlay.querySelector(".aap-chart");
    const rect = wrapper.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      setCustomChartReady(false);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setCustomChartReady(false);
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const overlayStyles = getComputedStyle(overlay);
    const axisLabelColor = overlayStyles.getPropertyValue("--aap-overlay-text").trim() || AXIS_LABEL_COLOR;
    const gridColor = overlayStyles.getPropertyValue("--aap-overlay-grid").trim() || GRID_COLOR;

    const days = Object.keys(lastData.dayMetrics || {}).sort();
    canvas.__aapDays = days; // read back by the hover handler
    if (!days.length) {
      setCustomChartReady(false);
      return;
    }

    const metricDefinition = METRICS.find((metric) => metric.key === activeMetric) || METRICS[0];
    const showBars = metricDefinition.kind === "bar";

    // One metric owns the scale, so every point uses the same unit and there
    // is no second axis that can become misleading or unreadable.
    const dataMax = (key) => Math.max(1, ...days.map((d) => metricValue(d, key)));
    const { max: primaryMax, ticks } = niceScale(dataMax(metricDefinition.key));

    // Canvas 2D's `font` has no "inherit" keyword (unlike CSS) — an invalid
    // value here is silently dropped, leaving the browser's ~10px default,
    // which is why this always rendered smaller than Apify's own chart no
    // matter what size was requested. Read the page's real font stack instead.
    // Set before the measureText calls below, which depend on it.
    ctx.font = `13px ${getComputedStyle(wrapper).fontFamily || "sans-serif"}`;
    ctx.textBaseline = "middle";

    // Size the left gutter to the widest y-axis label instead of a fixed
    // width — "$400.00" needs more than the old fixed gutter allowed, which
    // clipped the leading "$" off the canvas edge.
    let labelWidth = 0;
    for (let i = 0; i <= ticks; i++) {
      const value = primaryMax * (i / ticks);
      const label = showBars ? AAPF.money(value) : AAPF.compact(value);
      labelWidth = Math.max(labelWidth, ctx.measureText(label).width);
    }
    const leftPad = Math.ceil(labelWidth) + 16;
    const rightPad = 16;
    // The hover handler must map cursor x with the same pads this draw used.
    canvas.__aapPads = { left: leftPad, right: rightPad };

    const plotW = Math.max(1, rect.width - leftPad - rightPad);
    const plotH = Math.max(1, rect.height - PAD.top - PAD.bottom);
    const slot = plotW / days.length;
    const barW = Math.max(4, slot * 0.6);

    // Gridlines and the single active metric's axis.
    ctx.strokeStyle = gridColor;
    for (let i = 0; i <= ticks; i++) {
      const frac = i / ticks;
      const y = PAD.top + plotH * (1 - frac);
      ctx.beginPath();
      ctx.moveTo(leftPad, y);
      ctx.lineTo(rect.width - rightPad, y);
      ctx.stroke();
      ctx.fillStyle = axisLabelColor;
      ctx.textAlign = "right";
      const axisValue = primaryMax * frac;
      ctx.fillText(showBars ? AAPF.money(axisValue) : AAPF.compact(axisValue), leftPad - 8, y);
    }

    // x-axis labels: thin to a clean day step (every 1/2/4/7/14 days) like
    // Apify's own chart, based on the measured label width. The old
    // heuristic assumed ~34px per label, which under-measures "Jul 27"-style
    // labels — a month view labeled every single day and the labels ran into
    // each other. The forced last-day label is gone for the same reason: it
    // collided with the preceding stepped label.
    const maxLabelW = Math.max(...days.map((d) => ctx.measureText(AAPF.shortDate(d)).width));
    const labelEvery = [1, 2, 4, 7, 14].find((s) => slot * s >= maxLabelW + 24) ?? days.length;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    days.forEach((day, i) => {
      if (i % labelEvery === 0) {
        const x = leftPad + i * slot + slot / 2;
        ctx.fillStyle = axisLabelColor;
        ctx.fillText(AAPF.shortDate(day), x, rect.height - PAD.bottom + 6);
      }
    });

    // Revenue bars are always stacked by Actor. Missing or unindexed revenue
    // stays visible in the grey "Other actors" segment.
    if (showBars) {
      days.forEach((day, i) => {
        const x = leftPad + i * slot + slot / 2;
        const total = metricValue(day, "revenue");
        const barH = (total / primaryMax) * plotH;
        const yTop = PAD.top + plotH - barH;

        let acc = 0;
        const grouped = new Map();
        for (const row of lastData.daily?.[day] || []) {
          const key = colorByActorId.get(row.actorId) || OTHER_COLOR;
          grouped.set(key, (grouped.get(key) || 0) + (row.revenue || 0));
        }
        const accounted = [...grouped.values()].reduce((sum, value) => sum + value, 0);
        const unassigned = Math.max(0, total - accounted);
        if (unassigned > 0) grouped.set(OTHER_COLOR, (grouped.get(OTHER_COLOR) || 0) + unassigned);
        // Stack every bar in the SAME order — by each Actor's month-long
        // revenue rank (its position in PALETTE), with the merged "other
        // Actors" grey band always on top. Without this, segments are drawn
        // in whatever order Actors happened to be active that day, so a
        // given Actor's colour lands in a different band on each bar and
        // looks like it changed colour from day to day.
        const rank = (color) => {
          const i = PALETTE.indexOf(color);
          return i === -1 ? Infinity : i; // OTHER_COLOR (not in PALETTE) sorts last → top of stack
        };
        const sumRows = [...grouped.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
        const rowsTotal = total || [...grouped.values()].reduce((s, v) => s + v, 0) || 1;
        for (const [color, value] of sumRows) {
          const segH = (value / rowsTotal) * barH;
          ctx.fillStyle = color;
          ctx.fillRect(x - barW / 2, yTop + barH - acc - segH, barW, segH);
          acc += segH;
        }
      });
    }

    // Run/result lines are drawn as a smooth spline rather than straight
    // segments between days.
    if (!showBars) {
      const m = metricDefinition;
      const max = primaryMax;
      const pts = days.map((day, i) => {
        const x = leftPad + i * slot + slot / 2;
        const v = metricValue(day, m.key);
        const y = PAD.top + plotH - (v / max) * plotH;
        return { x, y };
      });

      ctx.strokeStyle = m.color;
      ctx.fillStyle = m.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      drawSmoothLine(ctx, pts);
      ctx.stroke();

      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    setCustomChartReady(true);
  }

  // Canvas drawing is deliberately isolated behind a failure boundary. A
  // malformed/partial response or a browser layout edge case should fall
  // back to Apify's chart rather than interrupting the SPA or leaving a blank
  // replacement behind.
  function drawChart() {
    try {
      renderChart();
    } catch {
      setCustomChartReady(false);
      const wrapper = findChartWrapper();
      const status = wrapper?.previousElementSibling?.querySelector(".aap-status");
      if (status) status.textContent = "Enhanced chart unavailable; showing Apify's chart.";
    }
  }

  // ---- hover tooltip --------------------------------------------------------
  // Maps a clientX on the canvas to the day it falls in, or null outside the
  // plot area. Shared by hover (preview) and click (pin) so they agree on
  // which day the cursor is over.
  function dayAtClientX(canvas, clientX) {
    const days = canvas.__aapDays || [];
    if (!days.length) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    // Use the pads the last draw actually used (the left gutter is sized to
    // the measured y-labels there); plotPads() is only a pre-first-draw fallback.
    const { left: leftPad, right: rightPad } = canvas.__aapPads || plotPads();
    const plotW = rect.width - leftPad - rightPad;
    if (x < leftPad || x > rect.width - rightPad) return null;
    const slot = plotW / days.length;
    const idx = Math.min(days.length - 1, Math.max(0, Math.floor((x - leftPad) / slot)));
    return days[idx];
  }

  function onHover(e) {
    if (pinnedDay != null) return; // pinned tooltip ignores hover entirely until unpinned
    if (!lastData) return hideTooltip();
    const day = dayAtClientX(e.currentTarget, e.clientX);
    if (day == null) return hideTooltip();
    showTooltip(e.clientX, e.clientY, day);
  }

  // Clicking a bar pins the tooltip in place: it stops following the mouse
  // and gains pointer-events (see .aap-tt-pinned in app.css) so the sort
  // headers are actually clickable — a pure hover tooltip can't host a click
  // target, since leaving the canvas to reach it just hides it. Clicking the
  // same day again (or the close button, or Escape, or clicking outside
  // both the chart and the tooltip — see the document-level listeners below)
  // unpins and hands control back to hover.
  function onChartClick(e) {
    if (!lastData) return;
    const day = dayAtClientX(e.currentTarget, e.clientX);
    if (day == null) return;
    if (pinnedDay === day) {
      pinnedDay = null;
      showTooltip(e.clientX, e.clientY, day); // resume as a normal hover preview
      return;
    }
    pinnedDay = day;
    tooltipDay = day;
    tooltipSort = { key: primaryMetric(), dir: "desc" };
    renderTooltip();
    positionTooltip(e.clientX, e.clientY);
  }

  document.addEventListener("click", (e) => {
    if (pinnedDay == null) return;
    const tooltip = document.querySelector(".aap-tooltip");
    const canvas = document.querySelector(".aap-chart");
    if (tooltip?.contains(e.target) || canvas?.contains(e.target)) return; // handled above
    hideTooltip();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pinnedDay != null) hideTooltip();
  });

  // Columns available in the per-day actor table, in display order. `sort`
  // is the row field each header sorts by; "name" compares alphabetically,
  // everything else numerically.
  const TOOLTIP_COLUMNS = [
    { sort: "name", label: "Actor" },
    { sort: "revenue", label: "Revenue", fmt: (r) => AAPF.money(r.revenue || 0) },
    { sort: "cost", label: "Cost", fmt: (r) => AAPF.money(r.cost || 0) },
    { sort: "runs", label: "Runs", fmt: (r) => AAPF.compact(r.runs || 0) },
    { sort: "results", label: "Results", fmt: (r) => AAPF.compact(r.results || 0) },
  ];

  // Which day's table is currently shown, and how its rows are ordered.
  // Reset to "by the active headline metric, descending" whenever the
  // hovered/pinned day changes; a header click overrides it for that day
  // only, so moving to a new day always starts from the metric-relevant
  // view again.
  let pinnedDay = null; // non-null while the tooltip is pinned (see onChartClick)
  let tooltipDay = null;
  let tooltipSort = { key: "revenue", dir: "desc" };

  function showTooltip(clientX, clientY, day) {
    if (day !== tooltipDay) {
      tooltipDay = day;
      tooltipSort = { key: primaryMetric(), dir: "desc" };
    }
    renderTooltip();
    positionTooltip(clientX, clientY);
  }

  function onTooltipClick(e) {
    // Any click that reaches the tooltip is fully handled right here — never
    // let it bubble to the document "click outside to unpin" listener below.
    // That matters beyond tidiness: sorting rebuilds the table via innerHTML,
    // which detaches the clicked <th>, so by the time a bubbled event reached
    // the document listener, tooltip.contains(e.target) would check a node
    // no longer in the tree and read as "clicked outside" — closing the
    // tooltip right after every sort click.
    e.stopPropagation();
    if (e.target.closest(".aap-tt-close")) return hideTooltip();
    const th = e.target.closest("th[data-sort]");
    if (!th || tooltipDay == null) return;
    const key = th.dataset.sort;
    tooltipSort =
      tooltipSort.key === key
        ? { key, dir: tooltipSort.dir === "desc" ? "asc" : "desc" }
        : { key, dir: key === "name" ? "asc" : "desc" }; // names default A→Z, numbers default high→low
    renderTooltip();
  }

  function renderTooltip() {
    const tooltip = document.querySelector(".aap-tooltip");
    const day = tooltipDay;
    if (!tooltip || day == null || !lastData) return;

    const pinned = pinnedDay === day;
    tooltip.classList.toggle("aap-tt-pinned", pinned);

    const dm = (lastData.dayMetrics || {})[day];
    const metric = primaryMetric();
    const metricDef = METRICS.find((m) => m.key === metric);
    const headlineValue = metric === "revenue" ? AAPF.money(dm?.revenue ?? 0) : AAPF.compact(dm?.[metric] ?? 0);

    // Only a pinned tooltip has pointer-events, so this affordance would be
    // misleading (and inert) on a plain hover preview.
    let html = pinned
      ? `<div class="aap-tt-pin-bar">📌 Pinned — click the bar again or press Esc to close<button type="button" class="aap-tt-close" aria-label="Close">×</button></div>`
      : "";

    // Headline metric + value up top (matching Apify's own tooltip), date
    // just below it, then our fuller day/actor breakdown underneath.
    html += `<div class="aap-tt-header">`;
    html += `<span class="aap-tt-dot" style="background:${metricDef.color}"></span>`;
    html += `<span class="aap-tt-header-label">${metricDef.label}</span>`;
    html += `<span class="aap-tt-header-value">${headlineValue}</span>`;
    html += "</div>";
    html += `<div class="aap-tt-date">${AAPF.shortDate(day)}</div>`;
    html += '<div class="aap-tt-stats">';
    html += `<span>Revenue <b>${AAPF.money(dm?.revenue ?? 0)}</b></span>`;
    html += `<span>Costs <b>${AAPF.money(dm?.cost ?? 0)}</b></span>`;
    html += `<span>Profit <b>${AAPF.money(dm?.profit ?? 0)}</b></span>`;
    html += `<span>Margin <b>${dm?.margin != null ? AAPF.pct(dm.margin) : "–"}</b></span>`;
    html += `<span>Runs <b>${AAPF.compact(dm?.runs ?? 0)}</b></span>`;
    html += `<span>Results <b>${AAPF.compact(dm?.results ?? 0)}</b></span>`;
    html += `<span>Success <b>${dm?.successRate != null ? AAPF.pct(dm.successRate) : "–"}</b></span>`;
    html += "</div>";

    // The Actor count is always picked by the active headline metric —
    // clicking a column header only reorders that same set, it never swaps
    // which Actors are shown.
    const ranked = [...(lastData.daily?.[day] || [])].sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
    const visibleActorCount = Math.min(MAX_TOOLTIP_ACTOR_COUNT, tooltipActorCount);
    const topActors = ranked.slice(0, visibleActorCount);

    if (topActors.length) {
      const sortDir = tooltipSort.dir === "asc" ? 1 : -1;
      const sorted = [...topActors].sort((a, b) => {
        if (tooltipSort.key === "name") return sortDir * a.name.localeCompare(b.name);
        return sortDir * ((a[tooltipSort.key] || 0) - (b[tooltipSort.key] || 0));
      });

      html += `<div class="aap-tt-subtitle">Top ${visibleActorCount} Actors by ${METRICS.find((m) => m.key === metric).label}</div>`;
      html += '<table class="aap-tt-table"><thead><tr>';
      for (const col of TOOLTIP_COLUMNS) {
        const isSortCol = tooltipSort.key === col.sort;
        const arrow = isSortCol ? `<span class="aap-tt-sort-arrow">${tooltipSort.dir === "asc" ? "▲" : "▼"}</span>` : "";
        html += `<th data-sort="${col.sort}" class="${isSortCol ? "aap-tt-sorted" : ""}">${col.label}${arrow}</th>`;
      }
      // pinned/unpinned only changes interactivity via CSS (.aap-tt-pinned),
      // not this markup — pointer-events:none on the unpinned tooltip makes
      // the (identical) headers inert without a second code path.
      html += "</tr></thead><tbody>";
      for (const row of sorted) {
        const color = colorByActorId.get(row.actorId) || OTHER_COLOR;
        html += `<tr><td><span class="aap-tt-dot" style="background:${color}"></span>${escapeHtml(row.name)}</td>`;
        for (const col of TOOLTIP_COLUMNS.slice(1)) html += `<td>${col.fmt(row)}</td>`;
        html += "</tr>";
      }
      html += "</tbody></table>";
    } else if (lastData.indexing) {
      html += `<div class="aap-tt-note">Indexing Actors… ${lastData.progress ? `${lastData.progress.done}/${lastData.progress.total}` : ""}</div>`;
    } else {
      html += `<div class="aap-tt-note">No paid Actor activity this day.</div>`;
    }
    tooltip.innerHTML = html;
    tooltip.style.display = "block";
  }

  function positionTooltip(clientX, clientY) {
    const tooltip = document.querySelector(".aap-tooltip");
    if (!tooltip) return;
    const ttRect = tooltip.getBoundingClientRect();
    let left = clientX + 14;
    let top = clientY + 14;
    if (left + ttRect.width > window.innerWidth - 8) left = clientX - ttRect.width - 14;
    if (top + ttRect.height > window.innerHeight - 8) top = clientY - ttRect.height - 14;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideTooltip() {
    const tooltip = document.querySelector(".aap-tooltip");
    if (tooltip) {
      tooltip.style.display = "none";
      tooltip.classList.remove("aap-tt-pinned");
    }
    tooltipDay = null;
    pinnedDay = null; // any path that closes the tooltip also releases the pin
  }

  // Traces `pts` as a smooth Catmull-Rom spline converted to cubic beziers —
  // unlike a midpoint-quadratic smoother, this passes exactly through every
  // point (converted to bezier tangents from each point's neighbors), so the
  // dot markers drawn at the same points always sit right on the line.
  //
  // Each segment's control-point y is clamped to its endpoints' range: a
  // bezier never leaves its control points' convex hull, so the curve can't
  // overshoot a local extreme — without this, a steep drop into a flat run of
  // zeros swings the spline below the $0 baseline (and past axis maxima).
  function drawSmoothLine(ctx, pts) {
    ctx.beginPath();
    if (pts.length < 2) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 2) {
      ctx.lineTo(pts[1].x, pts[1].y);
      return;
    }
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const yLo = Math.min(p1.y, p2.y);
      const yHi = Math.max(p1.y, p2.y);
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = clamp(p1.y + (p2.y - p0.y) / 6, yLo, yHi);
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = clamp(p2.y - (p3.y - p1.y) / 6, yLo, yHi);
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
