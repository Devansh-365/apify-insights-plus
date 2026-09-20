/* Adds an account-wide run-success overview to the Insights debugging page. */
(function () {
  const ROUTE_RE = /^(?:\/organization\/[^/]+)?\/actors\/insights\/debugging\/?$/;
  const OVERVIEW_CLASS = "aap-debugging-overview-page";
  const HOST_CLASS = "aap-debugging-overview";
  const MAX_RUNS_PER_PAGE = 100;

  // Matches lib/api.js's cacheTtl(): current-month data settles quickly and
  // is worth re-checking every minute; historical months are effectively
  // final, so re-check them far less often. Only applies to the account-wide
  // overview (no Actor selected) — see ensureHost().
  const CURRENT_MONTH_REFRESH_TTL_MS = 60 * 1000;
  const HISTORICAL_REFRESH_TTL_MS = 15 * 60 * 1000;

  const state = {
    actors: [],
    rows: [],
    total: null,
    selectedActorId: null,
    monthStartAt: null,
    contextKey: null,
    query: "",
    showOriginal: false,
    sort: "rate",
    direction: "desc",
    loading: false,
    error: null,
    completed: 0,
    requestId: 0,
    loadedAt: 0,
    runs: [],
    runsTotal: null,
    runsNextPageToken: null,
    runsLoading: false,
    runsError: null,
  };

  let host = null;
  let refs = null;
  let pageThemeSignature = "";
  let lastRouteKey = "";
  let tooltip = null;

  AAP_API.onTokenChange?.(() => {
    // A tab can stay open while the user logs out or switches accounts. Do
    // not keep showing the previous account's debugging data in that case.
    state.requestId++;
    state.contextKey = null;
    state.loading = false;
    state.actors = [];
    state.rows = [];
    state.total = null;
    state.runs = [];
    state.runsNextPageToken = null;
    state.loadedAt = 0;
  });

  // A closed-and-reopened tab loses all in-memory state, so on a fresh page
  // load there is otherwise no way to avoid a full reload even for data that
  // was just fetched a minute ago. Paint the last durably-cached overview
  // immediately, then let ensureHost()'s normal TTL/silent-refresh path (see
  // beginLoad()) decide whether to quietly bring it up to date. Only applies
  // to the account-wide overview, matching the periodic-refresh scope
  // decision: a URL that already points at a selected Actor always does a
  // normal load instead.
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
      if (state.requestId || currentActorId()) return;
      const month = currentMonthStartAt();
      const scope = AAP_API.authScope?.() || "";
      const cached = await AAP_CACHE.getView("debugging", refreshTtl(month), `${month}:${scope}`);
      if (!cached.hit || state.requestId || currentActorId()) return;
      state.contextKey = contextKey(month, null);
      state.selectedActorId = null;
      state.monthStartAt = month;
      state.actors = cached.data.actors || [];
      state.rows = cached.data.rows || [];
      state.total = cached.data.total ?? null;
      state.requestId = 1;
      state.loadedAt = cached.updatedAt;
      renderRows();
    } catch {
      // Best effort only; ensureHost() still triggers a normal load either way.
    } finally {
      restoreSettled = true;
    }
  })();

  const onRoute = () => ROUTE_RE.test(location.pathname);

  if (onRoute()) document.documentElement.classList.add(OVERVIEW_CLASS);

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
    const grid = themeVariable("--color-neutral-separator-subtle") || border;
    const signature = [background, text, muted, border, backgroundMuted, grid].join("|");
    if (signature === pageThemeSignature) return;
    pageThemeSignature = signature;
    const root = document.documentElement;
    root.style.setProperty("--aap-debugging-surface", background);
    root.style.setProperty("--aap-debugging-text", text);
    root.style.setProperty("--aap-debugging-muted", muted);
    root.style.setProperty("--aap-debugging-border", border);
    root.style.setProperty("--aap-debugging-surface-muted", backgroundMuted);
    root.style.setProperty("--aap-debugging-grid", grid);
  }

  function debuggingContent() {
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

  function number(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function currentActorId() {
    return new URLSearchParams(location.search).get("actorId") || null;
  }

  function currentMonthStartAt() {
    const period = new URLSearchParams(location.search).get("timePeriod");
    if (/^\d{4}-\d{2}$/.test(period || "")) return `${period}-01T00:00:00.000Z`;
    if (/^\d{4}-\d{2}-\d{2}/.test(state.monthStartAt || "")) return `${state.monthStartAt.slice(0, 7)}-01T00:00:00.000Z`;
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01T00:00:00.000Z`;
  }

  function monthLabel(value) {
    return value
      ? new Date(value).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })
      : "selected month";
  }

  function currentCalendarMonthStartAt() {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01T00:00:00.000Z`;
  }

  function refreshTtl(month) {
    return month === currentCalendarMonthStartAt() ? CURRENT_MONTH_REFRESH_TTL_MS : HISTORICAL_REFRESH_TTL_MS;
  }

  function isFutureDay(day) {
    const today = new Date().toISOString().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) && day > today;
  }

  function statsFor(raw) {
    const dailyStats = raw?.dailyStats && typeof raw.dailyStats === "object" ? raw.dailyStats : {};
    let total = 0;
    let succeeded = 0;
    for (const [day, row] of Object.entries(dailyStats)) {
      if (isFutureDay(day)) continue;
      const rowTotal = number(row?.TOTAL);
      const rowSucceeded = number(row?.SUCCEEDED) || 0;
      const calculatedTotal = ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT", "TIMED_OUT"]
        .reduce((sum, status) => sum + (number(row?.[status]) || 0), 0);
      total += rowTotal == null ? calculatedTotal : rowTotal;
      succeeded += rowSucceeded;
    }
    return {
      dailyStats,
      total,
      succeeded,
      failed: Math.max(0, total - succeeded),
      rate: total > 0 ? succeeded / total : null,
    };
  }

  function rateEntries(stats) {
    return Object.keys(stats?.dailyStats || {}).filter((day) => !isFutureDay(day)).sort().map((day) => {
      const row = stats.dailyStats[day] || {};
      const total = number(row.TOTAL) ?? ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT", "TIMED_OUT"]
        .reduce((sum, status) => sum + (number(row[status]) || 0), 0);
      const succeeded = number(row.SUCCEEDED) || 0;
      return { day, row, total, succeeded, rate: total > 0 ? succeeded / total : null };
    });
  }

  function formatInteger(value) {
    return value == null ? "–" : Number(value).toLocaleString("en-US");
  }

  function formatRate(value) {
    return value == null ? "–" : `${(value * 100).toFixed(1)}%`;
  }

  function formatDateTime(value) {
    if (!value) return "–";
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? "–" : date.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function formatDuration(startedAt, finishedAt) {
    if (!startedAt || !finishedAt) return "–";
    const seconds = (new Date(finishedAt) - new Date(startedAt)) / 1000;
    if (!Number.isFinite(seconds) || seconds < 0) return "–";
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${Math.round(seconds % 60)}s`;
  }

  function statusLabel(status) {
    return String(status || "Unknown").toLowerCase().replace(/(^|[-_])([a-z])/g, (_, prefix, letter) => `${prefix ? " " : ""}${letter.toUpperCase()}`);
  }

  function contextKey(monthStartAt, actor) {
    return `${monthStartAt}|${actor || ""}`;
  }

  function sortedRows() {
    const query = state.query.trim().toLowerCase();
    const rows = query
      ? state.rows.filter((row) => `${row.actor.title} ${row.actor.name}`.toLowerCase().includes(query))
      : state.rows;
    return [...rows].sort((a, b) => {
      if (state.sort === "name") {
        return (a.actor.title.localeCompare(b.actor.title) * (state.direction === "asc" ? 1 : -1));
      }
      const valueFor = (row) => {
        if (!row?.stats) return null;
        if (state.sort === "failed") return number(row.stats.failed);
        if (state.sort === "total") return number(row.stats.total);
        return number(row.stats.rate);
      };
      const valueA = valueFor(a);
      const valueB = valueFor(b);
      if (valueA == null && valueB == null) return a.actor.title.localeCompare(b.actor.title);
      if (valueA == null) return 1;
      if (valueB == null) return -1;
      return ((valueA - valueB) * (state.direction === "asc" ? 1 : -1))
        || a.actor.title.localeCompare(b.actor.title);
    });
  }

  function actorLink(actor) {
    const url = new URL(location.href);
    url.searchParams.set("actorId", actor.id);
    return `${url.pathname}${url.search}`;
  }

  function allActorsLink() {
    const url = new URL(location.href);
    url.searchParams.delete("actorId");
    return `${url.pathname}${url.search}`;
  }

  function syncView() {
    const active = onRoute();
    document.documentElement.classList.toggle(OVERVIEW_CLASS, active && !state.showOriginal);
    host?.classList.toggle("aap-debugging-original-mode", state.showOriginal);
    window.AAP_INSIGHTS_NAV?.ensureViewToggle("debugging", state.showOriginal ? "original" : "custom", setViewMode);
  }

  function setViewMode(mode) {
    state.showOriginal = mode === "original";
    syncView();
    if (!state.showOriginal && !state.contextKey) {
      beginLoad(currentMonthStartAt(), currentActorId(), false);
    }
  }

  function actorCell(actor, total) {
    const cell = createElement("td", "aap-debugging-actor-cell");
    if (total) {
      const text = createElement("span", "aap-debugging-actor-name");
      text.append(createElement("strong", null, "All actors"), createElement("small", null, "account total"));
      cell.appendChild(text);
      return cell;
    }
    const link = document.createElement("a");
    link.className = "aap-debugging-actor-link";
    link.href = actorLink(actor);
    link.title = "Show this Actor's success rate and User runs";
    if (actor.pictureUrl) {
      const image = document.createElement("img");
      image.src = actor.pictureUrl;
      image.alt = "";
      image.loading = "lazy";
      link.appendChild(image);
    }
    const text = createElement("span", "aap-debugging-actor-name");
    text.append(createElement("strong", null, actor.title), createElement("small", null, actor.name));
    link.appendChild(text);
    cell.appendChild(link);
    return cell;
  }

  function summaryCell(stats) {
    const cell = createElement("td", "aap-debugging-summary-cell");
    if (!stats) {
      cell.appendChild(createElement("span", "aap-debugging-empty", state.loading ? "–" : "Unavailable"));
      return cell;
    }
    const values = rateEntries(stats).map((entry) => entry.rate).filter((value) => value != null);
    const lowest = values.length ? Math.min(...values) : null;
    cell.append(
      createElement("strong", null, formatRate(stats.rate)),
      createElement("small", null, `${formatInteger(stats.succeeded)} / ${formatInteger(stats.total)} succeeded`),
      createElement("small", "aap-debugging-lowest", `lowest ${formatRate(lowest)}`),
    );
    return cell;
  }

  function chartCell(row) {
    const cell = createElement("td", "aap-debugging-chart-cell");
    if (!row.stats) {
      cell.appendChild(createElement("span", "aap-debugging-empty", row.failed ? "Could not load this Actor" : state.loading ? "–" : "No run data"));
      return cell;
    }
    const canvas = document.createElement("canvas");
    canvas.className = "aap-debugging-chart";
    canvas.setAttribute("aria-label", `${row.actor.title} run success rate`);
    canvas.__aapStats = row.stats;
    canvas.addEventListener("mousemove", onChartHover);
    canvas.addEventListener("mouseleave", hideTooltip);
    cell.appendChild(canvas);
    requestAnimationFrame(() => drawChart(canvas, row.stats));
    return cell;
  }

  function chartRow(row, total = false) {
    const tableRow = document.createElement("tr");
    if (row.failed) tableRow.className = "aap-debugging-row-partial";
    tableRow.append(actorCell(row.actor, total), summaryCell(row.stats), chartCell(row));
    return tableRow;
  }

  function emptyTableRow(message, colSpan = 3) {
    const row = document.createElement("tr");
    const cell = createElement("td", "aap-debugging-table-empty", message);
    cell.colSpan = colSpan;
    row.appendChild(cell);
    return row;
  }

  function appendChartHeader(table) {
    const head = document.createElement("thead");
    const row = document.createElement("tr");
    for (const [label, title] of [
      ["Actor", ""],
      ["Success rate", "Weighted run success rate for the selected month."],
      ["Daily trend", "The vertical scale is zoomed around the observed success rates."],
    ]) {
      const header = createElement("th", null, label);
      if (title) header.title = title;
      row.appendChild(header);
    }
    head.appendChild(row);
    table.appendChild(head);
  }

  function extractRuns(raw) {
    return Array.isArray(raw) ? raw : raw?.data || raw?.items || [];
  }

  function runsPage(raw) {
    const pagination = raw?.sequencePagination || {};
    return {
      rows: extractRuns(raw),
      nextPageToken: pagination.nextPageToken || null,
      totalCount: number(pagination.totalCount),
    };
  }

  function runLink(run) {
    const runId = encodeURIComponent(run?._id || "");
    const prefix = location.pathname.match(/^(.*)\/actors\/insights\/debugging\/?$/)?.[1] || "";
    return `${prefix}/actors/runs/${runId}`;
  }

  function runCell(run) {
    const cell = document.createElement("td");
    const link = document.createElement("a");
    link.className = "aap-debugging-run-link";
    link.href = runLink(run);
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = run?._id || "Unknown run";
    cell.appendChild(link);
    return cell;
  }

  function renderRunRows() {
    if (!refs?.runsBody) return;
    refs.runsBody.replaceChildren();
    if (!state.runs.length) {
      refs.runsBody.appendChild(emptyTableRow(state.runsLoading ? "Loading User runs…" : state.runsError ? "User runs could not be loaded." : "No User runs found.", 6));
    } else {
      for (const run of state.runs) {
        const row = document.createElement("tr");
        const status = String(run.status || "").toUpperCase();
        row.append(
          runCell(run),
          createElement("td", null, run.isRunOfPayingUser == null ? "–" : run.isRunOfPayingUser ? "Paying" : "Free"),
          createElement("td", null, formatDateTime(run.finishedAt)),
          createElement("td", "aap-debugging-run-number", formatDuration(run.startedAt, run.finishedAt)),
          createElement("td", `aap-debugging-run-status aap-debugging-status-${status.toLowerCase().replace(/_/g, "-")}`, statusLabel(status)),
          createElement("td", "aap-debugging-run-number", formatInteger(run.dataset?.cleanItemCount)),
        );
        refs.runsBody.appendChild(row);
      }
    }

    if (refs.runsStatus) {
      if (state.runsError) refs.runsStatus.textContent = state.runsError;
      else if (state.runsLoading) refs.runsStatus.textContent = "Loading User runs…";
      else if (state.runsTotal != null) refs.runsStatus.textContent = `Showing ${state.runs.length} of ${formatInteger(state.runsTotal)} User runs`;
      else refs.runsStatus.textContent = state.runs.length ? `${state.runs.length} User runs` : "";
    }
    if (refs.runsMore) {
      refs.runsMore.hidden = !state.runsNextPageToken;
      refs.runsMore.disabled = state.runsLoading;
      refs.runsMore.textContent = state.runsLoading ? "Loading…" : "Load more runs";
    }
  }

  function renderRows() {
    if (!refs) return;
    const selected = !!state.selectedActorId;
    if (refs.refresh) refs.refresh.disabled = state.loading || state.runsLoading;
    if (refs.sort) refs.sort.hidden = selected;
    if (refs.order) {
      refs.order.hidden = selected;
      refs.order.textContent = state.direction === "asc" ? "↑ Asc" : "↓ Desc";
    }
    refs.overviewSection.hidden = selected;
    refs.actorsSection.hidden = selected;
    refs.selectedSection.hidden = !selected;
    refs.runsSection.hidden = !selected;
    if (refs.showAll) refs.showAll.hidden = !selected;

    if (selected) {
      const row = state.rows[0] || {
        actor: state.actors.find((actor) => actor.id === state.selectedActorId) || { id: state.selectedActorId, title: state.selectedActorId, name: state.selectedActorId },
        stats: null,
        failed: false,
      };
      refs.selectedSummary.textContent = `${row.actor.title} · ${monthLabel(state.monthStartAt)}`;
      refs.selectedBody.replaceChildren(chartRow(row));
      renderRunRows();
    } else {
      refs.summary.textContent = state.loading
        ? `Loading ${state.actors.length ? `${state.completed} of ${state.actors.length}` : "Actors"} · ${monthLabel(state.monthStartAt)}…`
        : `${sortedRows().length} of ${state.actors.length} Actors · ${monthLabel(state.monthStartAt)}`;
      refs.status.textContent = state.error || "";
      refs.overviewBody.replaceChildren();
      if (state.total) refs.overviewBody.appendChild(chartRow({ actor: { id: "__all__", title: "All actors", name: "Account total" }, stats: state.total }, true));
      else if (!state.loading) refs.overviewBody.appendChild(emptyTableRow(state.error || "No run data available."));
      refs.actorsBody.replaceChildren();
      for (const row of sortedRows()) refs.actorsBody.appendChild(chartRow(row));
      if (!sortedRows().length && !state.loading) refs.actorsBody.appendChild(emptyTableRow(state.error || "No Actor run data available."));
    }
    if (selected) {
      refs.summary.textContent = state.loading ? `Loading selected Actor · ${monthLabel(state.monthStartAt)}…` : refs.selectedSummary.textContent;
      refs.status.textContent = state.error || "";
    }
  }

  function createHost() {
    host = createElement("section", HOST_CLASS);
    host.setAttribute("aria-label", "Run success rate overview");

    const header = createElement("div", "aap-debugging-header");
    const heading = createElement("div");
    heading.append(
      createElement("h2", null, "Run success rate"),
      createElement("p", null, "Daily success-rate trends for all your Actors."),
    );
    const summary = createElement("span", "aap-debugging-summary");
    const controls = createElement("div", "aap-debugging-controls aap-insights-controls");
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Filter Actors";
    search.setAttribute("aria-label", "Filter Actors");
    search.addEventListener("input", () => {
      state.query = search.value;
      renderRows();
    });
    const showAll = document.createElement("a");
    showAll.className = "aap-debugging-show-all";
    showAll.href = allActorsLink();
    showAll.textContent = "Show all Actors";
    showAll.hidden = true;

    const sort = document.createElement("select");
    sort.className = "aap-debugging-sort";
    sort.setAttribute("aria-label", "Sort Actors by");
    for (const [value, label] of [["rate", "Success rate"], ["failed", "Failed runs"], ["total", "Total runs"], ["name", "Name"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `Sort by ${label}`;
      sort.appendChild(option);
    }
    sort.value = state.sort;
    sort.addEventListener("change", () => {
      state.sort = sort.value;
      renderRows();
    });
    const order = createElement("button", "aap-debugging-order", state.direction === "asc" ? "↑ Asc" : "↓ Desc");
    order.type = "button";
    order.setAttribute("aria-label", "Toggle Actor success-rate order");
    order.title = "Switch between descending and ascending success-rate order";
    order.addEventListener("click", () => {
      state.direction = state.direction === "asc" ? "desc" : "asc";
      renderRows();
    });
    const refresh = createElement("button", "aap-debugging-refresh", "Refresh");
    refresh.type = "button";
    refresh.addEventListener("click", () => beginLoad(currentMonthStartAt(), currentActorId(), true));
    controls.append(search, sort, order, refresh, showAll);
    header.append(heading, summary);
    const status = createElement("div", "aap-debugging-status");

    function chartTableSection(label, ariaLabel, bodyKey) {
      const section = createElement("section", "aap-debugging-section");
      section.setAttribute("aria-label", label);
      const shell = createElement("div", "aap-debugging-table-shell");
      const scroll = createElement("div", "aap-debugging-table-scroll");
      const table = document.createElement("table");
      table.className = "aap-debugging-table";
      table.setAttribute("aria-label", ariaLabel);
      appendChartHeader(table);
      const body = document.createElement("tbody");
      table.appendChild(body);
      scroll.appendChild(table);
      shell.appendChild(scroll);
      section.appendChild(shell);
      section[bodyKey] = body;
      return section;
    }
    const overviewSection = chartTableSection("All actors", "Account-wide run success rate", "overviewBody");
    const actorsSection = chartTableSection("Actors", "Run success rates for each Actor", "actorsBody");

    const selectedSection = createElement("section", "aap-debugging-section");
    const selectedTitle = createElement("h3", "aap-debugging-section-title", "Selected Actor");
    const selectedSummary = createElement("span", "aap-debugging-selected-summary");
    selectedTitle.appendChild(selectedSummary);
    const selectedShell = createElement("div", "aap-debugging-table-shell");
    const selectedScroll = createElement("div", "aap-debugging-table-scroll");
    const selectedTable = document.createElement("table");
    selectedTable.className = "aap-debugging-table";
    selectedTable.setAttribute("aria-label", "Selected Actor run success rate");
    appendChartHeader(selectedTable);
    const selectedBody = document.createElement("tbody");
    selectedTable.appendChild(selectedBody);
    selectedScroll.appendChild(selectedTable);
    selectedShell.appendChild(selectedScroll);
    selectedSection.append(selectedTitle, selectedShell);
    selectedSection.hidden = true;

    const runsSection = createElement("section", "aap-debugging-runs-section");
    const runsHeader = createElement("div", "aap-debugging-runs-header");
    runsHeader.appendChild(createElement("h3", "aap-debugging-section-title", "User runs"));
    const runsStatus = createElement("span", "aap-debugging-runs-status");
    runsHeader.appendChild(runsStatus);
    const runsShell = createElement("div", "aap-debugging-table-shell");
    const runsScroll = createElement("div", "aap-debugging-table-scroll");
    const runsTable = document.createElement("table");
    runsTable.className = "aap-debugging-runs-table";
    runsTable.setAttribute("aria-label", "User runs for the selected Actor");
    const runsHead = document.createElement("thead");
    const runsHeadRow = document.createElement("tr");
    for (const label of ["Run ID", "User type", "Finished", "Duration", "Status", "Results"]) runsHeadRow.appendChild(createElement("th", null, label));
    runsHead.appendChild(runsHeadRow);
    const runsBody = document.createElement("tbody");
    runsTable.append(runsHead, runsBody);
    runsScroll.appendChild(runsTable);
    runsShell.appendChild(runsScroll);
    const runsMore = createElement("button", "aap-debugging-more", "Load more runs");
    runsMore.type = "button";
    runsMore.hidden = true;
    runsMore.addEventListener("click", () => loadRunsPage(state.selectedActorId, state.requestId, false));
    runsSection.append(runsHeader, runsShell, runsMore);

    host.append(header, controls, status, overviewSection, actorsSection, selectedSection, runsSection);
    refs = {
      summary,
      status,
      search,
      refresh,
      sort,
      order,
      showAll,
      overviewSection,
      overviewBody: overviewSection.overviewBody,
      actorsSection,
      actorsBody: actorsSection.actorsBody,
      selectedSection,
      selectedSummary,
      selectedBody,
      runsSection,
      runsBody,
      runsStatus,
      runsMore,
    };
    return host;
  }

  function ensureHost() {
    if (!onRoute()) return;
    syncPageTheme();
    syncView();
    const content = debuggingContent();
    if (!content) return;
    const charts = content.querySelector('[class*="InsightsChartsWrapper"]');
    const mount = charts?.parentElement || content;
    if (!host || !host.isConnected || host.parentElement !== mount) {
      host?.remove();
      host = createHost();
      if (charts?.parentElement === mount) mount.insertBefore(host, charts);
      else mount.appendChild(host);
      renderRows();
    }
    const month = currentMonthStartAt();
    const actor = currentActorId();
    const key = contextKey(month, actor);
    if (state.showOriginal || !restoreSettled) return;
    if (key !== state.contextKey) { beginLoad(month, actor, false); return; }
    // Periodic silent refresh only applies to the account-wide overview: a
    // background refresh of the selected-Actor run list would reset its
    // pagination back to page 1 while the user is actively reading it.
    if (!actor && Date.now() - state.loadedAt > refreshTtl(month)) beginLoad(month, actor, false, true);
  }

  function removeHost() {
    document.documentElement.classList.remove(OVERVIEW_CLASS);
    window.AAP_INSIGHTS_NAV?.removeViewToggle("debugging");
    host?.remove();
    host = null;
    refs = null;
    hideTooltip();
  }

  async function beginLoad(monthStartAt, actor, force, silent = false) {
    const key = contextKey(monthStartAt, actor);
    if (!force && !silent && state.contextKey === key && (state.loading || state.rows.length || state.total)) return;
    const requestId = ++state.requestId;
    state.loadedAt = Date.now();
    if (!silent) {
      state.contextKey = key;
      state.selectedActorId = actor;
      state.monthStartAt = monthStartAt;
      state.loading = true;
      state.error = null;
      state.completed = 0;
      state.rows = [];
      state.total = null;
      state.runs = [];
      state.runsTotal = null;
      state.runsNextPageToken = null;
      state.runsError = null;
      state.runsLoading = false;
      renderRows();
    }
    try {
      // The native no-filter chart is backed by this single account-wide
      // request. Start it before waiting for the Actor list so its chart can
      // appear immediately instead of being held up by per-Actor discovery.
      const totalTask = actor
        ? Promise.resolve()
        : AAP_API.runStatistics(monthStartAt, [])
          .then((raw) => {
            if (requestId !== state.requestId) return;
            state.total = statsFor(raw);
            if (!silent) renderRows();
          })
          .catch(() => {
            if (requestId !== state.requestId) return;
            if (!silent) {
              state.error = "Could not load the account-wide success-rate data.";
              renderRows();
            }
          });
      const actors = normalizeActors(await AAP_API.actorList());
      if (requestId !== state.requestId) return;
      state.actors = actors;
      const selected = actor ? actors.find((item) => item.id === actor) || { id: actor, title: actor, name: actor } : null;
      if (selected) {
        state.rows = [{ actor: selected, stats: null, failed: false }];
        renderRows();
        const [statsResult] = await Promise.allSettled([
          AAP_API.runStatistics(monthStartAt, [selected.id]),
          loadRunsPage(selected.id, requestId, true),
        ]);
        if (requestId !== state.requestId) return;
        if (statsResult.status === "fulfilled") state.rows = [{ actor: selected, stats: statsFor(statsResult.value), failed: false }];
        else {
          state.rows = [{ actor: selected, stats: null, failed: true }];
          state.error = "Could not load the selected Actor's success-rate data.";
        }
      } else {
        const actorRows = new Array(actors.length);
        if (!silent) {
          state.rows = actors.map((item) => ({ actor: item, stats: null, failed: false }));
          renderRows();
        }
        const actorPromise = AAP_API.pooled(actors, async (item, index) => {
          try {
            const row = { actor: item, stats: statsFor(await AAP_API.runStatistics(monthStartAt, [item.id])), failed: false };
            actorRows[index] = row;
            return row;
          } catch {
            const row = { actor: item, stats: null, failed: true };
            actorRows[index] = row;
            return row;
          }
        }, (completed) => {
          if (requestId !== state.requestId) return;
          if (!silent) {
            state.completed = completed;
            state.rows = actors.map((item, index) => actorRows[index] || { actor: item, stats: null, failed: false });
            renderRows();
          }
        });
        const [actorResult] = await Promise.allSettled([actorPromise]);
        await totalTask;
        if (requestId !== state.requestId) return;
        state.rows = actorResult.status === "fulfilled" ? actorResult.value.filter(Boolean) : [];
        AAP_CACHE.setView?.("debugging", {
          actors: state.actors,
          rows: state.rows,
          total: state.total,
        }, `${monthStartAt}:${AAP_API.authScope?.() || ""}`);
      }
    } catch (error) {
      if (requestId === state.requestId && !silent) state.error = `Couldn't load debugging data${error?.message ? `: ${error.message}` : "."}`;
    } finally {
      if (requestId === state.requestId) {
        state.loading = false;
        state.completed = state.actors.length;
        renderRows();
      }
    }
  }

  async function loadRunsPage(actor, requestId, reset) {
    if (!actor || state.runsLoading) return;
    state.runsLoading = true;
    state.runsError = null;
    if (refs?.refresh) refs.refresh.disabled = true;
    if (reset) {
      state.runs = [];
      state.runsNextPageToken = null;
      state.runsTotal = null;
    }
    renderRunRows();
    try {
      const raw = await AAP_API.sharedRuns([actor], {
        limit: MAX_RUNS_PER_PAGE,
        searchAfter: reset ? null : state.runsNextPageToken,
        sort: { finishedAt: -1 },
      });
      if (requestId !== state.requestId || state.selectedActorId !== actor) return;
      const page = runsPage(raw);
      const seen = new Set(state.runs.map((run) => run?._id).filter(Boolean));
      state.runs.push(...page.rows.filter((run) => !run?._id || !seen.has(run._id)));
      state.runsNextPageToken = page.nextPageToken;
      state.runsTotal = page.totalCount;
    } catch (error) {
      if (requestId === state.requestId) state.runsError = `Couldn't load User runs${error?.message ? `: ${error.message}` : "."}`;
    } finally {
      if (requestId === state.requestId) {
        state.runsLoading = false;
        if (refs?.refresh) refs.refresh.disabled = state.loading;
        renderRunRows();
      }
    }
  }

  function chartLower(values) {
    const minimum = Math.min(...values);
    if (minimum >= 0.9) return 0.9;
    return Math.max(0, Math.floor((minimum - 0.05) * 10) / 10);
  }

  function drawChart(canvas, stats) {
    const hostElement = canvas.parentElement;
    if (!hostElement) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const styles = getComputedStyle(hostElement.closest(`.${HOST_CLASS}`) || hostElement);
    const text = styles.getPropertyValue("--aap-debugging-text").trim() || "#374151";
    const muted = styles.getPropertyValue("--aap-debugging-muted").trim() || "rgba(0,0,0,0.62)";
    const grid = styles.getPropertyValue("--aap-debugging-grid").trim() || "rgba(17,24,39,0.14)";
    const entries = rateEntries(stats);
    const values = entries.map((entry) => entry.rate).filter((value) => value != null);
    canvas.__aapDebug = { entries, plot: null };
    if (!values.length) {
      ctx.fillStyle = muted;
      ctx.font = `12px ${styles.fontFamily || "sans-serif"}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No runs in this period", rect.width / 2, rect.height / 2);
      return;
    }

    const lower = chartLower(values);
    const upper = 1;
    const left = 48;
    const right = 12;
    const top = 10;
    const bottom = 22;
    const plotWidth = Math.max(1, rect.width - left - right);
    const plotHeight = Math.max(1, rect.height - top - bottom);
    const slot = plotWidth / Math.max(1, entries.length);
    const yFor = (value) => top + plotHeight * (1 - (value - lower) / (upper - lower));
    canvas.__aapDebug.plot = { left, right, top, bottom, slot, yFor };
    ctx.font = `11px ${styles.fontFamily || "sans-serif"}`;
    ctx.lineWidth = 1;
    ctx.strokeStyle = grid;
    ctx.fillStyle = muted;
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (const value of [lower, lower + (upper - lower) / 2, upper]) {
      const y = yFor(value);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(rect.width - right, y);
      ctx.stroke();
      ctx.fillText(`${(value * 100).toFixed(0)}%`, left - 7, y);
    }
    if (lower < 0.95 && upper > 0.95) {
      const y = yFor(0.95);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "rgba(245, 158, 11, 0.65)";
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(rect.width - right, y);
      ctx.stroke();
      ctx.restore();
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelEvery = Math.max(1, Math.ceil(entries.length / 5));
    entries.forEach((entry, index) => {
      if (index % labelEvery !== 0) return;
      const x = left + index * slot + slot / 2;
      const date = new Date(`${entry.day}T00:00:00Z`);
      ctx.fillStyle = muted;
      ctx.fillText(Number.isNaN(date.valueOf()) ? entry.day : date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }), x, rect.height - bottom + 6);
    });

    ctx.strokeStyle = "#12966f";
    ctx.fillStyle = "#12966f";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    let started = false;
    entries.forEach((entry, index) => {
      if (entry.rate == null) {
        started = false;
        return;
      }
      const x = left + index * slot + slot / 2;
      const y = yFor(entry.rate);
      if (!started) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function renderTooltip(canvas, index, event) {
    const info = canvas.__aapDebug;
    const entry = info?.entries?.[index];
    if (!entry) return;
    if (!tooltip) {
      tooltip = createElement("div", "aap-debugging-tooltip");
      document.body.appendChild(tooltip);
    }
    const row = entry.row || {};
    const failure = Math.max(0, entry.total - entry.succeeded);
    tooltip.replaceChildren(
      createElement("div", "aap-debugging-tooltip-title", new Date(`${entry.day}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" })),
      createElement("div", "aap-debugging-tooltip-row", `Succeeded: ${formatInteger(entry.succeeded)}`),
      createElement("div", "aap-debugging-tooltip-row", `Failed: ${formatInteger(failure)}`),
      createElement("div", "aap-debugging-tooltip-row", `Total runs: ${formatInteger(entry.total)}`),
      createElement("div", "aap-debugging-tooltip-row", `Success rate: ${formatRate(entry.rate)}`),
    );
    tooltip.style.display = "block";
    const tooltipRect = tooltip.getBoundingClientRect();
    let left = event.clientX + 12;
    let top = event.clientY + 12;
    if (left + tooltipRect.width > window.innerWidth - 8) left = event.clientX - tooltipRect.width - 12;
    if (top + tooltipRect.height > window.innerHeight - 8) top = event.clientY - tooltipRect.height - 12;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function onChartHover(event) {
    const canvas = event.currentTarget;
    const info = canvas.__aapDebug;
    const plot = info?.plot;
    if (!plot || !info.entries.length) return hideTooltip();
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x < plot.left || x > rect.width - plot.right) return hideTooltip();
    const index = Math.min(info.entries.length - 1, Math.max(0, Math.floor((x - plot.left) / plot.slot)));
    renderTooltip(canvas, index, event);
  }

  function hideTooltip() {
    if (tooltip) tooltip.style.display = "none";
  }

  window.addEventListener("aap-request-seen", (event) => {
    if (!onRoute()) return;
    const month = event.detail?.month;
    if (month) state.monthStartAt = month;
  });
  window.dispatchEvent(new Event("aap-request-info"));

  const poll = setInterval(() => {
    syncPageTheme();
    const routeKey = `${location.pathname}|${location.search}`;
    if (routeKey !== lastRouteKey) lastRouteKey = routeKey;
    if (onRoute()) ensureHost();
    else removeHost();
  }, 400);
  window.addEventListener("resize", () => {
    if (!onRoute()) return;
    host?.querySelectorAll(".aap-debugging-chart").forEach((canvas) => {
      const row = canvas.closest("tr");
      const actorName = row?.querySelector(".aap-debugging-actor-name strong")?.textContent;
      const data = canvas.__aapStats || (state.selectedActorId
        ? state.rows[0]?.stats
        : actorName === "All actors" ? state.total : state.rows.find((item) => item.actor.title === actorName)?.stats);
      if (data) drawChart(canvas, data);
    });
  });
  window.addEventListener("beforeunload", () => clearInterval(poll));
})();
