/* Adds inline Original/Custom controls and range charts to the Insights page. */
(function () {
  const ROUTE_RE = /^(?:\/organization\/[^/]+)?\/actors\/insights\/monetization\/?$/;
  const RANGE_KEY = "aap.dateRange";
  const GROUPING_KEY = "aap.rangeGrouping";
  // Start the enhanced range view after the tooltip rollout even if an older
  // install had persisted the native Original view. Users can still switch
  // back to Original with the navigation toggle.
  const VIEW_KEY = "aap.monetizationView.v2";
  const CACHE_CLEAR_KEY = "aap.cacheClearedAt";
  // A range that ends before this month cannot change; keep it a day.
  const HISTORICAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  // Keep the range snapshot stable for a few minutes. Live day totals are
  // still refreshed separately, while the expensive multi-month range is
  // refreshed in the background without replacing the visible chart.
  const CURRENT_MONTH_CACHE_TTL_MS = 5 * 60 * 1000;
  const PARTIAL_RETRY_MS = 30 * 1000;
  const PREFETCH_MONTHS = 3;
  const RANGE_SNAPSHOT_VIEW = "range";
  const CLEAR_JITTER_MS = 2_000;
  const MAX_MEMORY_CACHE_ENTRIES = 8;
  const CONTROL_CLASS = "aap-range-selector";
  const MODE_CLASS = "aap-range-mode";
  const ORIGINAL_MODE_CLASS = "aap-monetization-original-mode";
  const QUICK_RANGES = [
    [1, "1m", "From the same day last month through today"],
    [3, "3m", "From the same day three months ago through today"],
    [6, "6m", "From the same day six months ago through today"],
    [12, "1y", "From the same day last year through today"],
  ];

  const CHART_DEFS = [
    { key: "money", heading: "Monetization statistics", label: "Revenue", color: "#12966f", value: (d) => d.revenue, type: "bar" },
    { key: "cost", heading: "Cost per 1,000 results", label: "Cost", color: "#f59e0b", value: (d) => d.costPerThousandResults, type: "bar" },
    { key: "results", heading: "Daily results", label: "Results", color: "#fb7185", value: (d) => d.results, type: "line" },
    {
      key: "runs",
      heading: "Daily runs",
      label: "Runs",
      series: [
        { key: "succeeded", label: "Succeeded", color: "#12966f", value: (d) => d.succeeded, type: "bar" },
        { key: "aborted", label: "Aborted", color: "#f59e0b", value: (d) => d.aborted, type: "bar" },
        { key: "failed", label: "Failed", color: "#ef4444", value: (d) => d.failed, type: "bar" },
        { key: "timedOut", label: "Timed out", color: "#a855f7", value: (d) => d.timedOut, type: "bar" },
      ],
    },
    {
      key: "users",
      heading: "User statistics",
      series: [
        // Paying users take Bamboo, the color revenue wears; free users take
        // the Console accent. Each resolves per theme from the chart tokens.
        { key: "payingUsers", label: "Paying users", color: "#12976f", token: "--aap-range-chart-paying", fill: true },
        { key: "freeUsers", label: "Free users", color: "#246dff", token: "--aap-range-chart-free" },
      ],
    },
  ];
  // The Monetization chart's tabs, keyed by the id Apify gives each tab link.
  // Each answers its own question: where revenue comes from (stacked by
  // Actor), whether spend is creeping up (one Coral bar per period against
  // its average), whether a day made or lost money, and whether pricing
  // holds up (margin as a line against the overall margin).
  const MONEY_TABS = {
    revenueUsd: { metric: "revenue", label: "Revenue", kind: "actors", sort: "revenue", hint: "Pin a bar to see which Actors earned it." },
    costUsd: { metric: "cost", label: "Costs", kind: "total", sort: "cost", hint: "The dashed line is the average. Pin a bar to see which Actors cost the most." },
    profitUsd: { metric: "profit", label: "Profit", kind: "signed", sort: "profit", hint: "Revenue minus costs; red bars lost money. The dashed line is the average." },
    margin: { metric: "margin", label: "Margin", kind: "ratio", sort: "revenue", hint: "Profit as a share of revenue; the dashed line is the overall margin. Periods without revenue are left out." },
  };
  const DEFAULT_MONEY_TAB = "revenueUsd";
  const NEGATIVE_COLOR = "#ef4444";
  const MARGIN_FLOOR = -1;
  const ACTOR_COLOR_PALETTE = ["#2dd4bf", "#60a5fa", "#f472b6", "#facc15", "#a78bfa", "#fb923c", "#34d399", "#f87171"];
  const MUTED_ACTOR_COLOR = "#6b7280";
  const TOOLTIP_ACTOR_COUNT_KEY = "aap.tooltipActorCount";
  const DEFAULT_TOOLTIP_ACTOR_COUNT = 20;
  const MAX_TOOLTIP_ACTOR_COUNT = 100;

  const state = {
    observedMonth: null,
    actorIds: [],
    nativeActorIds: [],
    // The Plus view's own Actor filter ([] = every Actor). Apify's picker is
    // hidden in this view, so this replaces it; Original keeps Apify's.
    customActorIds: [],
    range: null,
    grouping: "day",
    view: "custom",
    data: null,
    rawData: null,
    partial: null,
    error: null,
    loading: false,
    refreshing: false,
    loadedKey: null,
    loadingKey: null,
    loadTag: null,
    retryAt: 0,
    loadId: 0,
  };

  const memoryCache = new Map();
  let adjacentPrefetched = false;
  const actorDetailCache = new Map();
  let tooltipLoadId = 0;
  let actorPrefetchKey = null;
  let actorPrefetchRun = 0;
  let tooltipActorCount = DEFAULT_TOOLTIP_ACTOR_COUNT;
  AAP_API.onTokenChange?.(() => {
    // A tab can stay open while the user logs out or switches accounts. Do
    // not retain or display the previous account's range data in that case.
    memoryCache.clear();
    actorDetailCache.clear();
    tooltipLoadId++;
    actorPrefetchKey = null;
    actorPrefetchRun++;
    adjacentPrefetched = false;
    resetActorFilter();
    resetRangeData();
    if (state.view === "custom" && canLoad()) {
      renderRangeView();
      loadRange();
    }
  });
  // A stale cached response was refreshed in the background: reload the range
  // (now served from the fresh cache) so the charts show the new numbers.
  let revalidationTimer = null;
  let revalidationPending = false;
  AAP_API.onRevalidated?.(({ path }) => {
    if (!path || path === "public" || state.view !== "custom") return;
    clearTimeout(revalidationTimer);
    revalidationTimer = setTimeout(reloadRevalidated, 800);
  });

  function reloadRevalidated() {
    const key = dataKey();
    if (!key) return;
    // A load in flight may already have read the older copy: reload once it
    // ends rather than dropping the newer numbers until the cache expires.
    if (state.loading || state.refreshing) {
      revalidationPending = true;
      return;
    }
    revalidationPending = false;
    // Refresh in place: the chart and its loaded Actor colors stay visible.
    memoryCache.delete(key);
    if (canLoad()) loadRange();
  }
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[CACHE_CLEAR_KEY]) {
      memoryCache.clear();
      actorDetailCache.clear();
      tooltipLoadId++;
      actorPrefetchKey = null;
      actorPrefetchRun++;
      state.retryAt = 0;
      state.loadId++;
      state.loading = false;
      state.refreshing = false;
      // Keep the current chart on screen while the cleared range is fetched
      // again, instead of replacing it with a blank loading state. Each tab
      // waits a random moment so several open tabs don't all refetch at once.
      setTimeout(() => {
        if (state.view === "custom" && canLoad()) loadRange();
      }, Math.random() * CLEAR_JITTER_MS);
    }
    if (changes[TOOLTIP_ACTOR_COUNT_KEY]) {
      tooltipActorCount = normalizeTooltipActorCount(changes[TOOLTIP_ACTOR_COUNT_KEY].newValue);
      if (rangeTooltipState.canvas && rangeTooltipState.index != null) {
        renderRangeTooltip(rangeTooltipState.canvas, rangeTooltipState.index);
        positionRangeTooltip(rangeTooltipState.x, rangeTooltipState.y);
      }
    }
  });
  let selector = null;
  let fromSelect = null;
  let toSelect = null;
  let groupingSelect = null;
  let controlsStatus = null;
  let controlsError = null;
  let quickButtons = [];
  let exportButton = null;
  let exportError = null;
  let actorPicker = null;
  // The Actors the picker offers, loaded once per account.
  let actorOptions = { account: null, owned: [], loading: false, failed: false, run: 0 };
  let exportState = { running: false, done: 0, total: 0, error: null };
  let rangeTooltip = null;
  let rangeTooltipState = {
    period: null,
    tab: null,
    sort: "revenue",
    direction: "desc",
    pinned: false,
    canvas: null,
    index: null,
    x: 0,
    y: 0,
    session: null,
  };
  // Whether the Plus view owned the page at the last poll; leaving the page or
  // switching the feature off in the popup restores the native view.
  let lastActive = false;
  let pageThemeSignature = "";
  let rangeInitialized = false;

  // Switched off in the popup, the page is left fully native.
  const onInsightsRoute = () => ROUTE_RE.test(location.pathname) && (self.AAP_FEATURES?.enabled("monetization") ?? true);

  function currentMonth() {
    return new Date().toISOString().slice(0, 7);
  }

  function currentDate() {
    return new Date().toISOString().slice(0, 10);
  }

  function validRange(range) {
    const latest = currentMonth();
    if (!(range
      && AAPR.isMonth(range.start)
      && AAPR.isMonth(range.end)
      && range.start <= range.end
      && range.start <= latest
      && range.end <= latest)) return false;

    const latestDate = currentDate();
    const startDate = range.startDate || `${range.start}-01`;
    const monthEnd = AAPR.monthEnd(range.end);
    const endDate = range.endDate || (monthEnd > latestDate ? latestDate : monthEnd);
    return AAPR.isDate(startDate)
      && AAPR.isDate(endDate)
      && startDate.slice(0, 7) === range.start
      && endDate.slice(0, 7) === range.end
      && startDate <= endDate
      && startDate <= latestDate
      && endDate <= latestDate;
  }

  function monthLabel(month) {
    return AAPR.formatDate(`${month}-01`, { month: "short", year: "numeric" });
  }

  function rangeLabel(range) {
    if (!validRange(range)) return "Custom month range";
    const start = monthLabel(range.start);
    const end = monthLabel(range.end);
    return start === end ? start : `${start} – ${end}`;
  }

  function groupingLabel(grouping = state.grouping) {
    return grouping === "day" ? "day" : grouping === "month" ? "month" : "week";
  }

  function groupingAdjective(grouping = state.grouping) {
    return grouping === "day" ? "daily" : grouping === "month" ? "monthly" : "weekly";
  }

  function countLabel(count) {
    const unit = groupingLabel();
    return `${count} ${unit}${count === 1 ? "" : "s"}`;
  }

  function accountKey() {
    const org = (location.pathname.match(/^\/organization\/([^/]+)/) || [])[1] || "personal";
    return `${AAP_API.authScope?.() || "anonymous"}|${org}|${state.actorIds.slice().sort().join(",")}`;
  }

  function resetRangeData() {
    state.data = null;
    state.rawData = null;
    state.partial = null;
    state.error = null;
    state.loadedKey = null;
    state.retryAt = 0;
    state.loading = false;
    state.refreshing = false;
    state.loadId++;
    actorDetailCache.clear();
    tooltipLoadId++;
    actorPrefetchKey = null;
    actorPrefetchRun++;
  }

  function setActorScope(actorIds) {
    const next = [...(actorIds || [])].sort();
    if (next.join(",") === state.actorIds.join(",")) return false;
    state.actorIds = next;
    resetRangeData();
    return true;
  }

  // Plus draws the Actors chosen in its own picker; Original follows Apify's.
  function viewActorIds(view = state.view) {
    return view === "custom" ? state.customActorIds : state.nativeActorIds;
  }

  // ---- Actor filter ----------------------------------------------------------
  function filterAccount() {
    const org = (location.pathname.match(/^\/organization\/([^/]+)/) || [])[1] || "personal";
    return `${AAP_API.authScope?.() || "anonymous"}|${org}`;
  }

  // Another account's Actor ids mean nothing here: start from every Actor.
  function resetActorFilter() {
    state.customActorIds = [];
    actorOptions = { account: null, owned: [], loading: false, failed: false, run: actorOptions.run + 1 };
    actorPicker?.setSelected([]);
    actorPicker?.setActors([]);
    if (actorPicker) loadActorOptions("background");
  }

  function syncFilterAccount() {
    if (actorOptions.account && actorOptions.account !== filterAccount()) resetActorFilter();
  }

  // The owned list, plus any Actor the loaded range has data for (one since
  // deleted, or one the owned list leaves out).
  function pickerActors() {
    const catalog = AAP_ACTOR_FILTER.normalize(catalogActors(state.rawData).map((actor) => ({ id: actor.actorId, title: actor.name })));
    return AAP_ACTOR_FILTER.merge(actorOptions.owned, catalog);
  }

  function syncPickerActors() {
    actorPicker?.setActors(pickerActors(), { loading: actorOptions.loading, failed: actorOptions.failed });
  }

  async function loadActorOptions(priority = "foreground") {
    const account = filterAccount();
    if (actorOptions.account === account && (actorOptions.loading || actorOptions.owned.length)) {
      // A background load is in flight; a user waiting on the list wants it now.
      if (actorOptions.loading && priority === "foreground") AAP_API.promote?.(`actor-filter-${actorOptions.run}`);
      return;
    }
    const run = ++actorOptions.run;
    actorOptions = { account, owned: [], loading: true, failed: false, run };
    syncPickerActors();
    try {
      await AAP_API.whenReady?.();
      const raw = await AAP_API.actorList({ priority, tag: `actor-filter-${run}` });
      if (run !== actorOptions.run) return;
      actorOptions.owned = AAP_ACTOR_FILTER.normalize(raw);
      actorOptions.failed = false;
    } catch {
      if (run !== actorOptions.run) return;
      actorOptions.failed = true;
    }
    actorOptions.loading = false;
    syncPickerActors();
  }

  function onActorFilterChange(actorIds) {
    state.customActorIds = AAP_ACTOR_FILTER.normalizeIds(actorIds);
    exportState.error = null;
    if (state.view !== "custom") return;
    const previousTag = state.loadTag;
    if (!setActorScope(state.customActorIds)) return;
    // Drop the previous scope's queued requests; its snapshot stays cached,
    // so switching back to it later paints at once.
    AAP_API.cancel?.(previousTag);
    if (rangeTooltipState.pinned) hideRangeTooltip();
    renderRangeView();
    loadRange();
  }

  function adoptNativeSelection() {
    if (AAP_ACTOR_FILTER.sameIds(state.customActorIds, state.nativeActorIds)) return;
    state.customActorIds = AAP_ACTOR_FILTER.normalizeIds(state.nativeActorIds);
    actorPicker?.setSelected(state.customActorIds);
  }

  // Charts say which Actors they show whenever it is not every Actor.
  function actorScopeNote() {
    if (state.view !== "custom" || !state.customActorIds.length) return "";
    return ` Showing ${AAP_ACTOR_FILTER.summary(state.customActorIds, pickerActors())} only.`;
  }

  function dataKey() {
    if (!state.range) return null;
    const startDate = state.range.startDate || `${state.range.start}-01`;
    const endDate = state.range.endDate || AAPR.monthEnd(state.range.end);
    return `${accountKey()}|${startDate}|${endDate}`;
  }

  function apiDates(range) {
    const monthEnd = AAPR.monthEnd(range.end);
    const requestedEnd = range.endDate || monthEnd;
    return {
      start: range.startDate || `${range.start}-01`,
      end: requestedEnd > currentDate() ? currentDate() : requestedEnd,
    };
  }

  // The Console's own analytics request used to be the only signal that the
  // page was ready; the auth scope arrives earlier, so either is enough.
  function canLoad() {
    return validRange(state.range) && Boolean(state.observedMonth || AAP_API.hasToken?.());
  }

  function snapshotScope(key) {
    return key.replace(/[^a-zA-Z0-9|:._-]/g, "_").slice(0, 180);
  }

  function rangeCacheTtl(range) {
    return range.end === currentMonth() || apiDates(range).end >= currentDate()
      ? CURRENT_MONTH_CACHE_TTL_MS
      : HISTORICAL_CACHE_TTL_MS;
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function normalizeTooltipActorCount(value) {
    const count = Math.round(Number(value));
    return Number.isFinite(count) && count > 0
      ? Math.min(MAX_TOOLTIP_ACTOR_COUNT, count)
      : DEFAULT_TOOLTIP_ACTOR_COUNT;
  }

  // Storage is only a convenience for remembering the controls. It must not
  // be able to stop the range view from rendering (for example while Chrome
  // is reloading or invalidating the extension context).
  function storageGet(keys) {
    try {
      if (typeof chrome === "undefined" || !chrome.storage?.local) return Promise.resolve({});
      const result = chrome.storage.local.get(keys);
      return result && typeof result.then === "function"
        ? result.catch(() => ({}))
        : Promise.resolve(result || {});
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
      // Continue rendering even when persistence is temporarily unavailable.
    }
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

  // The Console theme can be changed without a navigation and snapshots do
  // not always contain the theme-token definitions. Resolve the actual page
  // surface once here, then expose it to both injected chart renderers.
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
    const grid = themeVariable("--color-neutral-separator-subtle") || border;
    const signature = [background, text, muted, border, backgroundMuted, grid].join("|");
    if (signature === pageThemeSignature) return false;
    pageThemeSignature = signature;
    const root = document.documentElement;
    root.style.setProperty("--aap-page-background", background);
    root.style.setProperty("--aap-page-text", text);
    root.style.setProperty("--aap-page-muted", muted);
    root.style.setProperty("--aap-page-border", border);
    root.style.setProperty("--aap-page-background-muted", backgroundMuted);
    root.style.setProperty("--aap-page-grid", grid);
    return true;
  }

  function ensureSelector() {
    if (!onInsightsRoute()) return;
    syncPageTheme();
    window.AAP_INSIGHTS_NAV?.ensureViewToggle("monetization", state.view, setViewMode);
    const native = document.querySelector('[data-test="select-using-cycle"]');
    if (!native) return;

    if (selector && selector.isConnected) {
      const controlParent = native.parentElement;
      if (controlParent && selector.parentElement !== controlParent) {
        controlParent.insertBefore(selector, controlParent.firstElementChild);
      } else if (controlParent && selector !== controlParent.firstElementChild) {
        controlParent.insertBefore(selector, controlParent.firstElementChild);
      }
      syncSelector();
      return;
    }

    selector = createElement("div", CONTROL_CLASS);
    selector.dataset.aapRangeControl = "true";

    const customControls = createElement("div", "aap-range-custom-controls");
    const fields = createElement("div", "aap-range-fields");
    const fromField = createElement("label", "aap-range-field");
    fromField.appendChild(createElement("span", "aap-range-field-label", "From"));
    fromSelect = monthSelect();
    fromSelect.setAttribute("aria-label", "From month");
    fromSelect.addEventListener("change", onRangeInput);
    fromField.appendChild(selectWrap(fromSelect));
    const toField = createElement("label", "aap-range-field");
    toField.appendChild(createElement("span", "aap-range-field-label", "To"));
    toSelect = monthSelect();
    toSelect.setAttribute("aria-label", "To month");
    toSelect.addEventListener("change", onRangeInput);
    toField.appendChild(selectWrap(toSelect));
    fields.append(fromField, toField);

    const quickRanges = createElement("div", "aap-range-quick-ranges");
    quickRanges.setAttribute("aria-label", "Quick date ranges");
    quickButtons = [];
    for (const [months, label, title] of QUICK_RANGES) {
      const quickButton = createElement("button", "aap-range-quick-button", label);
      quickButton.type = "button";
      quickButton.title = title;
      quickButton.setAttribute("aria-label", title);
      quickButton.addEventListener("click", () => applyQuickRange(months));
      quickButtons.push({ button: quickButton, months });
      quickRanges.appendChild(quickButton);
    }

    const grouping = createElement("label", "aap-range-grouping");
    groupingSelect = document.createElement("select");
    groupingSelect.setAttribute("aria-label", "Group range data by");
    for (const [value, text] of [["day", "Group by Day"], ["week", "Group by Week"], ["month", "Group by Month"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      groupingSelect.appendChild(option);
    }
    groupingSelect.addEventListener("change", changeGrouping);
    grouping.appendChild(selectWrap(groupingSelect));

    exportButton = createElement("button", "aap-range-export-button", "Download JSON");
    exportButton.type = "button";
    exportButton.addEventListener("click", downloadRangeExport);

    if (self.AAP_ACTOR_PICKER) {
      actorPicker?.destroy();
      actorPicker = AAP_ACTOR_PICKER.create({ onChange: onActorFilterChange });
      actorPicker.onOpen(() => loadActorOptions("foreground"));
      actorPicker.setSelected(state.customActorIds);
      syncPickerActors();
      customControls.append(actorPicker.element);
    }
    customControls.append(fields, quickRanges, grouping, exportButton);

    controlsError = createElement("span", "aap-range-input-error");
    const error = controlsError;
    error.hidden = true;
    controlsStatus = createElement("div", "aap-range-status");
    exportError = createElement("span", "aap-range-input-error");
    exportError.hidden = true;
    selector.append(customControls, error, exportError, controlsStatus);
    const controlParent = native.parentElement;
    if (controlParent) controlParent.insertBefore(selector, controlParent.firstElementChild);
    else native.insertAdjacentElement("beforebegin", selector);
    populateMonthSelect(fromSelect);
    populateMonthSelect(toSelect);
    syncSelector();
    // Load the list quietly so a single chosen Actor's name is ready.
    if (actorPicker) loadActorOptions("background");
  }

  function monthSelect() {
    return document.createElement("select");
  }

  function selectWrap(select) {
    const wrap = createElement("span", "aap-range-select-wrap");
    wrap.appendChild(select);
    return wrap;
  }

  function populateMonthSelect(select) {
    if (!select) return;
    select.replaceChildren();
    const date = new Date(`${currentMonth()}-01T00:00:00Z`);
    // Match the native Insights selector's newest-first month order while
    // keeping enough history for long-lived Actors.
    for (let index = 0; index < 120; index++) {
      const month = date.toISOString().slice(0, 7);
      const option = document.createElement("option");
      option.value = month;
      option.textContent = monthLabel(month);
      select.appendChild(option);
      date.setUTCMonth(date.getUTCMonth() - 1);
    }
  }

  function ensureMonthOption(select, month) {
    if (!select || !AAPR.isMonth(month) || select.querySelector(`option[value="${month}"]`)) return;
    const option = document.createElement("option");
    option.value = month;
    option.textContent = monthLabel(month);
    select.appendChild(option);
  }

  function defaultRange() {
    return quickRange(1);
  }

  function initializeDefaultRange() {
    if (rangeInitialized) return;
    rangeInitialized = true;
    if (validRange(state.range)) return;
    state.range = defaultRange();
    storageSet({ [RANGE_KEY]: state.range });
    if (state.view === "custom") setRangeMode(true);
  }

  function validateInputs() {
    if (!fromSelect || !toSelect) return false;
    const valid = validRange({ start: fromSelect.value, end: toSelect.value });
    if (controlsError) {
      controlsError.hidden = valid;
      controlsError.textContent = valid ? "" : `Choose a valid range up to ${monthLabel(currentMonth())}.`;
    }
    return valid;
  }

  function onRangeInput() {
    if (!validateInputs()) return;
    applyRange();
  }

  function offsetDate(months) {
    const date = new Date();
    const day = date.getUTCDate();
    const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return target.toISOString().slice(0, 10);
  }

  function quickRange(months) {
    const startDate = offsetDate(months);
    return {
      start: startDate.slice(0, 7),
      end: currentMonth(),
      startDate,
      endDate: currentDate(),
    };
  }

  function applyQuickRange(months) {
    const range = quickRange(months);
    if (fromSelect) fromSelect.value = range.start;
    if (toSelect) toSelect.value = range.end;
    applyRange(range);
  }

  function applyRange(nextRange = null) {
    const selectedRange = nextRange || { start: fromSelect?.value, end: toSelect?.value };
    if (!validRange(selectedRange)) {
      validateInputs();
      return;
    }
    if (validRange(state.range)
      && state.range.start === selectedRange.start
      && state.range.end === selectedRange.end
      && (state.range.startDate || null) === (selectedRange.startDate || null)
      && (state.range.endDate || null) === (selectedRange.endDate || null)) return;
    state.range = selectedRange;
    exportState.error = null;
    rangeInitialized = true;
    resetRangeData();
    storageSet({ [RANGE_KEY]: state.range });
    if (state.view !== "custom") setViewMode("custom");
    else setRangeMode(true);
    loadRange();
  }

  function syncSelector() {
    if (onInsightsRoute()) window.AAP_INSIGHTS_NAV?.ensureViewToggle("monetization", state.view, setViewMode);
    else window.AAP_INSIGHTS_NAV?.removeViewToggle("monetization");
    if (!selector) return;
    const custom = state.view === "custom";
    const customControls = selector.querySelector(".aap-range-custom-controls");
    if (customControls) customControls.hidden = !custom;
    if (!custom) actorPicker?.close();
    const activeRange = validRange(state.range) ? state.range : defaultRange();
    ensureMonthOption(fromSelect, activeRange.start);
    ensureMonthOption(toSelect, activeRange.end);
    if (fromSelect) fromSelect.value = activeRange.start;
    if (toSelect) toSelect.value = activeRange.end;
    if (groupingSelect) groupingSelect.value = state.grouping;
    for (const { button, months } of quickButtons) {
      button.classList.toggle("aap-range-quick-button-active", rangesEqual(state.range, quickRange(months)));
    }
    syncExportButton();

    if (controlsStatus) {
      if (!custom) controlsStatus.textContent = "";
      else if (state.error) controlsStatus.textContent = "Range could not be loaded";
      else if (state.partial) controlsStatus.textContent = `${state.partial.failedCount} Actor${state.partial.failedCount === 1 ? "" : "s"} unavailable — retrying`;
      else if (state.loading && !state.data) controlsStatus.textContent = "Loading range…";
      else if (validRange(state.range) && state.data) controlsStatus.textContent = countLabel(state.data.days.length);
      else controlsStatus.textContent = "";
    }
    if (controlsError && !custom) controlsError.hidden = true;
  }

  // ---- Analytics export ----------------------------------------------------
  // Apify's Export button downloads one month. This fetches that same file for
  // every month of the range and merges them into one download.
  function syncExportButton() {
    if (!exportButton) return;
    const range = validRange(state.range) ? state.range : null;
    exportButton.disabled = !range || exportState.running;
    exportButton.textContent = exportState.running
      ? `Preparing ${exportState.done}/${exportState.total}…`
      : "Download JSON";
    exportButton.title = range
      ? `Download Apify's analytics export for ${rangeLabel(range)} as one JSON file`
      : "Choose a range to download";
    if (exportError) {
      exportError.hidden = !exportState.error;
      exportError.textContent = exportState.error || "";
    }
  }

  function saveJson(data, name) {
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  // "/actor-analytics/export -> HTTP 429" reads as "HTTP 429".
  function exportFailureReason(error) {
    return String(error?.message || "unknown error").replace(/^\/\S+ -> /, "");
  }

  async function downloadRangeExport() {
    if (exportState.running || !validRange(state.range)) return;
    const { start, end } = state.range;
    const months = AAP_ANALYTICS_EXPORT.exportMonths(start, end);
    const actorIds = [...state.actorIds];
    exportState = { running: true, done: 0, total: months.length, error: null };
    syncExportButton();
    try {
      await AAP_API.whenReady?.();
      const scope = AAP_API.authScope?.();
      // Apify's export leaves its marketing counts at 0; the monthly
      // marketing statistics fill them in. A month whose statistics fail
      // keeps Apify's value, and the file's notes say which.
      const marketingTask = AAP_API.pooled(
        months,
        (month, _index, options) => AAP_API.acquisitionData(`${month}T00:00:00.000Z`, actorIds, options),
      );
      const results = await AAP_API.pooled(
        months,
        (month, _index, options) => AAP_API.analyticsExport(month, actorIds, options),
        (done) => {
          exportState.done = done;
          syncExportButton();
        },
        // Apify answers one export at a time per account, as its own button
        // asks for them; overlapping requests fail.
        { concurrency: 1 },
      );
      const marketing = await marketingTask;
      // The tab switched accounts while the months loaded.
      if (AAP_API.authScope?.() !== scope) throw new Error("account changed");
      if (results.failures.length) {
        const failures = [...results.failures].sort((left, right) => left.index - right.index);
        const failed = failures.map((failure) => monthLabel(failure.item.slice(0, 7)));
        const reasons = [...new Set(failures.map((failure) => exportFailureReason(failure.error)))];
        throw new Error(`${failed.join(", ")} could not be loaded (${reasons.join("; ")})`);
      }
      const merged = AAP_ANALYTICS_EXPORT.merge(months.map((month, index) => ({
        month,
        data: results[index],
        marketing: marketing[index],
      })));
      saveJson(merged, AAP_ANALYTICS_EXPORT.fileName(start, end));
      exportState = { running: false, done: 0, total: 0, error: null };
    } catch (error) {
      const reason = error?.message === "account changed" ? "The account changed during the download" : error?.message;
      exportState = { running: false, done: 0, total: 0, error: `Download failed: ${reason || "try again"}.` };
    }
    syncExportButton();
  }

  function rangesEqual(left, right) {
    return validRange(left) && validRange(right)
      && left.start === right.start
      && left.end === right.end
      && (left.startDate || null) === (right.startDate || null)
      && (left.endDate || null) === (right.endDate || null);
  }

  function changeGrouping() {
    const selected = groupingSelect?.value;
    state.grouping = selected === "day" || selected === "month" ? selected : "week";
    storageSet({ [GROUPING_KEY]: state.grouping });
    if (state.rawData) {
      const actorDetails = state.data?.actorDetails || new Map();
      state.data = AAPR.group(state.rawData, state.grouping);
      state.data.actorDetails = actorDetails;
    }
    renderRangeView();
  }

  function setRangeMode(active) {
    const root = document.documentElement;
    root.classList.toggle(MODE_CLASS, active);
    root.classList.toggle(ORIGINAL_MODE_CLASS, !active && state.view === "original");
    syncSelector();
    if (active) renderRangeView();
    else restoreNativeView();
  }

  function setViewMode(mode) {
    const next = mode === "original" ? "original" : "custom";
    const modeMatches = (next === "custom") === document.documentElement.classList.contains(MODE_CLASS);
    const originalClassMatches = next === "original"
      ? document.documentElement.classList.contains(ORIGINAL_MODE_CLASS)
      : !document.documentElement.classList.contains(ORIGINAL_MODE_CLASS);
    if (state.view === next && modeMatches && originalClassMatches) {
      syncSelector();
      return;
    }
    state.view = next;
    storageSet({ [VIEW_KEY]: next });
    document.documentElement.classList.toggle(ORIGINAL_MODE_CLASS, next === "original");
    setActorScope(viewActorIds(next));
    if (next === "custom") {
      if (!validRange(state.range)) {
        state.range = defaultRange();
        storageSet({ [RANGE_KEY]: state.range });
      }
      setRangeMode(true);
      loadRange();
    } else {
      setRangeMode(false);
    }
  }

  function chartWrappers() {
    return [...document.querySelectorAll('[data-test="chart-wrapper"]')];
  }

  const NATIVE_EMPTY_SELECTOR = '[data-test="common-empty-state"]';

  // Every chart to draw, as { wrapper, definition }. When Apify has no data
  // for its own (hidden) selection it renders an empty state in place of the
  // chart, sometimes without the chart wrapper; Plus still draws its range
  // there, since its range and Actors can differ from Apify's month.
  function chartSlots() {
    const slots = [];
    const drawn = new Set();
    for (const wrapper of chartWrappers()) {
      const definition = definitionFor(wrapper);
      if (!definition || drawn.has(definition.key)) continue;
      drawn.add(definition.key);
      slots.push({ wrapper, definition });
    }
    for (const heading of document.querySelectorAll("h3")) {
      const definition = CHART_DEFS.find((item) => item.heading === heading.textContent?.trim());
      const section = heading.parentElement;
      if (!definition || drawn.has(definition.key) || !section) continue;
      const empty = section.querySelector(NATIVE_EMPTY_SELECTOR);
      if (!empty) continue;
      // The section's child holding the empty state stands in for the chart
      // wrapper, so the heading lookups in definitionFor() still work.
      let wrapper = empty;
      while (wrapper.parentElement && wrapper.parentElement !== section) wrapper = wrapper.parentElement;
      if (wrapper.parentElement !== section || wrapper === heading) continue;
      drawn.add(definition.key);
      slots.push({ wrapper, definition });
    }
    return slots;
  }

  // A chart box of Plus's own, placed where Apify shows its empty state.
  function fallbackHost(wrapper, definition) {
    const empty = wrapper.matches?.(NATIVE_EMPTY_SELECTOR) ? wrapper : wrapper.querySelector(NATIVE_EMPTY_SELECTOR);
    let host = wrapper.querySelector(".aap-range-fallback-host");
    if (!empty) return host;
    if (!host || host.nextElementSibling !== empty) {
      host?.remove();
      host = createElement("div", "aap-range-fallback-host");
      host.dataset.chart = definition.key;
      empty.parentElement.insertBefore(host, empty);
    }
    empty.classList.add("aap-range-native-empty");
    return host;
  }

  function removeFallbackHosts(root = document) {
    root.querySelectorAll(".aap-range-fallback-host").forEach((element) => element.remove());
    root.querySelectorAll(".aap-range-native-empty").forEach((element) => element.classList.remove("aap-range-native-empty"));
  }

  function definitionFor(wrapper) {
    const heading = wrapper.parentElement?.querySelector("h3")?.textContent?.trim();
    return CHART_DEFS.find((definition) => heading === definition.heading) || null;
  }

  // Apify marks the selected tab with an "_active" class; Revenue is its
  // default.
  function activeMoneyTab(wrapper) {
    for (const id of Object.keys(MONEY_TABS)) {
      for (let node = wrapper?.querySelector(`a#${id}`); node && node !== wrapper; node = node.parentElement) {
        if (node.classList.contains("_active") || node.getAttribute("aria-selected") === "true") return id;
      }
    }
    return DEFAULT_MONEY_TAB;
  }

  function nativeChartHost(wrapper, definition) {
    return definition.key === "money"
      ? wrapper.querySelector('[class*="PaidActorProfitMarginChart"]')
      : wrapper.querySelector("canvas:not(.aap-range-chart):not(.aap-chart)")?.parentElement || null;
  }

  function chartHost(wrapper, definition) {
    const native = nativeChartHost(wrapper, definition);
    if (native) {
      // Apify's chart is back (its data loaded): drop the stand-in box.
      if (wrapper.querySelector(".aap-range-fallback-host")) removeFallbackHosts(wrapper);
      return native;
    }
    return fallbackHost(wrapper, definition);
  }

  function rememberStyle(element, property) {
    const key = `aapRangePrevious${property[0].toUpperCase()}${property.slice(1)}`;
    if (!(key in element.dataset)) element.dataset[key] = element.style[property];
    return key;
  }

  function setRangeChartReady(chart, ready, preserveVisible = false) {
    const { host, overlay } = chart;
    if (preserveVisible && !ready && overlay.dataset.aapReady === "true") return;
    overlay.dataset.aapReady = ready ? "true" : "false";
    overlay.style.visibility = ready ? "visible" : "hidden";
    // Keep the native chart as the fallback until this replacement has a
    // usable size and has completed a draw. The range view owns this canvas
    // while active, so the month-view renderer deliberately leaves it alone.
    for (const canvas of host.querySelectorAll("canvas:not(.aap-range-chart):not(.aap-chart)")) {
      // Apify's chart can leave its hover tooltip visible when its canvas is
      // hidden by the Plus chart. Send the same event it expects when the
      // pointer leaves the chart before changing visibility, otherwise that
      // tooltip can remain frozen behind the replacement chart.
      canvas.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
      canvas.style.visibility = ready ? "hidden" : "";
    }
  }

  function ensureRangeChart(wrapper, definition) {
    const host = chartHost(wrapper, definition);
    if (!host) return null;
    rememberStyle(host, "position");
    if (getComputedStyle(host).position === "static") host.style.position = "relative";

    let overlay = host.querySelector(`.aap-range-chart-overlay[data-chart="${definition.key}"]`);
    if (!overlay) {
      overlay = createElement("div", "aap-range-chart-overlay");
      overlay.dataset.chart = definition.key;
      const canvas = document.createElement("canvas");
      canvas.className = "aap-range-chart";
      canvas.setAttribute("aria-label", `${definition.heading} for selected date range`);
      const legend = createElement("div", "aap-range-legend");
      overlay.append(canvas, legend);
      canvas.addEventListener("mousemove", onRangeChartHover);
      canvas.addEventListener("mouseleave", () => {
        if (!rangeTooltipState.pinned) hideRangeTooltip();
      });
      canvas.addEventListener("click", onRangeChartClick);
      host.appendChild(overlay);
    }
    overlay.style.display = "";
    const chart = { host, overlay, canvas: overlay.querySelector("canvas"), legend: overlay.querySelector(".aap-range-legend") };
    setRangeChartReady(chart, overlay.dataset.aapReady === "true");
    return chart;
  }

  function restoreNativeView() {
    document.documentElement.classList.remove(MODE_CLASS);
    removeFallbackHosts();
    for (const wrapper of chartWrappers()) {
      const definition = definitionFor(wrapper);
      const host = definition && nativeChartHost(wrapper, definition);
      if (host) {
        for (const canvas of host.querySelectorAll("canvas:not(.aap-range-chart):not(.aap-chart)")) {
          canvas.style.visibility = "";
        }
        host.querySelectorAll(".aap-range-chart-overlay").forEach((element) => element.remove());
        const positionKey = "aapRangePreviousPosition";
        if (positionKey in host.dataset) {
          host.style.position = host.dataset[positionKey];
          delete host.dataset[positionKey];
        }
      }
      restoreOriginalText(wrapper);
      removeInsights(wrapper);
    }
    window.AAP_PORTFOLIO?.remove();
    hideRangeTooltip();
    syncSelector();
  }

  function rememberText(element) {
    if (!("aapRangeOriginalText" in element.dataset)) element.dataset.aapRangeOriginalText = element.textContent;
  }

  function restoreOriginalText(wrapper) {
    wrapper.querySelectorAll("[data-aap-range-original-text]").forEach((element) => {
      element.textContent = element.dataset.aapRangeOriginalText;
      delete element.dataset.aapRangeOriginalText;
    });
  }

  function setRangeText(element, text) {
    if (!element) return;
    rememberText(element);
    element.textContent = text;
  }

  function updateDescription(wrapper, definition) {
    const heading = wrapper.parentElement?.querySelector("h3");
    const description = heading?.nextElementSibling;
    if (!description) return;
    const grouping = groupingAdjective();
    const labels = {
      money: `Selected months: ${rangeLabel(state.range)}. Only paying users generate revenue and costs; runs by free users aren't included. ${MONEY_TABS[activeMoneyTab(wrapper)].hint}`,
      cost: `${grouping[0].toUpperCase()}${grouping.slice(1)} cost per 1,000 results for ${rangeLabel(state.range)}.`,
      results: `${grouping[0].toUpperCase()}${grouping.slice(1)} results for ${rangeLabel(state.range)}.`,
      runs: `${grouping[0].toUpperCase()}${grouping.slice(1)} runs by status for ${rangeLabel(state.range)}.`,
      users: state.grouping === "day"
        ? `Paying and free users each day for ${rangeLabel(state.range)}.`
        : `Average daily paying and free users per ${groupingLabel()} for ${rangeLabel(state.range)}.`,
    };
    setRangeText(description, `${labels[definition.key]}${actorScopeNote()}`);
  }

  function formatCount(value) {
    return Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
  }

  function compactMoney(value) {
    const amount = Number(value || 0);
    const abs = Math.abs(amount);
    const sign = amount < 0 ? "-" : "";
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
    return AAPF.money(amount);
  }

  function updateMoneySummary(wrapper, data) {
    const values = {
      costUsd: compactMoney(data.totals.cost),
      revenueUsd: compactMoney(data.totals.revenue),
      profitUsd: compactMoney(data.totals.profit),
      margin: data.totals.margin == null ? "–" : AAPF.pct(data.totals.margin),
    };
    for (const [id, value] of Object.entries(values)) {
      const tab = wrapper.querySelector(`a#${id}`);
      const badge = tab?.querySelector('[class*="badge"] span');
      setRangeText(badge, value);
    }
  }

  function updateSummary(wrapper, summary) {
    for (const panel of wrapper.querySelectorAll('[class*="SummaryPanel-content"]')) {
      const spans = panel.querySelectorAll("span");
      const label = spans[0]?.textContent?.trim().toLowerCase();
      const value = spans[1];
      if (!value) continue;
      const next = label === "average" ? summary.average : label === "minimum" ? summary.minimum : label === "maximum" ? summary.maximum : null;
      if (next != null) setRangeText(value, formatCount(next));
    }
  }

  function updateSummaries(wrapper, definition, data) {
    if (definition.key === "money") updateMoneySummary(wrapper, data);
    if (definition.key === "cost") updateSummary(wrapper, data.costsSummary);
    if (definition.key === "results") updateSummary(wrapper, data.resultsSummary);
    if (definition.key === "runs") updateSummary(wrapper, data.runsSummary);
  }

  function rangeSeries(definition, data) {
    if (definition.series) return definition.series;
    return [definition];
  }

  function catalogActors(data) {
    const byId = new Map();
    for (const actor of data?.actorCatalog || []) {
      if (!actor?.actorId) continue;
      byId.set(actor.actorId, { ...actor, activeMonths: [...(actor.activeMonths || [])] });
    }
    if (!byId.size) {
      for (const [month, actors] of Object.entries(data?.actorCatalogByMonth || {})) {
        for (const actor of actors || []) {
          if (!actor?.actorId) continue;
          const current = byId.get(actor.actorId) || {
            actorId: actor.actorId,
            name: actor.name || actor.actorId,
            totalRevenueUsd: 0,
            totalCostUsd: 0,
            activeMonths: [],
          };
          current.totalRevenueUsd += Number(actor.totalRevenueUsd) || 0;
          current.totalCostUsd += Number(actor.totalCostUsd) || 0;
          if (!current.activeMonths.includes(month)) current.activeMonths.push(month);
          current.name = actor.name || current.name;
          byId.set(actor.actorId, current);
        }
      }
    }
    return [...byId.values()];
  }

  function sourceMonths(row) {
    return [...new Set((row?.sourceDays || []).map((day) => `${day.slice(0, 7)}-01`))];
  }

  function tooltipCandidates(data, row) {
    const months = new Set(sourceMonths(row));
    return catalogActors(data)
      .filter((actor) => !months.size || actor.activeMonths?.some((month) => months.has(month)))
      .sort((left, right) =>
        Number((right.totalRevenueUsd || 0) > 0) - Number((left.totalRevenueUsd || 0) > 0)
        || (Number(right.totalRevenueUsd) || 0) - (Number(left.totalRevenueUsd) || 0)
        || String(left.name || left.actorId).localeCompare(String(right.name || right.actorId)),
      );
  }

  // Per-Actor monthly amounts behind the Runs and User statistics tooltips,
  // from the same breakdown rows as the portfolio table, and the matching
  // account-level amount of one day.
  const CATALOG_AMOUNTS = {
    runs: (row) => (Number(row?.failed) || 0) + (Number(row?.timedOut) || 0) + (Number(row?.aborted) || 0),
    users: (row) => (Number(row?.payingUsers) || 0) + (Number(row?.freeUsers) || 0),
  };

  // Whether a month's breakdown rows account for the account-level chart:
  // problem runs add up over the month, and a month's users per Actor are at
  // least any single day's. Rows that fall short (a free Actor left out, a
  // missing status) cannot pick the candidates.
  function breakdownCovers(chartKey, month, rows) {
    const amount = CATALOG_AMOUNTS[chartKey];
    const listed = rows.reduce((sum, row) => sum + amount(row), 0);
    const prefix = month.slice(0, 7);
    const days = Object.entries(state.rawData?.daily || {}).filter(([day]) => day.startsWith(prefix)).map(([, row]) => amount(row));
    const account = chartKey === "runs" ? days.reduce((sum, value) => sum + value, 0) : Math.max(0, ...days);
    return listed >= account;
  }

  // Which Actors a pinned Runs or User statistics bucket loads: those with
  // problem runs (or users) in the bucket's months, largest first. A bucket
  // with none loads nothing. When a month's rows are missing (a failed month,
  // or a range cached before the rows existed), every active Actor loads;
  // when they fall short of the chart, every other active Actor follows.
  function candidatesFor(chartKey, data, row) {
    const amount = CATALOG_AMOUNTS[chartKey];
    if (!amount) return { candidates: tooltipCandidates(data, row), scope: "all" };
    const empty = chartKey === "runs"
      ? !(Number(row.failed) + Number(row.timedOut) + Number(row.aborted) > 0)
      : !(Number(row.payingUsers) + Number(row.freeUsers) > 0);
    if (empty) return { candidates: [], scope: "none" };
    const months = sourceMonths(row);
    const rowsByMonth = data?.actorBreakdownRows || {};
    if (!months.length || months.some((month) => !Array.isArray(rowsByMonth[month]))) {
      return { candidates: tooltipCandidates(data, row), scope: "all" };
    }
    const totals = new Map();
    for (const month of months) {
      for (const actor of rowsByMonth[month]) {
        const value = amount(actor);
        if (!(value > 0)) continue;
        const current = totals.get(actor.id) || { actorId: actor.id, name: actor.title || actor.name || actor.id, total: 0, activeMonths: [] };
        current.total += value;
        current.activeMonths.push(month);
        totals.set(actor.id, current);
      }
    }
    const candidates = [...totals.values()].sort((left, right) =>
      right.total - left.total || String(left.name).localeCompare(String(right.name)));
    if (months.every((month) => breakdownCovers(chartKey, month, rowsByMonth[month]))) {
      return { candidates, scope: "filtered", months };
    }
    // The rows miss part of the chart: their Actors still load first, then
    // every other active Actor.
    const listed = new Set(candidates.map((candidate) => candidate.actorId));
    return {
      candidates: [...candidates, ...tooltipCandidates(data, row).filter((candidate) => !listed.has(candidate.actorId))],
      scope: "all",
    };
  }

  function actorRevenueRanking(data) {
    return catalogActors(data)
      .filter((actor) => Number(actor.totalRevenueUsd) > 0)
      .sort((left, right) => Number(right.totalRevenueUsd) - Number(left.totalRevenueUsd) || String(left.name).localeCompare(String(right.name)));
  }

  function actorColor(actorId, actors) {
    const index = actors.findIndex((actor) => (actor.actorId || actor[0]) === actorId);
    return index >= 0 && index < ACTOR_COLOR_PALETTE.length
      ? ACTOR_COLOR_PALETTE[index]
      : MUTED_ACTOR_COLOR;
  }

  // Range charts also start with account-level aggregates. Once those bars
  // are visible, fetch only the top colored Actors in the selected months in
  // the background. This restores accurate stacked colors progressively while
  // keeping the initial request count proportional to the selected months.
  function startActorPrefetch(data, rawData, key, loadId) {
    if (actorPrefetchKey === key) return;
    actorPrefetchKey = key;
    const run = ++actorPrefetchRun;
    const candidates = actorRevenueRanking(data).slice(0, ACTOR_COLOR_PALETTE.length);
    // Only the most recent months: a 1-year range would otherwise queue about
    // 190 background requests ahead of everything else. Older bars stay gray
    // until pinned, when their tooltip loads the Actors on demand.
    const allMonths = [...new Set((rawData?.days || []).map((day) => `${day.slice(0, 7)}-01`))].sort();
    const months = new Set(allMonths.slice(-PREFETCH_MONTHS));
    const tasks = candidates.flatMap((candidate) => {
      const activeMonths = (candidate.activeMonths || []).filter((month) => months.has(month));
      return (activeMonths.length ? activeMonths : [...months]).map((month) => ({ candidate, month, key: `${month}|${candidate.actorId}` }));
    });
    if (!tasks.length) return;

    Promise.allSettled(tasks.map(async (task) => {
      const cached = actorDetailCache.get(task.key);
      if (cached?.entry) return { task, entry: cached.entry };
      const detail = await AAP_API.actorDailyData(task.month, task.candidate.actorId, { priority: "background" });
      const entry = {
        actorId: task.candidate.actorId,
        name: task.candidate.name || task.candidate.actorId,
        margin: detail.margin,
        runs: detail.runs,
      };
      actorDetailCache.set(task.key, { entry });
      return { task, entry };
    })).then((results) => {
      // Background refreshes of the same range start new loads; the colors
      // still apply to it, so only a different range (or reset) discards them.
      if (run !== actorPrefetchRun || key !== dataKey() || !state.data) return;
      for (const result of results) {
        if (result.status === "fulfilled") state.data.actorDetails.set(result.value.task.key, result.value.entry);
      }
      if (state.data.actorDetails.size) renderRangeView(true);
    }).catch(() => {});
  }

  function chartValues(series, data) {
    return data.days.map((day) => {
      const row = data.daily[day] || {};
      return series.map((definition) => Number(definition.value ? definition.value(row) || 0 : row[definition.key] || 0));
    });
  }

  function axisValue(value, definition, step = 1) {
    if (definition.key === "money" || definition.key === "cost") {
      const decimals = step >= 1 ? (step % 1 ? 1 : 0) : step >= 0.01 ? 2 : Math.min(6, Math.max(3, Math.ceil(-Math.log10(step)) + 1));
      return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(decimals)}`;
    }
    return formatCount(value);
  }

  function updateLegend(legend, series) {
    legend.replaceChildren();
    for (const definition of series) {
      const item = createElement("span", "aap-range-legend-item");
      const dot = createElement("span", "aap-range-dot");
      dot.style.background = definition.color;
      item.append(dot, document.createTextNode(definition.label));
      legend.appendChild(item);
    }
  }

  // ---- Chart insights ----------------------------------------------------
  // Each chart gets a strip of decision-oriented figures (replacing Apify's
  // average/min/max row) plus a one-line takeaway. Averages, extremes, and
  // trends use complete periods only: today's in-progress bucket always looks
  // like the worst day and would skew every comparison.
  const TREND_WINDOWS = { day: 7, week: 4, month: 3 };

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function isPartialPeriod(period, grouping = state.grouping) {
    const end = new Date(`${period}T00:00:00Z`);
    if (Number.isNaN(end.getTime())) return false;
    if (grouping === "week") end.setUTCDate(end.getUTCDate() + 7);
    else if (grouping === "month") end.setUTCMonth(end.getUTCMonth() + 1);
    else end.setUTCDate(end.getUTCDate() + 1);
    return end.toISOString().slice(0, 10) > todayIso();
  }

  // A week or month cut off by the range's own start or end has fewer days
  // than its neighbours (e.g. a "1m" range starting mid-week), so comparing it
  // with full buckets would show a false drop.
  function isTruncatedAtEdge(period, data) {
    return AAPR.isTruncatedBucket(period, data.grouping || state.grouping, data.start, data.end);
  }

  function completePeriods(data) {
    return data.days.filter((period) => !isPartialPeriod(period, data.grouping) && !isTruncatedAtEdge(period, data));
  }

  function shortPeriodLabel(period, grouping = state.grouping) {
    if (grouping === "month") return AAPR.formatDate(period, { month: "short", year: "numeric" });
    const day = AAPR.formatDate(period, { month: "short", day: "numeric" });
    return grouping === "week" ? `wk of ${day}` : day;
  }

  function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }

  // The fewest periods per side a trend compares.
  function trendMinimum(grouping = state.grouping) {
    return grouping === "day" ? 3 : 2;
  }

  // Compares the latest N complete periods with the N before them.
  function windowTrend(values, grouping = state.grouping) {
    const cap = TREND_WINDOWS[grouping] || 7;
    const size = Math.min(cap, Math.floor(values.length / 2));
    if (size < trendMinimum(grouping)) return null;
    const recent = average(values.slice(-size));
    const prior = average(values.slice(-size * 2, -size));
    if (!prior) return null;
    return { change: (recent - prior) / prior, size, unit: groupingLabel(grouping) };
  }

  function extremes(periods, valueOf) {
    let min = null;
    let max = null;
    for (const period of periods) {
      const value = valueOf(period);
      if (value == null || !Number.isFinite(value)) continue;
      if (!min || value < min.value) min = { period, value };
      if (!max || value > max.value) max = { period, value };
    }
    return { min, max };
  }

  function formatWhole(value) {
    return value == null ? "–" : Math.round(value).toLocaleString("en-US");
  }

  function formatCostPerThousand(value) {
    if (value == null) return "–";
    // Decide precision on the rounded value so 0.0998 shows as $0.10, not $0.100.
    return `$${value.toFixed(value >= 0.095 ? 2 : 3)}`;
  }

  function formatPercent(value, digits = 1) {
    return value == null ? "–" : `${(value * 100).toFixed(digits)}%`;
  }

  // Trend detail with an arrow and sign so direction never relies on color.
  // Without a trend yet, say when one appears rather than that it can't.
  function trendDetail(trend, higherIsBetter, grouping = state.grouping) {
    if (!trend) return { text: `Trend shows after ${trendMinimum(grouping) * 2} complete ${groupingLabel(grouping)}s`, tone: "neutral" };
    const percent = Math.abs(trend.change * 100);
    const flat = percent < 2;
    const arrow = flat ? "→" : trend.change > 0 ? "↑" : "↓";
    const sign = flat ? "" : trend.change > 0 ? "+" : "−";
    const good = trend.change > 0 === higherIsBetter;
    return {
      text: `${arrow} ${sign}${percent.toFixed(percent >= 10 ? 0 : 1)}% vs prior ${trend.size} ${trend.unit}s`,
      tone: flat ? "neutral" : good ? "good" : "bad",
    };
  }

  // Insights depend only on the grouped data object, which is replaced on
  // every load, so cache per object instead of recomputing on each poll tick.
  const insightsCache = new WeakMap();

  function chartInsights(definition, data) {
    if (!data) return null;
    let byChart = insightsCache.get(data);
    if (!byChart) {
      byChart = new Map();
      insightsCache.set(data, byChart);
    }
    if (!byChart.has(definition.key)) byChart.set(definition.key, computeChartInsights(definition, data));
    return byChart.get(definition.key);
  }

  function computeChartInsights(definition, data) {
    const grouping = data.grouping || state.grouping;
    const unit = groupingLabel(grouping);
    const complete = completePeriods(data);
    const row = (period) => data.daily[period] || {};
    const partialNote = complete.length < data.days.length ? "Today is excluded until it ends." : "";

    if (definition.key === "cost") {
      const weighted = (periods) => {
        let cost = 0;
        let results = 0;
        for (const period of periods) {
          const { costPerThousandResults: value, results: count } = row(period);
          if (value == null || !count) continue;
          cost += value * count;
          results += count;
        }
        return results ? cost / results : null;
      };
      const avgCost = weighted(complete);
      const revenue = complete.reduce((sum, period) => sum + (Number(row(period).revenue) || 0), 0);
      const results = complete.reduce((sum, period) => sum + (Number(row(period).results) || 0), 0);
      const yieldPerThousand = results ? (revenue / results) * 1000 : null;
      const values = complete.map((period) => row(period).costPerThousandResults).filter((value) => value != null);
      const trend = trendDetail(windowTrend(values, grouping), false);
      const { min, max } = extremes(complete, (period) => row(period).costPerThousandResults);
      const multiple = avgCost && yieldPerThousand ? yieldPerThousand / avgCost : null;
      const tiles = [
        { label: "Avg cost / 1K results", value: formatCostPerThousand(avgCost), detail: trend.text, tone: trend.tone, title: "Weighted by results, so busy days count more than quiet ones." },
        { label: "Revenue / 1K results", value: formatCostPerThousand(yieldPerThousand), detail: multiple ? `${multiple.toFixed(multiple >= 10 ? 0 : 1)}× the cost to produce` : "No revenue in this range", tone: "neutral", title: "Total revenue divided by all results (paying and free users)." },
        { label: `Cheapest ${unit}`, value: formatCostPerThousand(min?.value), detail: min ? shortPeriodLabel(min.period, grouping) : "–", tone: "neutral" },
        { label: `Costliest ${unit}`, value: formatCostPerThousand(max?.value), detail: max ? shortPeriodLabel(max.period, grouping) : "–", tone: max && avgCost && max.value > avgCost * 1.5 ? "warning" : "neutral" },
      ];
      let takeaway = "Cost per 1,000 results is stable.";
      if (trend.tone === "good") takeaway = "Cost per 1,000 results is falling, so each result is getting cheaper to produce.";
      else if (trend.tone === "bad") takeaway = `Cost per 1,000 results is rising. Check the costliest ${unit} for expensive runs.`;
      return { tiles, takeaway, note: partialNote, average: avgCost };
    }

    if (definition.key === "results") {
      const values = complete.map((period) => Number(row(period).results) || 0);
      const total = data.days.reduce((sum, period) => sum + (Number(row(period).results) || 0), 0);
      const avg = average(values);
      const trend = trendDetail(windowTrend(values, grouping), true);
      const { max } = extremes(complete, (period) => Number(row(period).results) || 0);
      const tiles = [
        { label: "Total results", value: formatWhole(total), detail: `${data.days.length} ${unit}${data.days.length === 1 ? "" : "s"} in range`, tone: "neutral" },
        { label: `Avg / ${unit}`, value: formatWhole(avg), detail: trend.text, tone: trend.tone },
        { label: `Best ${unit}`, value: formatWhole(max?.value), detail: max ? `${shortPeriodLabel(max.period, grouping)}${avg ? ` · ${(max.value / avg).toFixed(1)}× avg` : ""}` : "–", tone: "neutral" },
      ];
      let takeaway = "Result volume is steady.";
      if (trend.tone === "good") takeaway = "Result volume is growing.";
      else if (trend.tone === "bad") takeaway = "Result volume is declining. Compare with runs to see whether usage or output per run dropped.";
      return { tiles, takeaway, note: partialNote, average: avg };
    }

    if (definition.key === "runs") {
      const totals = data.days.reduce((sum, period) => {
        const current = row(period);
        sum.runs += Number(current.runs) || 0;
        sum.succeeded += Number(current.succeeded) || 0;
        return sum;
      }, { runs: 0, succeeded: 0 });
      const values = complete.map((period) => Number(row(period).runs) || 0);
      const avg = average(values);
      const successRate = totals.runs ? totals.succeeded / totals.runs : null;
      const notSucceeded = totals.runs - totals.succeeded;
      const trend = trendDetail(windowTrend(values, grouping), true);
      const { max } = extremes(complete, (period) => Number(row(period).runs) || 0);
      const spike = max && avg ? max.value / avg : null;
      const tiles = [
        { label: "Total runs", value: formatWhole(totals.runs), detail: `${formatWhole(avg)} avg / ${unit} · ${trend.text}`, tone: trend.tone },
        { label: "Success rate", value: formatPercent(successRate), detail: `${formatWhole(notSucceeded)} failed, aborted, or timed out`, tone: successRate == null ? "neutral" : successRate >= 0.98 ? "good" : successRate < 0.95 ? "bad" : "warning" },
        { label: `Peak ${unit}`, value: formatWhole(max?.value), detail: max ? `${shortPeriodLabel(max.period, grouping)}${spike ? ` · ${spike.toFixed(1)}× avg` : ""}` : "–", tone: spike && spike >= 2.5 ? "warning" : "neutral" },
      ];
      let takeaway = "Run volume and reliability look healthy.";
      if (successRate != null && successRate < 0.95) takeaway = `${formatPercent(1 - successRate)} of runs did not succeed. Click a ${unit} below to see which Actors failed.`;
      else if (spike && spike >= 2.5) takeaway = `Runs spiked to ${spike.toFixed(1)}× the average on ${shortPeriodLabel(max.period, grouping)}. Pin that ${unit} on the revenue chart to see which Actors drove it.`;
      else if (trend.tone === "bad") takeaway = "Run volume is declining.";
      return { tiles, takeaway, note: partialNote, average: avg, spike: spike && spike >= 2.5 ? max : null };
    }

    if (definition.key === "users") {
      const paying = complete.map((period) => Number(row(period).payingUsers) || 0);
      const free = complete.map((period) => Number(row(period).freeUsers) || 0);
      const avgPaying = average(paying);
      const avgFree = average(free);
      const share = avgPaying != null && avgPaying + avgFree ? avgPaying / (avgPaying + avgFree) : null;
      const rawPayingTrend = windowTrend(paying, grouping);
      const rawFreeTrend = windowTrend(free, grouping);
      const payingTrend = trendDetail(rawPayingTrend, true, grouping);
      const freeTrend = trendDetail(rawFreeTrend, true, grouping);
      const [payingSeries, freeSeries] = definition.series;
      const tiles = [
        { label: "Paying users / day", value: formatWhole(avgPaying), detail: payingTrend.text, tone: payingTrend.tone, swatch: payingSeries },
        { label: "Free users / day", value: formatWhole(avgFree), detail: freeTrend.text, tone: "neutral", swatch: freeSeries },
        { label: "Paying share", value: formatPercent(share, 0), detail: "of daily active users", tone: "neutral", title: "Average paying users divided by average paying plus free users.", share: share == null ? null : { value: share, parts: [payingSeries, freeSeries] } },
      ];
      const shareText = share == null ? "" : ` at ${formatPercent(share, 0)} paying`;
      // One complete day can't show a mix changing, so don't call it stable.
      let takeaway = rawPayingTrend || rawFreeTrend
        ? `The paying and free user mix is stable${shareText}.`
        : share == null
          ? `There aren't enough complete ${unit}s yet to compare.`
          : `${formatPercent(share, 0)} of daily active users pay. There aren't enough complete ${unit}s yet to call a trend.`;
      if (payingTrend.tone === "good") takeaway = "Paying users are growing.";
      else if (payingTrend.tone === "bad") takeaway = "Paying users are declining. Watch for churn on your top revenue Actors.";
      else if (freeTrend.tone === "good" && share != null && share < 0.3) takeaway = "Free usage is growing faster than paid usage, which is an opportunity to improve conversion.";
      return { tiles, takeaway, note: partialNote, average: null };
    }
    return null;
  }

  function nativeSummaryRow(wrapper) {
    const panels = [...wrapper.querySelectorAll('[class*="SummaryPanel-content"]')];
    if (!panels.length) return null;
    let row = panels[0];
    while (row.parentElement && row.parentElement !== wrapper && !panels.every((panel) => row.contains(panel))) {
      row = row.parentElement;
    }
    return panels.every((panel) => row.contains(panel)) && !row.querySelector("canvas") ? row : null;
  }

  function updateInsights(wrapper, definition, data) {
    const insights = definition.key === "money" ? null : chartInsights(definition, data);
    let strip = wrapper.querySelector(":scope > .aap-range-insights, .aap-range-insights");
    if (!insights) {
      strip?.remove();
      return;
    }
    const nativeRow = nativeSummaryRow(wrapper);
    if (nativeRow) {
      rememberStyle(nativeRow, "display");
      nativeRow.style.display = "none";
      nativeRow.dataset.aapRangeHiddenSummary = "true";
    }
    if (!strip) {
      strip = createElement("div", "aap-range-insights");
      strip.setAttribute("role", "group");
      strip.setAttribute("aria-label", `${definition.heading} insights`);
    }
    if (!strip.isConnected) {
      if (nativeRow?.parentElement) nativeRow.parentElement.insertBefore(strip, nativeRow);
      else wrapper.prepend(strip);
    }
    if (strip.__aapData === data) return;
    strip.__aapData = data;
    const grid = createElement("div", "aap-range-insights-grid");
    for (const tile of insights.tiles) {
      const item = createElement("div", `aap-range-insight aap-range-insight-${tile.tone || "neutral"}`);
      if (tile.title) item.title = tile.title;
      // A series' tile carries its line's key, so the figure and the line
      // read as one thing without matching colors by eye.
      const label = createElement("span", "aap-range-insight-label");
      if (tile.swatch) label.appendChild(seriesSwatch(tile.swatch));
      label.appendChild(document.createTextNode(tile.label));
      const value = createElement("strong", "aap-range-insight-value", tile.value);
      if (tile.share) value.appendChild(shareBar(tile.share));
      item.append(label, value, createElement("span", "aap-range-insight-detail", tile.detail));
      grid.appendChild(item);
    }
    const takeaway = createElement("p", "aap-range-insight-takeaway", insights.takeaway);
    if (insights.note) takeaway.appendChild(createElement("span", "aap-range-insight-note", ` ${insights.note}`));
    takeaway.title = insights.note ? `${insights.takeaway} ${insights.note}` : insights.takeaway;
    strip.replaceChildren(grid, takeaway);
  }

  function seriesSwatch(series) {
    const swatch = createElement("span", "aap-range-insight-swatch");
    swatch.style.setProperty("--aap-swatch", series.token ? `var(${series.token}, ${series.color})` : series.color);
    swatch.setAttribute("aria-hidden", "true");
    return swatch;
  }

  // One whole split into its parts: the first part's share, then the rest.
  function shareBar({ value, parts }) {
    const bar = createElement("span", "aap-range-share-bar");
    bar.setAttribute("aria-hidden", "true");
    const amounts = [value, 1 - value];
    parts.forEach((part, index) => {
      if (amounts[index] <= 0) return;
      const segment = seriesSwatch(part);
      segment.className = "aap-range-share-segment";
      segment.style.flexGrow = String(amounts[index]);
      bar.appendChild(segment);
    });
    return bar;
  }

  function removeInsights(wrapper) {
    wrapper.querySelectorAll(".aap-range-insights").forEach((element) => element.remove());
    wrapper.querySelectorAll("[data-aap-range-hidden-summary]").forEach((element) => {
      const key = "aapRangePreviousDisplay";
      element.style.display = element.dataset[key] || "";
      delete element.dataset[key];
      delete element.dataset.aapRangeHiddenSummary;
    });
  }

  // Costs' and profit's reference line is their average per complete period;
  // margin's is the range's overall margin (total profit / total revenue),
  // not an average of daily margins.
  function moneyReference(moneyTab, data, values, partial) {
    if (moneyTab?.kind === "ratio") {
      const margin = data.totals?.margin;
      return margin == null || !Number.isFinite(Number(margin)) ? null : { value: Number(margin), label: `overall ${AAPF.pct(Number(margin))}` };
    }
    if (moneyTab?.kind !== "signed" && moneyTab?.kind !== "total") return null;
    const complete = values.filter((row, index) => !partial[index]).map((row) => row[0]);
    if (!complete.length) return null;
    const average = complete.reduce((sum, value) => sum + value, 0) / complete.length;
    return { value: average, label: `avg ${AAPF.money(average)}` };
  }

  function formatMarginAxis(value, step) {
    return `${(value * 100).toFixed(step * 100 < 1 ? 1 : 0)}%`;
  }

  // A bar is rounded at the end away from zero; a stack is drawn as one bar.
  function barPath(ctx, x, from, to, width) {
    const top = Math.min(from, to);
    const height = Math.abs(to - from);
    const radius = Math.min(4, width / 4, height);
    ctx.beginPath();
    if (typeof ctx.roundRect === "function" && radius >= 1) {
      ctx.roundRect(x - width / 2, top, width, height, to <= from ? [radius, radius, 0, 0] : [0, 0, radius, radius]);
    } else {
      ctx.rect(x - width / 2, top, width, height);
    }
  }

  // Monotone curve through a run of points: smooth, but never overshoots a
  // value the way a plain spline would.
  function traceCurve(ctx, points) {
    ctx.moveTo(points[0].x, points[0].y);
    if (points.length < 3) {
      points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
      return;
    }
    const last = points.length - 1;
    const dx = [];
    const slope = [];
    for (let index = 0; index < last; index++) {
      dx[index] = points[index + 1].x - points[index].x || 1;
      slope[index] = (points[index + 1].y - points[index].y) / dx[index];
    }
    const tangent = [slope[0]];
    for (let index = 1; index < last; index++) {
      const before = slope[index - 1];
      const after = slope[index];
      tangent[index] = before * after <= 0
        ? 0
        : 3 * (dx[index - 1] + dx[index]) / ((2 * dx[index] + dx[index - 1]) / before + (dx[index] + 2 * dx[index - 1]) / after);
    }
    tangent[last] = slope[last - 1];
    for (let index = 0; index < last; index++) {
      const third = dx[index] / 3;
      ctx.bezierCurveTo(
        points[index].x + third, points[index].y + third * tangent[index],
        points[index + 1].x - third, points[index + 1].y - third * tangent[index + 1],
        points[index + 1].x, points[index + 1].y,
      );
    }
  }

  // "#rrggbb" at an opacity, for gradients; other color formats pass through.
  function colorAlpha(color, alpha) {
    const match = /^#([0-9a-f]{6})$/i.exec(color || "");
    if (!match) return color;
    const value = parseInt(match[1], 16);
    return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
  }

  function lastValueIndex(values, seriesIndex) {
    for (let index = values.length - 1; index >= 0; index--) {
      if (values[index][seriesIndex] != null && Number.isFinite(values[index][seriesIndex])) return index;
    }
    return -1;
  }

  // User statistics labels each line's end; the other charts carry a
  // reference line in that gutter instead.
  function endLabelTexts(definition, series, values, partial) {
    if (definition.key !== "users" || !values.length) return null;
    return series.map((item, seriesIndex) => {
      const index = lastValueIndex(values, seriesIndex);
      if (index < 0) return null;
      return `${formatWhole(values[index][seriesIndex])}${partial[index] ? " so far" : ""}`;
    });
  }

  function drawRangeChart(chart, definition, data, tab = null) {
    const { canvas, legend, host } = chart;
    // Keep the last successful chart visible while refreshing its data. The
    // draw is synchronous, so replacing the canvas contents completes before
    // the browser can paint; hiding it first only creates a visible flicker.
    const preserveVisible = !!data && chart.overlay.dataset.aapReady === "true" && !!canvas.__aapRange?.data;
    setRangeChartReady(chart, false, preserveVisible);
    hideHoverBand(canvas);
    const rect = host.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const fontFamily = getComputedStyle(host).fontFamily || "sans-serif";
    ctx.font = `11px ${fontFamily}`;
    ctx.textBaseline = "middle";

    const chartStyles = getComputedStyle(chart.overlay);
    const token = (name, fallback) => chartStyles.getPropertyValue(name).trim() || fallback;
    const axisColor = token("--aap-range-chart-text", "#374151");
    const mutedColor = token("--aap-range-chart-muted", axisColor);
    const gridColor = token("--aap-range-chart-grid", "rgba(17,24,39,0.14)");
    const surfaceColor = token("--aap-range-chart-surface", "#ffffff");
    const chipColor = token("--aap-range-chart-chip", "rgba(0,0,0,0.06)");
    const colors = {
      revenue: token("--aap-range-chart-positive", definition.color),
      profit: token("--aap-range-chart-positive", definition.color),
      cost: token("--aap-range-chart-cost", "#fa8238"),
      margin: token("--aap-range-chart-accent", "#246dff"),
      negative: token("--aap-range-chart-negative", NEGATIVE_COLOR),
    };

    // The Monetization chart follows its selected tab; the others have one view.
    const moneyTab = definition.key === "money" ? MONEY_TABS[tab] || MONEY_TABS[DEFAULT_MONEY_TAB] : null;
    const series = moneyTab
      ? [{
        ...definition,
        key: moneyTab.metric,
        label: moneyTab.label,
        color: colors[moneyTab.metric] || definition.color,
        value: (row) => row[moneyTab.metric],
        signed: moneyTab.kind === "signed",
        type: moneyTab.kind === "ratio" ? "line" : "bar",
      }]
      : rangeSeries(definition, data || { days: [] })
        .map((item) => item.token ? { ...item, color: token(item.token, item.color) } : item);
    const showLegend = definition.key !== "money" && series.length > 1;
    legend.style.display = showLegend ? "" : "none";
    if (showLegend) updateLegend(legend, series);
    else legend.replaceChildren();
    canvas.__aapRange = { definition, data: data || null, series, tab: moneyTab ? tab || DEFAULT_MONEY_TAB : null };
    if (!data || !data.days.length) {
      ctx.font = `12px ${fontFamily}`;
      ctx.fillStyle = mutedColor;
      ctx.textAlign = "center";
      ctx.fillText(state.loading ? "Loading selected range…" : "No data for this range", rect.width / 2, rect.height / 2);
      return;
    }

    // Margin keeps its gaps: a period without revenue has no margin.
    const ratio = moneyTab?.kind === "ratio";
    const values = ratio
      ? AAPR.moneyValues(data, "margin").map((value) => [value])
      : chartValues(series, data);
    const partial = data.days.map((period) => isPartialPeriod(period, data.grouping));
    const stackedBars = (definition.key === "money" || definition.key === "runs")
      && series.length > 1
      && series.every((item) => item.type === "bar");
    const plotted = (stackedBars
      ? values.map((row) => row.reduce((sum, value) => sum + value, 0))
      : values.flat()).filter((value) => value != null && Number.isFinite(value));
    // Margin's reference is the range's overall margin; costs' and profit's
    // is their average per period. All stay inside the scale.
    const reference = moneyReference(moneyTab, data, values, partial);
    if (reference) plotted.push(reference.value);
    // Margin zooms to its own range so a dip from 90% to 70% is visible;
    // bars always start at zero so their heights stay comparable. A day
    // with almost no revenue can reach -400%; the axis stops at -100% and
    // such a point sits on the floor, labelled with its real value.
    const scale = ratio
      ? AAPR.niceFitScale(Math.max(MARGIN_FLOOR, Math.min(...plotted)), Math.max(...plotted))
      : AAPR.niceSignedScale(moneyTab ? Math.min(0, ...plotted) : 0, Math.max(0, ...plotted));
    const minValue = scale.min;
    const maxValue = scale.max;
    const insights = definition.key === "money" ? null : chartInsights(definition, data);
    const guide = reference || (insights?.average != null && insights.average > 0
      ? { value: insights.average, label: `avg ${definition.key === "cost" ? formatCostPerThousand(insights.average) : formatWhole(insights.average)}` }
      : null);

    const top = showLegend && series.length > 1 ? 34 : 20;
    const bottom = 30;
    const axisText = (value) => ratio ? formatMarginAxis(value, scale.step) : axisValue(value, definition, scale.step);
    const tickValue = (tick) => Math.round((minValue + scale.step * tick) * 1e9) / 1e9;
    const axisLabels = Array.from({ length: scale.ticks + 1 }, (_, tick) => axisText(tickValue(tick)));
    const left = Math.max(52, ...axisLabels.map((label) => Math.ceil(ctx.measureText(label).width) + 18));
    // The reference value sits in its own gutter, clear of the bars.
    ctx.font = `500 11px ${fontFamily}`;
    const guideWidth = guide ? Math.ceil(ctx.measureText(guide.label).width) + 14 : 0;
    ctx.font = `11px ${fontFamily}`;
    // Lines are labelled at their end with their latest value, in a gutter
    // of their own; "so far" marks a period still in progress.
    const endLabels = endLabelTexts(definition, series, values, partial);
    ctx.font = `600 11px ${fontFamily}`;
    const endLabelWidth = endLabels ? Math.max(...endLabels.map((label) => label ? Math.ceil(ctx.measureText(label).width) : 0)) + 14 : 0;
    ctx.font = `11px ${fontFamily}`;
    const right = guide ? guideWidth + 10 : endLabelWidth ? endLabelWidth + 6 : 16;
    const plotWidth = Math.max(1, rect.width - left - right);
    const plotHeight = Math.max(1, rect.height - top - bottom);
    const slot = plotWidth / data.days.length;
    const yOf = (value) => top + plotHeight * (maxValue - value) / (maxValue - minValue);
    const baseline = yOf(Math.min(maxValue, Math.max(minValue, 0)));
    const barWidth = Math.max(2, Math.min(slot * 0.64, 44));
    canvas.__aapRangePlot = { left, right, top, bottom, slot, barWidth };

    // Quiet grid: hairlines, with zero (or the floor) a little stronger.
    ctx.lineWidth = 1;
    for (let tick = 0; tick <= scale.ticks; tick++) {
      const value = tickValue(tick);
      const y = Math.round(yOf(value)) + 0.5;
      ctx.save();
      ctx.strokeStyle = value === 0 && minValue < 0 ? mutedColor : gridColor;
      ctx.globalAlpha = value === 0 && minValue < 0 ? 0.5 : tick === 0 ? 1 : 0.6;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(rect.width - right, y);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = mutedColor;
      ctx.textAlign = "right";
      ctx.fillText(axisText(value), left - 10, y);
    }

    const labelEvery = Math.max(1, Math.ceil(data.days.length / 8));
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = mutedColor;
    for (let index = 0; index < data.days.length; index += labelEvery) {
      const x = left + index * slot + slot / 2;
      ctx.fillText(AAPR.formatDate(data.days[index], { month: "short", day: "numeric" }), x, rect.height - bottom + 9);
    }
    ctx.textBaseline = "middle";

    const xOf = (index) => left + index * slot + slot / 2;
    // One bar per period, its segments bottom to top. A stack is clipped to
    // one rounded bar with hairline gaps between segments; an in-progress
    // period is faded with a dashed outline so it is not read as a drop.
    const drawStack = (index, segments) => {
      const total = segments.reduce((sum, segment) => sum + segment.value, 0);
      if (!total) return;
      const x = xOf(index);
      const to = yOf(total);
      ctx.save();
      ctx.globalAlpha = partial[index] ? 0.35 : 1;
      barPath(ctx, x, baseline, to, barWidth);
      if (segments.length === 1) {
        ctx.fillStyle = segments[0].color;
        ctx.fill();
      } else {
        ctx.clip();
        let below = 0;
        for (const segment of segments) {
          const from = yOf(below);
          const end = yOf(below + segment.value);
          ctx.fillStyle = segment.color;
          ctx.fillRect(x - barWidth / 2, Math.min(from, end), barWidth, Math.abs(end - from));
          below += segment.value;
        }
        if (barWidth >= 6) {
          ctx.fillStyle = surfaceColor;
          below = 0;
          for (const segment of segments.slice(0, -1)) {
            below += segment.value;
            if (Math.abs(yOf(below) - to) > 2) ctx.fillRect(x - barWidth / 2, yOf(below) - 0.5, barWidth, 1);
          }
        }
      }
      ctx.restore();
      if (partial[index]) {
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = segments[segments.length - 1].color;
        ctx.globalAlpha = 0.85;
        barPath(ctx, x, baseline, to, barWidth - 1);
        ctx.stroke();
        ctx.restore();
      }
    };

    const coloredMoneyBars = moneyTab?.kind === "actors" && data.actorDetails?.size;
    if (coloredMoneyBars) {
      // Revenue is stacked by Actor in the Actors' ranking colors.
      const metric = moneyTab.metric;
      const detailEntries = [...data.actorDetails.values()];
      const revenueRanking = actorRevenueRanking(data);
      for (let index = 0; index < data.days.length; index++) {
        const period = data.days[index];
        const row = data.daily[period] || {};
        const segments = AAPR.actorRowsForDays(detailEntries, row.sourceDays || [period])
          .filter((actor) => Number(actor[metric]) > 0)
          .map((actor) => ({ color: actorColor(actor.actorId, revenueRanking), value: Number(actor[metric]) || 0 }));
        const accounted = segments.reduce((sum, segment) => sum + segment.value, 0);
        const total = Number(row[metric]) || 0;
        if (segments.length && total > accounted) segments.push({ color: MUTED_ACTOR_COLOR, value: total - accounted });
        if (!segments.length) segments.push({ color: series[0].color, value: total });
        drawStack(index, segments);
      }
    } else {
      const barSeries = series.map((item, seriesIndex) => ({ item, seriesIndex }))
        .filter(({ item }) => item.type === "bar" || (definition.type === "bar" && item.type !== "line"));
      for (let index = 0; index < data.days.length && barSeries.length; index++) {
        const segments = barSeries
          .map(({ item, seriesIndex }) => {
            const value = values[index][seriesIndex] || 0;
            return { value, color: item.signed && value < 0 ? colors.negative : item.color };
          })
          .filter((segment) => segment.value);
        if (stackedBars) drawStack(index, segments);
        else segments.forEach((segment) => drawStack(index, [segment]));
      }

      const lineSeries = series.map((item, seriesIndex) => ({ item, seriesIndex }))
        .filter(({ item }) => !barSeries.some((bar) => bar.item === item));
      for (const { item: current, seriesIndex } of lineSeries) {
        const points = values.map((row, index) => row[seriesIndex] == null
          ? null
          : ({ x: xOf(index), y: yOf(Math.min(maxValue, Math.max(minValue, row[seriesIndex]))), index }));
        // A gap (null) breaks the line instead of dropping it to zero; the
        // in-progress period is dashed.
        const runs = [];
        let run = [];
        points.forEach((point) => {
          if (point) run.push(point);
          else if (run.length) runs.push(run.splice(0));
        });
        if (run.length) runs.push(run);
        const solidEnd = partial.lastIndexOf(false);
        // A single line, or the line a chart is about, gets a soft fill below it.
        if ((lineSeries.length === 1 && series.length === 1) || current.fill) {
          const gradient = ctx.createLinearGradient?.(0, top, 0, top + plotHeight);
          for (const part of runs.filter((items) => items.length > 1)) {
            ctx.save();
            if (gradient?.addColorStop && colorAlpha(current.color, 1) !== current.color) {
              gradient.addColorStop(0, colorAlpha(current.color, 0.22));
              gradient.addColorStop(1, colorAlpha(current.color, 0));
              ctx.fillStyle = gradient;
            } else {
              ctx.globalAlpha = 0.1;
              ctx.fillStyle = current.color;
            }
            ctx.beginPath();
            traceCurve(ctx, part);
            ctx.lineTo(part[part.length - 1].x, top + plotHeight);
            ctx.lineTo(part[0].x, top + plotHeight);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
        }
        ctx.save();
        ctx.strokeStyle = current.color;
        ctx.lineWidth = 2;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        for (const part of runs) {
          const solid = part.filter((point) => point.index <= solidEnd);
          const dashed = part.filter((point) => point.index >= solidEnd);
          if (solid.length > 1) {
            ctx.beginPath();
            traceCurve(ctx, solid);
            ctx.stroke();
          }
          if (dashed.length > 1 && dashed.some((point) => partial[point.index])) {
            ctx.save();
            ctx.setLineDash([4, 4]);
            ctx.globalAlpha = 0.6;
            ctx.beginPath();
            traceCurve(ctx, dashed);
            ctx.stroke();
            ctx.restore();
          }
        }
        ctx.restore();
        // Points only while they stay readable; ringed in the surface color.
        // A short range has room for the full-size markers.
        if (points.length <= 62) {
          const sparse = points.length <= 14;
          points.forEach((point, index) => {
            if (!point) return;
            const negative = moneyTab && values[index][seriesIndex] < 0;
            ctx.beginPath();
            ctx.arc(point.x, point.y, sparse ? 4 : 3, 0, Math.PI * 2);
            ctx.fillStyle = partial[index] ? surfaceColor : negative ? colors.negative : current.color;
            ctx.strokeStyle = partial[index] ? current.color : surfaceColor;
            ctx.lineWidth = sparse ? 2 : 1.5;
            ctx.fill();
            ctx.stroke();
          });
        }
        // Margin: mark the weakest complete period, the one worth a look.
        if (ratio) {
          const complete = points.filter((point) => point && !partial[point.index]);
          const low = complete.reduce((lowest, point) => !lowest || values[point.index][0] < values[lowest.index][0] ? point : lowest, null);
          if (low && complete.length >= 3) {
            const value = values[low.index][0];
            ctx.beginPath();
            ctx.arc(low.x, low.y, 4.5, 0, Math.PI * 2);
            ctx.fillStyle = value < 0 ? colors.negative : current.color;
            ctx.strokeStyle = surfaceColor;
            ctx.lineWidth = 2;
            ctx.fill();
            ctx.stroke();
            const label = `Low ${AAPF.pct(value)} · ${AAPR.formatDate(data.days[low.index], { month: "short", day: "numeric" })}`;
            ctx.font = `600 11px ${fontFamily}`;
            const width = ctx.measureText(label).width;
            const x = Math.min(rect.width - right - width / 2 - 4, Math.max(left + width / 2 + 4, low.x));
            const below = low.y + 22 <= top + plotHeight;
            const textY = below ? low.y + 9 : low.y - 9;
            // A chip in the surface color keeps the label legible over the line.
            ctx.fillStyle = surfaceColor;
            ctx.globalAlpha = 0.9;
            ctx.beginPath();
            const chipY = below ? textY - 2 : textY - 15;
            if (typeof ctx.roundRect === "function") ctx.roundRect(x - width / 2 - 5, chipY, width + 10, 17, 4);
            else ctx.rect(x - width / 2 - 5, chipY, width + 10, 17);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = axisColor;
            ctx.textAlign = "center";
            ctx.textBaseline = below ? "top" : "bottom";
            ctx.fillText(label, x, textY);
            ctx.font = `11px ${fontFamily}`;
            ctx.textBaseline = "middle";
          }
        }
      }
    }

    if (endLabels) {
      const placed = endLabels.map((label, seriesIndex) => {
        const index = lastValueIndex(values, seriesIndex);
        return label && index >= 0 ? { label, x: xOf(index) + 10, y: yOf(values[index][seriesIndex]) } : null;
      }).filter(Boolean);
      // Labels nudged apart would no longer sit on their lines; when the
      // lines end too close together the legend and tooltip carry it.
      const clear = placed.every((item, index) => placed.slice(index + 1).every((other) => Math.abs(other.y - item.y) >= 15));
      if (clear) {
        ctx.save();
        ctx.font = `600 11px ${fontFamily}`;
        ctx.fillStyle = axisColor;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        for (const item of placed) ctx.fillText(item.label, item.x, Math.min(top + plotHeight - 6, Math.max(top + 6, item.y)));
        ctx.restore();
      }
    }

    if (guide && guide.value >= minValue && guide.value <= maxValue) {
      const y = Math.round(yOf(guide.value)) + 0.5;
      ctx.save();
      ctx.strokeStyle = mutedColor;
      ctx.globalAlpha = 0.75;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(rect.width - right + 4, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // A pill in the right gutter, level with the line.
      const pillX = rect.width - right + 6;
      const pillY = Math.min(rect.height - bottom - 10, Math.max(top - 10, y - 10));
      ctx.fillStyle = chipColor;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(pillX, pillY, guideWidth, 20, 10);
      else ctx.rect(pillX, pillY, guideWidth, 20);
      ctx.fill();
      ctx.font = `500 11px ${fontFamily}`;
      ctx.fillStyle = axisColor;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(guide.label, pillX + 7, pillY + 10);
      ctx.restore();
    }
    if (insights?.spike) {
      // Annotate an outlier so it reads as an event, not just a tall bar.
      const index = data.days.indexOf(insights.spike.period);
      if (index >= 0) {
        const x = xOf(index);
        const y = yOf(insights.spike.value);
        const label = `${formatWhole(insights.spike.value)} · spike`;
        ctx.save();
        ctx.font = `600 11px ${fontFamily}`;
        ctx.fillStyle = axisColor;
        ctx.textAlign = x > rect.width - right - 60 ? "right" : x < left + 60 ? "left" : "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(label, x, Math.max(top + 10, y - 4));
        ctx.restore();
      }
    }
    setRangeChartReady(chart, true);
  }

  // A soft column behind the hovered or pinned period.
  function showHoverBand(canvas, index) {
    const plot = canvas.__aapRangePlot;
    const overlay = canvas.parentElement;
    if (!plot || !overlay) return;
    let band = overlay.querySelector(".aap-range-hover-band");
    if (!band) {
      band = createElement("div", "aap-range-hover-band");
      overlay.insertBefore(band, canvas);
    }
    const width = Math.min(plot.slot, plot.barWidth + 14);
    const height = canvas.getBoundingClientRect().height - plot.top - plot.bottom;
    band.style.width = `${width}px`;
    band.style.height = `${Math.max(0, height + 8)}px`;
    band.style.top = `${plot.top - 4}px`;
    band.style.transform = `translateX(${plot.left + plot.slot * index + (plot.slot - width) / 2}px)`;
    band.classList.add("is-visible");
  }

  function hideHoverBand(canvas = null) {
    const bands = canvas
      ? [canvas.parentElement?.querySelector(".aap-range-hover-band")]
      : document.querySelectorAll(".aap-range-hover-band.is-visible");
    for (const band of bands) band?.classList.remove("is-visible");
  }

  function renderRangeView(forceDraw = true) {
    // Data can land after the user has moved to another Insights tab, whose
    // charts and table share Monetization's class names. Draw only here.
    if (!onInsightsRoute()) return;
    if (state.view !== "custom" || !validRange(state.range)) return;
    for (const { wrapper, definition } of chartSlots()) {
      let chart;
      try {
        chart = ensureRangeChart(wrapper, definition);
      } catch {
        // A React reconciliation can leave a chart wrapper half-mounted for a
        // tick. Keep that chart native and let the next poll try again.
        continue;
      }
      if (!chart) continue;
      try {
        const tab = definition.key === "money" ? activeMoneyTab(wrapper) : null;
        const needsDraw = forceDraw || chart.canvas.__aapRange?.data !== state.data || chart.canvas.__aapRange?.tab !== tab;
        if (needsDraw && chart.canvas.__aapRange?.data !== state.data) restoreOriginalText(wrapper);
        if (needsDraw) drawRangeChart(chart, definition, state.data, tab);
        // Do not overwrite native labels or summaries until the replacement
        // is ready. That keeps the fallback internally consistent if drawing
        // fails halfway through a React update or a canvas context loss.
        if (chart.overlay.dataset.aapReady === "true") {
          updateDescription(wrapper, definition);
          if (state.data) {
            updateSummaries(wrapper, definition, state.data);
            updateInsights(wrapper, definition, state.data);
          }
        }
      } catch {
        // A single malformed chart must not prevent the remaining four charts
        // from rendering. The native canvas is restored by this state change.
        setRangeChartReady(chart, false);
        restoreOriginalText(wrapper);
        removeInsights(wrapper);
      }
    }
    // The per-Actor table follows the same range; it renders a skeleton until
    // range data with per-Actor rows arrives.
    try {
      window.AAP_PORTFOLIO?.render(state.data);
    } catch {
      window.AAP_PORTFOLIO?.remove();
    }
    syncSelector();
  }

  function tooltipPeriodLabel(period) {
    const suffix = isPartialPeriod(period) ? " · in progress" : "";
    if (state.grouping === "day") return `${AAPR.formatDate(period, { month: "short", day: "numeric", year: "numeric" })}${suffix}`;
    if (state.grouping === "month") return `${AAPR.formatDate(period, { month: "short", year: "numeric" })}${suffix}`;
    return `Week of ${AAPR.formatDate(period, { month: "short", day: "numeric", year: "numeric" })}${suffix}`;
  }

  const ACTOR_TOOLTIP_COLUMNS = [
    { key: "name", label: "Actor" },
    { key: "revenue", label: "Revenue", format: (row) => AAPF.money(row.revenue) },
    { key: "cost", label: "Cost", format: (row) => AAPF.money(row.cost) },
    { key: "profit", label: "Profit", format: (row) => AAPF.money(row.profit) },
    { key: "runs", label: "Runs", format: (row) => formatCount(row.runs) },
    { key: "results", label: "Results", format: (row) => formatCount(row.results) },
  ];
  const RUN_TOOLTIP_COLUMNS = [
    { key: "name", label: "Actor" },
    { key: "failed", label: "Failed", format: (row) => formatCount(row.failed) },
    { key: "timedOut", label: "Timed out", format: (row) => formatCount(row.timedOut) },
    { key: "aborted", label: "Aborted", format: (row) => formatCount(row.aborted) },
    { key: "runs", label: "Runs", format: (row) => formatCount(row.runs) },
  ];

  const USER_TOOLTIP_COLUMNS = [
    { key: "name", label: "Actor" },
    { key: "payingUsers", label: "Paying", format: (row) => formatUsers(row.payingUsers) },
    { key: "freeUsers", label: "Free", format: (row) => formatUsers(row.freeUsers) },
    { key: "users", label: "Total", format: (row) => formatUsers(row.users) },
  ];
  // Charts whose bars can be pinned to list the Actors behind them.
  const ACTOR_DETAIL_CHARTS = ["money", "runs", "users"];

  // Week and month buckets show average users per day, so keep one decimal.
  function formatUsers(value) {
    if (value > 0 && value < 0.1) return "<0.1";
    return Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 1 });
  }

  function chartKeyOf(canvas) {
    return canvas?.__aapRange?.definition?.key || "";
  }

  function defaultTooltipSort(chartKey, canvas = null) {
    if (chartKey === "money") return MONEY_TABS[canvas?.__aapRange?.tab]?.sort || "revenue";
    return chartKey === "runs" ? "failed" : chartKey === "users" ? "users" : "revenue";
  }

  function rangeChartTarget(event) {
    const canvas = event.currentTarget;
    const plot = canvas.__aapRangePlot;
    const data = canvas.__aapRange?.data;
    if (!plot || !data?.days?.length) return null;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x < plot.left || x > rect.width - plot.right) return null;
    return {
      canvas,
      index: Math.min(data.days.length - 1, Math.max(0, Math.floor((x - plot.left) / plot.slot))),
    };
  }

  function setRangeTooltipTarget(canvas, index) {
    const period = canvas.__aapRange?.data?.days?.[index] || null;
    const chartKey = chartKeyOf(canvas);
    const sessionKey = `${dataKey() || ""}|${chartKey}|${period || ""}`;
    // A Monetization tab switch also resets the sort to that tab's metric.
    const tab = canvas.__aapRange?.tab || null;
    if (period !== rangeTooltipState.period || chartKey !== chartKeyOf(rangeTooltipState.canvas) || tab !== rangeTooltipState.tab) {
      rangeTooltipState.sort = defaultTooltipSort(chartKey, canvas);
      rangeTooltipState.direction = "desc";
      rangeTooltipState.period = period;
      rangeTooltipState.tab = tab;
    }
    if (rangeTooltipState.session?.key !== sessionKey) rangeTooltipState.session = null;
    rangeTooltipState.canvas = canvas;
    rangeTooltipState.index = index;
  }

  function sortedActorRows(rows, ranking = []) {
    const direction = rangeTooltipState.direction === "asc" ? 1 : -1;
    const rankingIndex = new Map(ranking.map((actor, index) => [actor.actorId || actor[0], index]));
    return [...rows].sort((left, right) => {
      let comparison;
      if (rangeTooltipState.sort === "name") {
        comparison = String(left.name || left.actorId).localeCompare(String(right.name || right.actorId));
      } else {
        comparison = Number(left[rangeTooltipState.sort] || 0) - Number(right[rangeTooltipState.sort] || 0);
      }
      if (comparison) return direction * comparison;
      return (rankingIndex.get(left.actorId) ?? ranking.length) - (rankingIndex.get(right.actorId) ?? ranking.length);
    });
  }

  function tooltipSession(data, row, period, chartKey) {
    const key = `${dataKey() || ""}|${chartKey}|${period || ""}`;
    if (!rangeTooltipState.session || rangeTooltipState.session.key !== key) {
      rangeTooltipState.session = {
        key,
        ...candidatesFor(chartKey, data, row),
        details: new Map(),
        requestedIds: new Set(),
        failedTasks: [],
        nextIndex: 0,
        loading: false,
        loadId: ++tooltipLoadId,
      };
    }
    return rangeTooltipState.session;
  }

  function tooltipDetailMonths(candidate, row) {
    const months = sourceMonths(row);
    const activeMonths = (candidate.activeMonths || []).filter((month) => !months.length || months.includes(month));
    return activeMonths.length ? activeMonths : months;
  }

  async function loadTooltipActors(retry = false) {
    const canvas = rangeTooltipState.canvas;
    const index = rangeTooltipState.index;
    const data = canvas?.__aapRange?.data;
    const period = data?.days?.[index];
    const row = period ? data.daily[period] || {} : null;
    const chartKey = chartKeyOf(canvas);
    const session = period && row ? tooltipSession(data, row, period, chartKey) : null;
    if (!session || session.loading || !rangeTooltipState.pinned) return;
    // Users come from their own endpoint, cached apart from revenue and runs.
    const usersChart = chartKey === "users";

    let tasks;
    if (retry) {
      tasks = [...session.failedTasks];
      session.failedTasks = [];
    } else {
      const candidates = session.candidates.slice(session.nextIndex, session.nextIndex + tooltipActorCount);
      session.nextIndex += candidates.length;
      for (const candidate of candidates) session.requestedIds.add(candidate.actorId);
      tasks = candidates.flatMap((candidate) => tooltipDetailMonths(candidate, row).map((month) => ({
        candidate,
        month,
        key: `${month}|${candidate.actorId}${usersChart ? "|users" : ""}`,
      })));
    }
    if (!tasks.length) {
      renderRangeTooltip(canvas, index);
      positionRangeTooltip(rangeTooltipState.x, rangeTooltipState.y);
      return;
    }

    session.loading = true;
    renderRangeTooltip(canvas, index);
    positionRangeTooltip(rangeTooltipState.x, rangeTooltipState.y);
    const loadId = session.loadId;
    const results = await Promise.allSettled(tasks.map(async (task) => {
      const cached = actorDetailCache.get(task.key);
      if (cached?.entry) return { task, entry: cached.entry };
      const actor = { actorId: task.candidate.actorId, name: task.candidate.name || task.candidate.actorId };
      const entry = usersChart
        ? { ...actor, users: (await AAP_API.actorDailyUsers(task.month, actor.actorId, { priority: "foreground" })).users }
        : await AAP_API.actorDailyData(task.month, actor.actorId, { priority: "foreground" })
          .then((detail) => ({ ...actor, margin: detail.margin, runs: detail.runs }));
      actorDetailCache.set(task.key, { entry });
      return { task, entry };
    }));
    if (rangeTooltipState.session !== session || session.loadId !== loadId) return;
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        session.details.set(result.value.task.key, result.value.entry);
      } else {
        session.failedTasks.push(tasks[index]);
      }
    }
    session.loading = false;
    renderRangeTooltip(canvas, index);
    positionRangeTooltip(rangeTooltipState.x, rangeTooltipState.y);
  }

  function appendTooltipAction(label, action, disabled = false) {
    const button = createElement("button", "aap-range-tooltip-action", label);
    button.type = "button";
    button.dataset.action = action;
    button.disabled = disabled;
    return button;
  }

  function monthsText(months) {
    return (months || []).map((month) => AAPR.formatDate(month, { month: "short", year: "numeric" })).join(" and ");
  }

  // Wording for the Runs and User statistics tooltips.
  const DETAIL_TEXT = {
    runs: {
      hint: "Click the bar to see which Actors had failed runs",
      what: "failed, timed-out, or aborted runs",
    },
    users: {
      hint: "Click the point to see each Actor's users",
      what: "users",
    },
  };

  // The pinned tooltip's per-Actor table: revenue on the revenue chart,
  // Actors with failed, timed-out, or aborted runs on the Runs chart, and
  // each Actor's users on the User statistics chart.
  function appendActorDetails(data, row, period, chartKey, previousScroll = 0) {
    const text = DETAIL_TEXT[chartKey];
    if (state.partial) rangeTooltip.appendChild(createElement("div", "aap-range-tooltip-note", "Some account data could not be loaded; retrying."));
    if (!rangeTooltipState.pinned) {
      rangeTooltip.appendChild(createElement("div", "aap-range-tooltip-subtitle", text?.hint || `Click the bar to load up to ${tooltipActorCount} Actor details`));
      return;
    }

    const usersChart = chartKey === "users";
    const columns = chartKey === "runs" ? RUN_TOOLTIP_COLUMNS : usersChart ? USER_TOOLTIP_COLUMNS : ACTOR_TOOLTIP_COLUMNS;
    const session = tooltipSession(data, row, period, chartKey);
    const detailEntries = [...session.details.values()];
    const days = row.sourceDays || [period];
    const actors = usersChart
      ? AAPR.actorUsersForDays(detailEntries, days)
      : AAPR.actorRowsForDays(detailEntries, days).filter((actor) => chartKey !== "runs" || actor.problems > 0);
    const revenueRankedActors = actorRevenueRanking(data);
    const loadedCount = session.requestedIds.size;
    const candidateCount = session.candidates.length;

    if (session.failedTasks.length) {
      rangeTooltip.appendChild(createElement("div", "aap-range-tooltip-note", `${session.failedTasks.length} Actor detail request${session.failedTasks.length === 1 ? "" : "s"} failed.`));
    }
    const perDay = usersChart && days.length > 1 ? " (average per day)" : "";
    const hintText = session.loading
      ? `Loading Actor details… showing ${actors.length} loaded`
      : text
        ? `${actors.length} Actor${actors.length === 1 ? "" : "s"} with ${text.what}${perDay} · ${loadedCount} of ${candidateCount} checked`
        : `Showing ${actors.length} loaded Actors · ${loadedCount} of ${candidateCount} candidates`;
    if (session.scope !== "none") rangeTooltip.appendChild(createElement("div", "aap-range-tooltip-subtitle", hintText));

    if (actors.length) {
      const table = document.createElement("table");
      table.className = "aap-range-tooltip-table";
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const column of columns) {
        const cell = createElement("th", rangeTooltipState.sort === column.key ? "aap-range-tooltip-sorted" : "", column.label);
        cell.dataset.sort = column.key;
        if (rangeTooltipState.sort === column.key) {
          cell.appendChild(document.createTextNode(rangeTooltipState.direction === "asc" ? " ▲" : " ▼"));
        }
        headRow.appendChild(cell);
      }
      head.appendChild(headRow);
      table.appendChild(head);

      const body = document.createElement("tbody");
      for (const actor of sortedActorRows(actors, session.candidates)) {
        const rowElement = document.createElement("tr");
        const nameCell = document.createElement("td");
        const dot = createElement("span", "aap-range-dot");
        dot.style.backgroundColor = actorColor(actor.actorId, revenueRankedActors);
        nameCell.append(dot, document.createTextNode(actor.name || actor.actorId));
        rowElement.appendChild(nameCell);
        for (const column of columns.slice(1)) {
          rowElement.appendChild(createElement("td", "", column.format(actor)));
        }
        body.appendChild(rowElement);
      }
      table.appendChild(body);
      // Only the Actor rows scroll; the pin bar, totals, and actions stay put.
      const scroll = createElement("div", "aap-range-tooltip-scroll");
      scroll.appendChild(table);
      rangeTooltip.appendChild(scroll);
      // Re-renders (e.g. "Load more Actors") keep the list's scroll position.
      scroll.scrollTop = previousScroll;
    } else if (!session.loading) {
      const empty = !text
        ? candidateCount ? "No loaded Actor had revenue or runs in this bucket." : "No active Actors were included in the monthly catalog."
        : session.scope === "none" ? `No ${text.what} here.`
          : candidateCount ? `No checked Actor had ${text.what} here.`
            : session.scope === "filtered" ? `No Actor had ${text.what} in ${monthsText(session.months)}.`
              : "No active Actors were included in the monthly catalog.";
      rangeTooltip.appendChild(createElement("div", "aap-range-tooltip-note", empty));
    }
    const footer = createElement("div", "aap-range-tooltip-footer");
    if (session.failedTasks.length) {
      footer.appendChild(appendTooltipAction("Retry failed details", "retry", session.loading));
    }
    if (session.nextIndex < candidateCount) {
      footer.appendChild(appendTooltipAction("Load more Actors", "more", session.loading));
    } else if (!session.loading && !session.failedTasks.length && loadedCount) {
      const done = text && session.scope === "filtered"
        ? `Checked every Actor with ${text.what} in ${monthsText(session.months)}.`
        : "All catalog Actors loaded for this bucket.";
      footer.appendChild(createElement("div", "aap-range-tooltip-note", done));
    }
    if (footer.childElementCount) rangeTooltip.appendChild(footer);
  }

  function renderRangeTooltip(canvas, index) {
    const { definition, data, series } = canvas.__aapRange || {};
    if (!data || !data.days[index] || !series?.length) return false;
    const period = data.days[index];
    const row = data.daily[period] || {};
    if (!rangeTooltip) {
      rangeTooltip = createElement("div", "aap-range-tooltip");
      rangeTooltip.addEventListener("click", onRangeTooltipClick);
      document.body.appendChild(rangeTooltip);
    }

    rangeTooltip.classList.toggle("aap-range-tooltip-pinned", rangeTooltipState.pinned);
    // Re-renders (e.g. "Load more Actors") must not jump the Actor list back
    // to the top, so carry the inner scroll position across the rebuild.
    const previousScroll = rangeTooltip.querySelector(".aap-range-tooltip-scroll")?.scrollTop || 0;
    rangeTooltip.replaceChildren();
    if (rangeTooltipState.pinned) {
      const pinBar = createElement("div", "aap-range-tooltip-pin-bar", "Pinned — click the bar again or press Esc to close");
      const close = createElement("button", "aap-range-tooltip-close", "×");
      close.type = "button";
      close.setAttribute("aria-label", "Close");
      pinBar.appendChild(close);
      rangeTooltip.appendChild(pinBar);
    }
    rangeTooltip.appendChild(createElement("div", "aap-range-tooltip-period", tooltipPeriodLabel(period)));

    if (definition.key === "money") {
      const summary = createElement("div", "aap-range-tooltip-summary");
      const summaryFields = [
        ["revenue", "Overall revenue", (value) => AAPF.money(value ?? 0)],
        ["cost", "Overall costs", (value) => AAPF.money(value ?? 0)],
        ["profit", "Overall profit", (value) => AAPF.money(value ?? 0)],
        ["margin", "Overall margin", (value) => value == null ? "–" : AAPF.pct(value)],
      ];
      for (const [key, label, format] of summaryFields) {
        const item = createElement("div", `aap-range-tooltip-summary-item aap-range-tooltip-summary-${key}`);
        item.append(
          createElement("span", "aap-range-tooltip-summary-label", label),
          createElement("strong", "aap-range-tooltip-summary-value", format(row[key])),
        );
        summary.appendChild(item);
      }
      rangeTooltip.appendChild(summary);
      appendActorDetails(data, row, period, definition.key, previousScroll);
      return true;
    }

    for (const item of series) {
      const value = item.value ? item.value(row) : row[item.key];
      const money = definition.key === "money" || item.key === "cost";
      const formatted = value == null ? "–" : money ? AAPF.money(value) : formatCount(value);
      const line = createElement("div", "aap-range-tooltip-row");
      const dot = createElement("span", "aap-range-dot");
      dot.style.backgroundColor = item.color;
      line.append(
        dot,
        createElement("span", "aap-range-tooltip-label", item.label),
        createElement("span", "aap-range-tooltip-value", formatted),
      );
      rangeTooltip.appendChild(line);
    }
    if (definition.key === "runs") {
      const line = createElement("div", "aap-range-tooltip-row");
      const dot = createElement("span", "aap-range-dot");
      dot.style.backgroundColor = "#6b7280";
      line.append(
        dot,
        createElement("span", "aap-range-tooltip-label", "Total runs"),
        createElement("span", "aap-range-tooltip-value", formatCount(row.runs)),
      );
      rangeTooltip.appendChild(line);
    }
    if (ACTOR_DETAIL_CHARTS.includes(definition.key)) appendActorDetails(data, row, period, definition.key, previousScroll);
    return true;
  }

  function positionRangeTooltip(clientX, clientY) {
    if (!rangeTooltip) return;
    const tooltipRect = rangeTooltip.getBoundingClientRect();
    const margin = 8;
    let left = clientX + 12;
    let top = clientY + 12;
    if (left + tooltipRect.width > window.innerWidth - margin) left = clientX - tooltipRect.width - 12;
    if (top + tooltipRect.height > window.innerHeight - margin) top = clientY - tooltipRect.height - 12;
    // Flipping above the cursor can push a tall tooltip off-screen; keep the
    // whole tooltip (header included) inside the viewport.
    left = Math.max(margin, Math.min(left, window.innerWidth - tooltipRect.width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - tooltipRect.height - margin));
    rangeTooltip.style.left = `${left}px`;
    rangeTooltip.style.top = `${top}px`;
  }

  function onRangeChartHover(event) {
    if (rangeTooltipState.pinned) return;
    const target = rangeChartTarget(event);
    if (!target) return hideRangeTooltip();
    const { canvas, index } = target;
    setRangeTooltipTarget(canvas, index);
    showHoverBand(canvas, index);
    rangeTooltipState.x = event.clientX;
    rangeTooltipState.y = event.clientY;
    if (!renderRangeTooltip(canvas, index)) return hideRangeTooltip();
    rangeTooltip.style.display = "block";
    positionRangeTooltip(event.clientX, event.clientY);
  }

  function onRangeChartClick(event) {
    const target = rangeChartTarget(event);
    if (!target || !ACTOR_DETAIL_CHARTS.includes(chartKeyOf(target.canvas))) return;
    if (rangeTooltipState.pinned && rangeTooltipState.canvas === target.canvas && rangeTooltipState.index === target.index) {
      return hideRangeTooltip();
    }
    rangeTooltipState.pinned = true;
    setRangeTooltipTarget(target.canvas, target.index);
    showHoverBand(target.canvas, target.index);
    rangeTooltipState.x = event.clientX;
    rangeTooltipState.y = event.clientY;
    if (!renderRangeTooltip(target.canvas, target.index)) return hideRangeTooltip();
    rangeTooltip.style.display = "block";
    positionRangeTooltip(event.clientX, event.clientY);
    loadTooltipActors();
  }

  function onRangeTooltipClick(event) {
    event.stopPropagation();
    if (event.target.closest(".aap-range-tooltip-close")) return hideRangeTooltip();
    const action = event.target.closest("button[data-action]")?.dataset.action;
    if (action === "more" || action === "retry") {
      loadTooltipActors(action === "retry");
      return;
    }
    const header = event.target.closest("th[data-sort]");
    if (!header || !rangeTooltipState.pinned || !rangeTooltipState.canvas) return;
    const key = header.dataset.sort;
    rangeTooltipState.direction = rangeTooltipState.sort === key
      ? rangeTooltipState.direction === "desc" ? "asc" : "desc"
      : key === "name" ? "asc" : "desc";
    rangeTooltipState.sort = key;
    renderRangeTooltip(rangeTooltipState.canvas, rangeTooltipState.index);
    positionRangeTooltip(rangeTooltipState.x, rangeTooltipState.y);
  }

  function hideRangeTooltip() {
    hideHoverBand();
    if (rangeTooltip) {
      rangeTooltip.style.display = "none";
      rangeTooltip.classList.remove("aap-range-tooltip-pinned");
    }
    rangeTooltipState = {
      period: null,
      tab: null,
      sort: "revenue",
      direction: "desc",
      pinned: false,
      canvas: null,
      index: null,
      x: 0,
      y: 0,
      session: null,
    };
    tooltipLoadId++;
  }

  document.addEventListener("click", (event) => {
    if (!rangeTooltipState.pinned) return;
    if (rangeTooltip?.contains(event.target) || rangeTooltipState.canvas?.contains(event.target)) return;
    hideRangeTooltip();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && rangeTooltipState.pinned) hideRangeTooltip();
  });

  function applyRangeData(rawData, previousActorDetails) {
    // A refresh of the same range keeps the Actor colors and tooltip rows
    // already loaded for it.
    const sameRange = state.data && state.loadedKey === dataKey();
    const details = previousActorDetails || (sameRange ? state.data.actorDetails : null) || new Map();
    state.rawData = rawData;
    state.data = AAPR.group(rawData, state.grouping);
    state.data.actorDetails = details;
    syncPickerActors();
  }

  // The last finished range is saved per account/range so a reload can paint
  // it immediately instead of waiting for the network.
  async function restoreSnapshot(key) {
    try {
      const cached = await AAP_CACHE.getView?.(RANGE_SNAPSHOT_VIEW, rangeCacheTtl(state.range), snapshotScope(key));
      if (!cached?.hit || !Array.isArray(cached.data?.days)) return null;
      return { data: cached.data, updatedAt: cached.updatedAt };
    } catch {
      return null;
    }
  }

  function persistSnapshot(key, rawData) {
    Promise.resolve(AAP_CACHE.setView?.(RANGE_SNAPSHOT_VIEW, rawData, snapshotScope(key))).catch(() => {});
  }

  function scheduleAdjacentPrefetch() {
    if (adjacentPrefetched) return;
    adjacentPrefetched = true;
    window.AAP_INSIGHTS_NAV?.prefetchOtherTabs?.("monetization");
  }

  // Other tabs warm Monetization's current-month requests: the same URLs a
  // range ending this month asks for first.
  self.AAP_PREFETCH = self.AAP_PREFETCH || {};
  self.AAP_PREFETCH.monetization = () => {
    const month = `${currentMonth()}-01`;
    const options = { priority: "background" };
    return Promise.allSettled([
      AAP_API.profitMargin(month, [], options),
      AAP_API.runStatistics(month, [], options),
      AAP_API.userCountStatistics(month, [], options),
      AAP_API.costsPerThousandResults(month, [], options),
      AAP_API.actorBreakdown(month, [], options),
    ]);
  };

  async function loadRange() {
    if (!canLoad()) return;
    const requestedKey = dataKey();
    // Switching ranges mid-load: drop the old load's queued requests and start
    // the new range now instead of waiting for the old one to finish.
    if ((state.loading || state.refreshing) && requestedKey && requestedKey !== state.loadingKey) {
      AAP_API.cancel?.(state.loadTag);
      state.loadId++;
      state.loading = false;
      state.refreshing = false;
    }
    if (state.loading || state.refreshing) return;
    await AAP_API.whenReady?.();
    if (!canLoad() || state.loading || state.refreshing) return;
    const key = dataKey();
    if (!key || Date.now() < state.retryAt) return;
    let cached = memoryCache.get(key);
    if (!cached && !(state.data && state.loadedKey === key)) {
      const restoreLoadId = ++state.loadId;
      state.loading = true;
      state.loadingKey = key;
      cached = await restoreSnapshot(key);
      // A newer load (e.g. a range switch) superseded this restore.
      if (restoreLoadId !== state.loadId) return;
      state.loading = false;
      if (key !== dataKey()) return;
    }
    const fresh = cached && Date.now() - cached.updatedAt < rangeCacheTtl(state.range);
    if (cached) {
      memoryCache.delete(key);
      memoryCache.set(key, cached);
      while (memoryCache.size > MAX_MEMORY_CACHE_ENTRIES) memoryCache.delete(memoryCache.keys().next().value);
    }
    if (key === state.loadedKey && fresh) return;
    let hadData = Boolean(state.data && state.loadedKey === key);
    const previousActorDetails = hadData ? state.data.actorDetails : null;
    if (cached && !hadData) {
      // Paint the cached snapshot now; refresh it below only if it is stale.
      applyRangeData(cached.data, null);
      state.loadedKey = key;
      state.error = null;
      state.partial = cached.data.partial || null;
      self.AAP_PERF?.mark("range.firstPaint");
      renderRangeView(false);
      if (fresh) {
        startActorPrefetch(state.data, cached.data, key, state.loadId);
        scheduleAdjacentPrefetch();
        return;
      }
      hadData = true;
    }
    state.loadedKey = key;
    state.loadingKey = key;
    state.loading = !hadData;
    state.refreshing = hadData;
    state.error = null;
    state.partial = null;
    if (!hadData) renderRangeView();
    const loadId = ++state.loadId;
    const tag = `range-${loadId}`;
    state.loadTag = tag;
    let progressed = false;
    try {
      const dates = apiDates(state.range);
      const rawData = await AAP_API.rangeData(dates.start, dates.end, state.actorIds, {
        tag,
        includePrevious: true,
        // Draw the newest months as soon as they arrive on a cold load.
        onProgress: hadData ? null : (progress) => {
          if (loadId !== state.loadId || key !== dataKey()) return;
          progressed = true;
          applyRangeData(progress, null);
          self.AAP_PERF?.mark("range.firstPaint");
          renderRangeView(false);
        },
      });
      if (loadId !== state.loadId || key !== dataKey()) return;
      if (!rawData.partial) {
        memoryCache.delete(key);
        memoryCache.set(key, { data: rawData, updatedAt: Date.now() });
        while (memoryCache.size > MAX_MEMORY_CACHE_ENTRIES) memoryCache.delete(memoryCache.keys().next().value);
        persistSnapshot(key, rawData);
      }
      applyRangeData(rawData, previousActorDetails);
      self.AAP_PERF?.mark("range.firstPaint");
      self.AAP_PERF?.mark("range.fullPaint");
      state.partial = rawData.partial || null;
      state.retryAt = rawData.partial ? Date.now() + PARTIAL_RETRY_MS : 0;
      startActorPrefetch(state.data, rawData, key, loadId);
      scheduleAdjacentPrefetch();
    } catch (error) {
      if (loadId !== state.loadId || key !== dataKey()) return;
      if (error?.name === "AbortError") return;
      // Keep the last successful snapshot usable if a background refresh
      // fails. The next retry can update it without a blank loading state.
      state.error = hadData || progressed ? null : error;
      if (!hadData && !progressed) state.loadedKey = null;
      state.retryAt = Date.now() + 10_000;
    } finally {
      if (loadId === state.loadId && key === dataKey()) {
        state.loading = false;
        state.refreshing = false;
        if (revalidationPending) setTimeout(reloadRevalidated, 0);
      }
      renderRangeView(false);
    }
  }

  window.addEventListener("aap-request-seen", (event) => {
    if (!onInsightsRoute()) return;
    const { month, actorIds } = event.detail || {};
    if (!month) return;
    const oldAccount = accountKey();
    state.observedMonth = month;
    state.nativeActorIds = [...(actorIds || [])].sort();
    syncFilterAccount();
    // What the user picks in Apify's own picker carries over to Plus. Plus
    // hides that picker, so only Original can change it.
    if (state.view === "original") adoptNativeSelection();
    setActorScope(viewActorIds());
    if (oldAccount !== accountKey()) {
      resetRangeData();
    }
    initializeDefaultRange();
    ensureSelector();
    if (state.view === "custom" && validRange(state.range)) loadRange();
  });
  window.dispatchEvent(new Event("aap-request-info"));

  syncPageTheme();
  storageGet([RANGE_KEY, GROUPING_KEY, VIEW_KEY, TOOLTIP_ACTOR_COUNT_KEY]).then((result) => {
    state.grouping = result[GROUPING_KEY] === "day" || result[GROUPING_KEY] === "month" ? result[GROUPING_KEY] : "day";
    state.view = result[VIEW_KEY] === "original" ? "original" : "custom";
    tooltipActorCount = normalizeTooltipActorCount(result[TOOLTIP_ACTOR_COUNT_KEY]);
    const stored = result[RANGE_KEY];
    if (validRange(stored)) {
      // Keep optional day bounds so the rolling shortcuts (1m/3m/6m/1y)
      // retain their exact "same day through today" meaning after reload.
      state.range = {
        start: stored.start,
        end: stored.end,
        ...(stored.startDate ? { startDate: stored.startDate } : {}),
        ...(stored.endDate ? { endDate: stored.endDate } : {}),
      };
      rangeInitialized = true;
      if (onInsightsRoute()) {
        setRangeMode(state.view === "custom");
        ensureSelector();
        if (state.view === "custom") loadRange();
      }
    } else if (onInsightsRoute()) {
      initializeDefaultRange();
    }
  });

  window.addEventListener("resize", () => {
    if (state.view === "custom" && validRange(state.range)) renderRangeView();
  });

  // A Monetization tab switch redraws as soon as Apify has swapped its chart,
  // instead of waiting for the next poll.
  document.addEventListener("click", (event) => {
    if (!event.target.closest?.(Object.keys(MONEY_TABS).map((id) => `a#${id}`).join(","))) return;
    if (rangeTooltipState.pinned) hideRangeTooltip();
    setTimeout(() => {
      if (onInsightsRoute() && state.view === "custom" && validRange(state.range)) renderRangeView(false);
    }, 0);
  }, true);

  const poll = AAP_LIFECYCLE.every(() => {
    const themeChanged = syncPageTheme();
    const active = onInsightsRoute();
    if (active !== lastActive) {
      lastActive = active;
      if (!active) {
        window.AAP_INSIGHTS_NAV?.removeViewToggle("monetization");
        actorPicker?.destroy();
        actorPicker = null;
        selector?.remove();
        selector = null;
        fromSelect = null;
        toSelect = null;
        groupingSelect = null;
        controlsStatus = null;
        controlsError = null;
        quickButtons = [];
        document.documentElement.classList.remove(ORIGINAL_MODE_CLASS);
        restoreNativeView();
      }
    }
    if (!onInsightsRoute()) {
      // A table drawn by a late render on another page would otherwise stay.
      window.AAP_PORTFOLIO?.remove();
      return;
    }
    if (!rangeInitialized) initializeDefaultRange();
    if (state.view === "custom" && validRange(state.range) && !document.documentElement.classList.contains(MODE_CLASS)) setRangeMode(true);
    if (state.view === "original" && document.documentElement.classList.contains(MODE_CLASS)) setRangeMode(false);
    if (state.view === "original") document.documentElement.classList.add(ORIGINAL_MODE_CLASS);
    ensureSelector();
    if (state.view === "custom" && validRange(state.range)) {
      renderRangeView(themeChanged);
      loadRange();
    }
  }, 500);
  window.addEventListener("beforeunload", () => clearInterval(poll));
})();
