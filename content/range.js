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
        { key: "payingUsers", label: "Paying users", color: "#2dd4bf" },
        { key: "freeUsers", label: "Free users", color: "#60a5fa" },
      ],
    },
  ];
  const ACTOR_COLOR_PALETTE = ["#2dd4bf", "#60a5fa", "#f472b6", "#facc15", "#a78bfa", "#fb923c", "#34d399", "#f87171"];
  const MUTED_ACTOR_COLOR = "#6b7280";
  const TOOLTIP_ACTOR_COUNT_KEY = "aap.tooltipActorCount";
  const DEFAULT_TOOLTIP_ACTOR_COUNT = 20;
  const MAX_TOOLTIP_ACTOR_COUNT = 100;

  const state = {
    observedMonth: null,
    actorIds: [],
    nativeActorIds: [],
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
    resetRangeData();
    if (state.view === "custom" && canLoad()) {
      renderRangeView();
      loadRange();
    }
  });
  // A stale cached response was refreshed in the background: reload the range
  // (now served from the fresh cache) so the charts show the new numbers.
  let revalidationTimer = null;
  AAP_API.onRevalidated?.(({ path }) => {
    if (!path || path === "public" || state.view !== "custom") return;
    clearTimeout(revalidationTimer);
    revalidationTimer = setTimeout(() => {
      const key = dataKey();
      if (!key || state.loading || state.refreshing) return;
      // Refresh in place: the chart and its loaded Actor colors stay visible.
      memoryCache.delete(key);
      if (canLoad()) loadRange();
    }, 800);
  });
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
  let rangeTooltip = null;
  let rangeTooltipState = {
    period: null,
    sort: "revenue",
    direction: "desc",
    pinned: false,
    canvas: null,
    index: null,
    x: 0,
    y: 0,
    session: null,
  };
  let lastPath = location.pathname;
  let pageThemeSignature = "";
  let rangeInitialized = false;

  const onInsightsRoute = () => ROUTE_RE.test(location.pathname);

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
    return `${start} – ${end}`;
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

    customControls.append(fields, quickRanges, grouping);

    controlsError = createElement("span", "aap-range-input-error");
    const error = controlsError;
    error.hidden = true;
    controlsStatus = createElement("div", "aap-range-status");
    selector.append(customControls, error, controlsStatus);
    const controlParent = native.parentElement;
    if (controlParent) controlParent.insertBefore(selector, controlParent.firstElementChild);
    else native.insertAdjacentElement("beforebegin", selector);
    populateMonthSelect(fromSelect);
    populateMonthSelect(toSelect);
    syncSelector();
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
    const activeRange = validRange(state.range) ? state.range : defaultRange();
    ensureMonthOption(fromSelect, activeRange.start);
    ensureMonthOption(toSelect, activeRange.end);
    if (fromSelect) fromSelect.value = activeRange.start;
    if (toSelect) toSelect.value = activeRange.end;
    if (groupingSelect) groupingSelect.value = state.grouping;
    for (const { button, months } of quickButtons) {
      button.classList.toggle("aap-range-quick-button-active", rangesEqual(state.range, quickRange(months)));
    }

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
    setActorScope(next === "custom" ? [] : state.nativeActorIds);
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

  function definitionFor(wrapper) {
    const heading = wrapper.parentElement?.querySelector("h3")?.textContent?.trim();
    return CHART_DEFS.find((definition) => heading === definition.heading) || null;
  }

  function chartHost(wrapper, definition) {
    if (definition.key === "money") return wrapper.querySelector('[class*="PaidActorProfitMarginChart"]');
    return wrapper.querySelector("canvas")?.parentElement || null;
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
    for (const wrapper of chartWrappers()) {
      const definition = definitionFor(wrapper);
      const host = definition && chartHost(wrapper, definition);
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
      money: `Selected months: ${rangeLabel(state.range)}. Only paying users generate revenue and costs; runs by free users aren't included. Pin a revenue bar to load Actor details.`,
      cost: `${grouping[0].toUpperCase()}${grouping.slice(1)} cost per 1,000 results for ${rangeLabel(state.range)}.`,
      results: `${grouping[0].toUpperCase()}${grouping.slice(1)} results for ${rangeLabel(state.range)}.`,
      runs: `${grouping[0].toUpperCase()}${grouping.slice(1)} runs by status for ${rangeLabel(state.range)}.`,
      users: `Average daily users by ${groupingLabel()} for ${rangeLabel(state.range)}.`,
    };
    setRangeText(description, labels[definition.key]);
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
      const decimals = value === 0 ? 2 : step >= 1 ? (step % 1 ? 1 : 0) : step >= 0.01 ? 2 : Math.min(6, Math.max(3, Math.ceil(-Math.log10(step)) + 1));
      return `$${value.toFixed(decimals)}`;
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

  // Compares the latest N complete periods with the N before them.
  function windowTrend(values, grouping = state.grouping) {
    const cap = TREND_WINDOWS[grouping] || 7;
    const size = Math.min(cap, Math.floor(values.length / 2));
    if (size < (grouping === "day" ? 3 : 2)) return null;
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
  function trendDetail(trend, higherIsBetter) {
    if (!trend) return { text: "Not enough complete periods for a trend", tone: "neutral" };
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
      if (successRate != null && successRate < 0.95) takeaway = `${formatPercent(1 - successRate)} of runs did not succeed. Open Debugging to find the failing Actors.`;
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
      const payingTrend = trendDetail(windowTrend(paying, grouping), true);
      const freeTrend = trendDetail(windowTrend(free, grouping), true);
      const tiles = [
        { label: "Paying users / day", value: formatWhole(avgPaying), detail: payingTrend.text, tone: payingTrend.tone },
        { label: "Free users / day", value: formatWhole(avgFree), detail: freeTrend.text, tone: "neutral" },
        { label: "Paying share", value: formatPercent(share, 0), detail: "of daily active users", tone: "neutral", title: "Average paying users divided by average paying plus free users." },
      ];
      let takeaway = "The paying and free user mix is stable.";
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
      item.append(
        createElement("span", "aap-range-insight-label", tile.label),
        createElement("strong", "aap-range-insight-value", tile.value),
        createElement("span", "aap-range-insight-detail", tile.detail),
      );
      grid.appendChild(item);
    }
    const takeaway = createElement("p", "aap-range-insight-takeaway", insights.takeaway);
    if (insights.note) takeaway.appendChild(createElement("span", "aap-range-insight-note", ` ${insights.note}`));
    takeaway.title = insights.note ? `${insights.takeaway} ${insights.note}` : insights.takeaway;
    strip.replaceChildren(grid, takeaway);
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

  function drawRangeChart(chart, definition, data) {
    const { canvas, legend, host } = chart;
    // Keep the last successful chart visible while refreshing its data. The
    // draw is synchronous, so replacing the canvas contents completes before
    // the browser can paint; hiding it first only creates a visible flicker.
    const preserveVisible = !!data && chart.overlay.dataset.aapReady === "true" && !!canvas.__aapRange?.data;
    setRangeChartReady(chart, false, preserveVisible);
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
    ctx.font = `12px ${getComputedStyle(host).fontFamily || "sans-serif"}`;
    ctx.textBaseline = "middle";

    const chartStyles = getComputedStyle(chart.overlay);
    const axisColor = chartStyles.getPropertyValue("--aap-range-chart-text").trim() || "#374151";
    const gridColor = chartStyles.getPropertyValue("--aap-range-chart-grid").trim() || "rgba(17,24,39,0.14)";

    const series = rangeSeries(definition, data || { days: [] });
    const showLegend = definition.key !== "money" && series.length > 1;
    legend.style.display = showLegend ? "" : "none";
    if (showLegend) updateLegend(legend, series);
    else legend.replaceChildren();
    canvas.__aapRange = { definition, data: data || null, series };
    if (!data || !data.days.length) {
      ctx.fillStyle = axisColor;
      ctx.textAlign = "center";
      ctx.fillText(state.loading ? "Loading selected range…" : "No data for this range", rect.width / 2, rect.height / 2);
      return;
    }

    const values = chartValues(series, data);
    const partial = data.days.map((period) => isPartialPeriod(period, data.grouping));
    const stackedBars = (definition.key === "money" || definition.key === "runs")
      && series.length > 1
      && series.every((item) => item.type === "bar");
    const valueMaxima = stackedBars
      ? values.map((row) => row.reduce((sum, value) => sum + value, 0))
      : values.flat();
    const scale = AAPR.niceScale(Math.max(0, ...valueMaxima));
    const maxValue = scale.max;
    const top = showLegend && series.length > 1 ? 34 : 16;
    const bottom = 30;
    const axisLabels = Array.from({ length: scale.ticks + 1 }, (_, tick) => axisValue(scale.step * tick, definition, scale.step));
    const left = Math.max(58, ...axisLabels.map((label) => Math.ceil(ctx.measureText(label).width) + 16));
    const right = 16;
    const plotWidth = Math.max(1, rect.width - left - right);
    const plotHeight = Math.max(1, rect.height - top - bottom);
    const slot = plotWidth / data.days.length;
    canvas.__aapRangePlot = { left, right, top, bottom, slot };

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    for (let tick = 0; tick <= scale.ticks; tick++) {
      const value = Math.min(maxValue, scale.step * tick);
      const fraction = value / maxValue;
      const y = top + plotHeight * (1 - fraction);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(rect.width - right, y);
      ctx.stroke();
      ctx.fillStyle = axisColor;
      ctx.textAlign = "right";
      ctx.fillText(axisValue(value, definition, scale.step), left - 8, y);
    }

    const labelEvery = Math.max(1, Math.ceil(data.days.length / 8));
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let index = 0; index < data.days.length; index += labelEvery) {
      const x = left + index * slot + slot / 2;
      ctx.fillStyle = axisColor;
      ctx.fillText(AAPR.formatDate(data.days[index], { month: "short", day: "numeric" }), x, rect.height - bottom + 8);
    }

    const coloredMoneyBars = definition.key === "money" && data.actorDetails?.size;
    if (coloredMoneyBars) {
      const detailEntries = [...data.actorDetails.values()];
      const revenueRanking = actorRevenueRanking(data);
      for (let index = 0; index < data.days.length; index++) {
        const period = data.days[index];
        const row = data.daily[period] || {};
        const actorRows = AAPR.actorRowsForDays(detailEntries, row.sourceDays || [period])
          .filter((actor) => Number(actor.revenue) > 0);
        const segments = actorRows.map((actor) => ({
          color: actorColor(actor.actorId, revenueRanking),
          value: Number(actor.revenue) || 0,
        }));
        const accounted = segments.reduce((sum, segment) => sum + segment.value, 0);
        const total = Number(row.revenue) || 0;
        if (segments.length && total > accounted) segments.push({ color: MUTED_ACTOR_COLOR, value: total - accounted });
        if (!segments.length) segments.push({ color: series[0].color, value: total });
        const drawnTotal = Math.max(total, segments.reduce((sum, segment) => sum + segment.value, 0));
        const barHeight = (drawnTotal / maxValue) * plotHeight;
        const x = left + index * slot + slot / 2;
        const barWidth = Math.max(3, slot * 0.62);
        let offset = 0;
        ctx.globalAlpha = partial[index] ? 0.4 : 1;
        for (const segment of segments) {
          const height = (segment.value / maxValue) * plotHeight;
          const y = top + plotHeight - offset - height;
          ctx.fillStyle = segment.color;
          ctx.fillRect(x - barWidth / 2, y, barWidth, height);
          offset += height;
        }
        // Keep the bar's baseline deterministic for zero-revenue periods.
        if (!drawnTotal) ctx.fillRect(x - barWidth / 2, top + plotHeight, barWidth, 0);
      }
      ctx.globalAlpha = 1;
    } else {
      for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex++) {
        const current = series[seriesIndex];
        const points = values.map((row, index) => ({
          x: left + index * slot + slot / 2,
          y: top + plotHeight - (row[seriesIndex] / maxValue) * plotHeight,
        }));
        if (current.type === "bar" || definition.type === "bar") {
          ctx.fillStyle = current.color;
          for (let index = 0; index < points.length; index++) {
            const value = values[index][seriesIndex];
            const below = stackedBars
              ? values[index].slice(0, seriesIndex).reduce((sum, item) => sum + item, 0)
              : 0;
            const height = (value / maxValue) * plotHeight;
            const y = top + plotHeight - ((below + value) / maxValue) * plotHeight;
            ctx.globalAlpha = partial[index] ? 0.4 : 1;
            ctx.fillRect(points[index].x - Math.max(3, slot * 0.62) / 2, y, Math.max(3, slot * 0.62), height);
          }
          ctx.globalAlpha = 1;
        } else {
          ctx.strokeStyle = current.color;
          ctx.fillStyle = current.color;
          ctx.lineWidth = 2;
          // Solid line through complete periods; the in-progress period is
          // dashed so a partial day is not read as a drop.
          const solidEnd = partial.lastIndexOf(false);
          ctx.beginPath();
          points.slice(0, solidEnd + 1).forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
          ctx.stroke();
          if (solidEnd >= 0 && solidEnd < points.length - 1) {
            ctx.save();
            ctx.setLineDash([4, 4]);
            ctx.globalAlpha = 0.6;
            ctx.beginPath();
            ctx.moveTo(points[solidEnd].x, points[solidEnd].y);
            points.slice(solidEnd + 1).forEach((point) => ctx.lineTo(point.x, point.y));
            ctx.stroke();
            ctx.restore();
          }
          if (points.length <= 90) {
            points.forEach((point, index) => {
              ctx.beginPath();
              ctx.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
              if (partial[index]) {
                ctx.save();
                ctx.lineWidth = 1.5;
                ctx.stroke();
                ctx.restore();
              } else {
                ctx.fill();
              }
            });
          }
        }
      }
    }
    const insights = definition.key === "money" ? null : chartInsights(definition, data);
    if (insights?.average != null && insights.average > 0 && insights.average <= maxValue) {
      const y = top + plotHeight * (1 - insights.average / maxValue);
      ctx.save();
      ctx.strokeStyle = axisColor;
      ctx.globalAlpha = 0.7;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(rect.width - right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const label = `avg ${definition.key === "cost" ? formatCostPerThousand(insights.average) : formatWhole(insights.average)}`;
      ctx.font = `11px ${getComputedStyle(host).fontFamily || "sans-serif"}`;
      const width = ctx.measureText(label).width + 10;
      const labelX = rect.width - right - width;
      ctx.fillStyle = chartStyles.getPropertyValue("--aap-range-chart-surface").trim() || "#ffffff";
      ctx.fillRect(labelX, y - 9, width, 18);
      ctx.fillStyle = axisColor;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, labelX + 5, y);
      ctx.restore();
    }
    if (insights?.spike) {
      // Annotate an outlier so it reads as an event, not just a tall bar.
      const index = data.days.indexOf(insights.spike.period);
      if (index >= 0) {
        const x = left + index * slot + slot / 2;
        const y = top + plotHeight * (1 - insights.spike.value / maxValue);
        const label = `${formatWhole(insights.spike.value)} · spike`;
        ctx.save();
        ctx.font = `600 11px ${getComputedStyle(host).fontFamily || "sans-serif"}`;
        ctx.fillStyle = axisColor;
        ctx.textAlign = x > rect.width - right - 60 ? "right" : x < left + 60 ? "left" : "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(label, x, Math.max(top + 10, y - 4));
        ctx.restore();
      }
    }
    setRangeChartReady(chart, true);
  }

  function renderRangeView(forceDraw = true) {
    if (state.view !== "custom" || !validRange(state.range)) return;
    for (const wrapper of chartWrappers()) {
      const definition = definitionFor(wrapper);
      if (!definition) continue;
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
        const needsDraw = forceDraw || chart.canvas.__aapRange?.data !== state.data;
        if (needsDraw && chart.canvas.__aapRange?.data !== state.data) restoreOriginalText(wrapper);
        if (needsDraw) drawRangeChart(chart, definition, state.data);
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
    const sessionKey = `${dataKey() || ""}|${period || ""}`;
    if (period !== rangeTooltipState.period) {
      rangeTooltipState.sort = "revenue";
      rangeTooltipState.direction = "desc";
      rangeTooltipState.period = period;
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

  function tooltipSession(data, row, period) {
    const key = `${dataKey() || ""}|${period || ""}`;
    if (!rangeTooltipState.session || rangeTooltipState.session.key !== key) {
      rangeTooltipState.session = {
        key,
        candidates: tooltipCandidates(data, row),
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
    const session = period && row ? tooltipSession(data, row, period) : null;
    if (!session || session.loading || !rangeTooltipState.pinned) return;

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
        key: `${month}|${candidate.actorId}`,
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
      const detail = await AAP_API.actorDailyData(task.month, task.candidate.actorId, { priority: "foreground" });
      const entry = {
        actorId: task.candidate.actorId,
        name: task.candidate.name || task.candidate.actorId,
        margin: detail.margin,
        runs: detail.runs,
      };
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

      const session = tooltipSession(data, row, period);
      const detailEntries = [...session.details.values()];
      const actors = AAPR.actorRowsForDays(detailEntries, row.sourceDays || [period]);
      const revenueRankedActors = actorRevenueRanking(data);
      const loadedCount = session.requestedIds.size;
      const candidateCount = session.candidates.length;

      if (state.partial) rangeTooltip.appendChild(createElement("div", "aap-range-tooltip-note", "Some account data could not be loaded; retrying."));
      if (session.failedTasks.length) {
        rangeTooltip.appendChild(createElement("div", "aap-range-tooltip-note", `${session.failedTasks.length} Actor detail request${session.failedTasks.length === 1 ? "" : "s"} failed.`));
      }

      const hintText = !rangeTooltipState.pinned
        ? `Click the bar to load up to ${tooltipActorCount} Actor details`
        : session.loading
          ? `Loading Actor details… showing ${actors.length} loaded`
          : `Showing ${actors.length} loaded Actors · ${loadedCount} of ${candidateCount} candidates`;
      rangeTooltip.appendChild(createElement("div", "aap-range-tooltip-subtitle", hintText));

      if (!rangeTooltipState.pinned) return true;

      if (actors.length) {
        const table = document.createElement("table");
        table.className = "aap-range-tooltip-table";
        const head = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const column of ACTOR_TOOLTIP_COLUMNS) {
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
          for (const column of ACTOR_TOOLTIP_COLUMNS.slice(1)) {
            rowElement.appendChild(createElement("td", "", column.format(actor)));
          }
          body.appendChild(rowElement);
        }
        table.appendChild(body);
        // Only the Actor rows scroll; the pin bar, totals, and actions stay put.
        const scroll = createElement("div", "aap-range-tooltip-scroll");
        scroll.appendChild(table);
        rangeTooltip.appendChild(scroll);
      } else if (!session.loading) {
        rangeTooltip.appendChild(createElement("div", "aap-range-tooltip-note", candidateCount ? "No loaded Actor had revenue or runs in this bucket." : "No active Actors were included in the monthly catalog."));
      }
      const footer = createElement("div", "aap-range-tooltip-footer");
      if (session.failedTasks.length) {
        footer.appendChild(appendTooltipAction("Retry failed details", "retry", session.loading));
      }
      if (session.nextIndex < candidateCount) {
        footer.appendChild(appendTooltipAction("Load more Actors", "more", session.loading));
      } else if (!session.loading && !session.failedTasks.length && loadedCount) {
        footer.appendChild(createElement("div", "aap-range-tooltip-note", "All catalog Actors loaded for this bucket."));
      }
      if (footer.childElementCount) rangeTooltip.appendChild(footer);
      const scroll = rangeTooltip.querySelector(".aap-range-tooltip-scroll");
      if (scroll) scroll.scrollTop = previousScroll;
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
    rangeTooltipState.x = event.clientX;
    rangeTooltipState.y = event.clientY;
    if (!renderRangeTooltip(canvas, index)) return hideRangeTooltip();
    rangeTooltip.style.display = "block";
    positionRangeTooltip(event.clientX, event.clientY);
  }

  function onRangeChartClick(event) {
    const target = rangeChartTarget(event);
    if (!target || target.canvas.__aapRange?.definition?.key !== "money") return;
    if (rangeTooltipState.pinned && rangeTooltipState.canvas === target.canvas && rangeTooltipState.index === target.index) {
      return hideRangeTooltip();
    }
    rangeTooltipState.pinned = true;
    setRangeTooltipTarget(target.canvas, target.index);
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
    if (rangeTooltip) {
      rangeTooltip.style.display = "none";
      rangeTooltip.classList.remove("aap-range-tooltip-pinned");
    }
    rangeTooltipState = {
      period: null,
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
    setActorScope(state.view === "custom" ? [] : state.nativeActorIds);
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

  const poll = setInterval(() => {
    const themeChanged = syncPageTheme();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      if (!onInsightsRoute()) {
        window.AAP_INSIGHTS_NAV?.removeViewToggle("monetization");
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
    if (!onInsightsRoute()) return;
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
