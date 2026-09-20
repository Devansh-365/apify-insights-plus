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
  const HISTORICAL_CACHE_TTL_MS = 15 * 60 * 1000;
  const CURRENT_MONTH_CACHE_TTL_MS = 60 * 1000;
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
    error: null,
    loading: false,
    loadedKey: null,
    retryAt: 0,
    loadId: 0,
  };

  const memoryCache = new Map();
  let tooltipActorCount = DEFAULT_TOOLTIP_ACTOR_COUNT;
  AAP_API.onTokenChange?.(() => {
    // A tab can stay open while the user logs out or switches accounts. Do
    // not retain or display the previous account's range data in that case.
    memoryCache.clear();
    resetRangeData();
    if (state.view === "custom" && validRange(state.range) && state.observedMonth) {
      renderRangeView();
      loadRange();
    }
  });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[CACHE_CLEAR_KEY]) {
      memoryCache.clear();
      state.loadedKey = null;
      state.retryAt = 0;
      state.loadId++;
      state.loading = false;
      // Keep the current chart on screen while the cleared range is fetched
      // again, instead of replacing it with a blank loading state.
      if (state.view === "custom" && validRange(state.range) && state.observedMonth) loadRange();
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
    state.error = null;
    state.loadedKey = null;
    state.retryAt = 0;
    state.loading = false;
    state.loadId++;
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
    window.AAP_INSIGHTS_NAV?.ensureViewToggle("monetization", state.view, setViewMode);
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
      else if (state.loading) controlsStatus.textContent = "Loading range…";
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
    if (state.rawData) state.data = AAPR.group(state.rawData, state.grouping);
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
    }
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
      money: `Selected months: ${rangeLabel(state.range)}. Only paying users generate revenue and costs; runs by free users aren't included. Revenue is split by Actor.`,
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
    if (definition.key === "money") {
      const actorSeries = actorChartSeries(data);
      if (actorSeries.length) return actorSeries;
    }
    if (definition.series) return definition.series;
    return [definition];
  }

  function actorTotals(data) {
    const names = Object.entries(data?.actorNames || {});
    const totals = new Map(names.map(([actorId]) => [actorId, { revenue: 0, runs: 0 }]));
    for (const row of Object.values(data.daily || {})) {
      for (const [actorId, actor] of Object.entries(row.actorStats || {})) {
        const total = totals.get(actorId);
        if (!total) continue;
        total.revenue += Number(actor.revenue) || 0;
        total.runs += Number(actor.runs) || 0;
      }
    }
    return { names, totals };
  }

  function sortActorRanking(names, totals) {
    return names
      .sort((left, right) => {
        const leftTotal = totals.get(left[0]) || { revenue: 0, runs: 0 };
        const rightTotal = totals.get(right[0]) || { revenue: 0, runs: 0 };
        // Keep every revenue-producing Actor ahead of run-only Actors before
        // comparing the actual revenue totals. This makes the display limit
        // useful even when many Actors have runs but no monetization.
        return Number(rightTotal.revenue > 0) - Number(leftTotal.revenue > 0)
          || rightTotal.revenue - leftTotal.revenue
          || rightTotal.runs - leftTotal.runs
          || String(left[1]).localeCompare(String(right[1]));
      });
  }

  function actorRanking(data) {
    const { names, totals } = actorTotals(data);
    return sortActorRanking(names, totals)
      .filter(([actorId]) => {
        const total = totals.get(actorId);
        return total && (total.revenue > 0 || total.runs > 0);
      });
  }

  function actorRevenueRanking(data) {
    const { names, totals } = actorTotals(data);
    return sortActorRanking(names, totals)
      .filter(([actorId]) => (totals.get(actorId)?.revenue || 0) > 0);
  }

  function actorChartSeries(data) {
    const actors = actorRevenueRanking(data);
    return actors.map(([actorId, name]) => ({
      key: actorId,
      label: name,
      color: actorColor(actorId, actors),
      type: "bar",
      value: (row) => row.actorRevenue?.[actorId] || 0,
    }));
  }

  function actorColor(actorId, actors) {
    const index = actors.findIndex(([id]) => id === actorId);
    return index >= 0 && index < ACTOR_COLOR_PALETTE.length
      ? ACTOR_COLOR_PALETTE[index]
      : MUTED_ACTOR_COLOR;
  }

  function chartValues(series, data) {
    return data.days.map((day) => {
      const row = data.daily[day] || {};
      return series.map((definition) => Number(definition.value ? definition.value(row) || 0 : row[definition.key] || 0));
    });
  }

  function axisValue(value, definition, step = 1) {
    if (definition.key === "money" || definition.key === "cost") {
      const decimals = value === 0 ? 2 : step < 1 ? 2 : step % 1 ? 1 : 0;
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
    const showLegend = definition.key !== "money";
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
          ctx.fillRect(points[index].x - Math.max(3, slot * 0.62) / 2, y, Math.max(3, slot * 0.62), height);
        }
      } else {
        ctx.strokeStyle = current.color;
        ctx.fillStyle = current.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
        ctx.stroke();
        if (points.length <= 90) {
          for (const point of points) {
            ctx.beginPath();
            ctx.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
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
          if (state.data) updateSummaries(wrapper, definition, state.data);
        }
      } catch {
        // A single malformed chart must not prevent the remaining four charts
        // from rendering. The native canvas is restored by this state change.
        setRangeChartReady(chart, false);
        restoreOriginalText(wrapper);
      }
    }
    syncSelector();
  }

  function tooltipPeriodLabel(period) {
    if (state.grouping === "day") return AAPR.formatDate(period, { month: "short", day: "numeric", year: "numeric" });
    if (state.grouping === "month") return AAPR.formatDate(period, { month: "short", year: "numeric" });
    return `Week of ${AAPR.formatDate(period, { month: "short", day: "numeric", year: "numeric" })}`;
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
    if (period !== rangeTooltipState.period) {
      rangeTooltipState.sort = "revenue";
      rangeTooltipState.direction = "desc";
      rangeTooltipState.period = period;
    }
    rangeTooltipState.canvas = canvas;
    rangeTooltipState.index = index;
  }

  function sortedActorRows(rows, ranking = []) {
    const direction = rangeTooltipState.direction === "asc" ? 1 : -1;
    const rankingIndex = new Map(ranking.map(([actorId], index) => [actorId, index]));
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
      const eligibleActors = Object.values(row.actorStats || {}).filter((actor) => Number(actor.revenue) > 0 || Number(actor.runs) > 0);
      if (!eligibleActors.length) {
        rangeTooltip.appendChild(createElement("div", "aap-range-tooltip-note", "No revenue or runs this day."));
        return true;
      }
      const rankedActors = actorRanking(data);
      const visibleActorIds = new Set(rankedActors.slice(0, tooltipActorCount).map(([actorId]) => actorId));
      const actors = eligibleActors.filter((actor) => visibleActorIds.has(actor.actorId));

      const hint = createElement(
        "div",
        "aap-range-tooltip-subtitle",
        rangeTooltipState.pinned
          ? `Showing ${actors.length} of ${eligibleActors.length} eligible Actors`
          : `Showing ${actors.length} of ${eligibleActors.length} eligible Actors · click bar to sort`,
      );
      rangeTooltip.appendChild(hint);

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
      for (const actor of sortedActorRows(actors, rankedActors)) {
        const rowElement = document.createElement("tr");
        const nameCell = document.createElement("td");
        const dot = createElement("span", "aap-range-dot");
        dot.style.backgroundColor = actorColor(actor.actorId, actorRevenueRanking(data));
        nameCell.append(dot, document.createTextNode(actor.name || actor.actorId));
        rowElement.appendChild(nameCell);
        for (const column of ACTOR_TOOLTIP_COLUMNS.slice(1)) {
          rowElement.appendChild(createElement("td", "", column.format(actor)));
        }
        body.appendChild(rowElement);
      }
      table.appendChild(body);
      rangeTooltip.appendChild(table);
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
    let left = clientX + 12;
    let top = clientY + 12;
    if (left + tooltipRect.width > window.innerWidth - 8) left = clientX - tooltipRect.width - 12;
    if (top + tooltipRect.height > window.innerHeight - 8) top = clientY - tooltipRect.height - 12;
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
  }

  function onRangeTooltipClick(event) {
    event.stopPropagation();
    if (event.target.closest(".aap-range-tooltip-close")) return hideRangeTooltip();
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
    };
  }

  document.addEventListener("click", (event) => {
    if (!rangeTooltipState.pinned) return;
    if (rangeTooltip?.contains(event.target) || rangeTooltipState.canvas?.contains(event.target)) return;
    hideRangeTooltip();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && rangeTooltipState.pinned) hideRangeTooltip();
  });

  async function loadRange() {
    if (!validRange(state.range) || !state.observedMonth) return;
    if (state.loading) return;
    await AAP_API.whenReady?.();
    if (!validRange(state.range) || !state.observedMonth || state.loading) return;
    const key = dataKey();
    if (!key) return;
    if (Date.now() < state.retryAt) return;
    const cached = memoryCache.get(key);
    const fresh = cached && Date.now() - cached.updatedAt < rangeCacheTtl(state.range);
    if (key === state.loadedKey && fresh) return;
    state.loadedKey = key;
    state.loading = true;
    state.error = null;
    renderRangeView();
    const loadId = ++state.loadId;
    try {
      const dates = apiDates(state.range);
      const rawData = fresh
        ? cached.data
        : await AAP_API.rangeData(dates.start, dates.end, state.actorIds);
      if (loadId !== state.loadId || key !== dataKey()) return;
      memoryCache.set(key, { data: rawData, updatedAt: Date.now() });
      state.rawData = rawData;
      state.data = AAPR.group(rawData, state.grouping);
      state.retryAt = 0;
    } catch (error) {
      if (loadId !== state.loadId || key !== dataKey()) return;
      state.error = error;
      state.loadedKey = null;
      state.retryAt = Date.now() + 10_000;
    } finally {
      if (loadId === state.loadId && key === dataKey()) state.loading = false;
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
