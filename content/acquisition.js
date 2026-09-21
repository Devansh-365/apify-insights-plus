/* Replaces the single-selection acquisition view with an account-wide table. */
(function () {
  const ROUTE_RE = /^(?:\/organization\/[^/]+)?\/actors\/insights\/acquisition\/?$/;
  const OVERVIEW_CLASS = "aap-acquisition-overview-page";
  const HOST_CLASS = "aap-acquisition-overview";
  const ACTOR_PAGE_SIZE = 25;
  const CACHE_CLEAR_KEY = "aap.cacheClearedAt";

  // Matches lib/api.js's cacheTtl(): current-month data settles quickly and
  // is worth re-checking every minute; historical months are effectively
  // final, so re-check them far less often.
  const CURRENT_MONTH_REFRESH_TTL_MS = 60 * 1000;
  const HISTORICAL_REFRESH_TTL_MS = 15 * 60 * 1000;

  const state = {
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

  AAP_API.onTokenChange?.(() => {
    // A tab can stay open while the user logs out or switches accounts. Do
    // not keep showing the previous account's acquisition data in that case.
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

  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes[CACHE_CLEAR_KEY]) return;
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
    renderRows();
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
      renderRows();
    } catch {
      // Best effort only; ensureHost() still triggers a normal load either way.
    } finally {
      restoreSettled = true;
    }
  })();

  function onOverviewRoute() {
    return ROUTE_RE.test(location.pathname) && !new URLSearchParams(location.search).has("actorId");
  }

  if (onOverviewRoute()) document.documentElement.classList.add(OVERVIEW_CLASS);

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
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01T00:00:00.000Z`;
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
        renderRows();
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
    if (!silent) renderRows();
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
        renderRows();
      }
    }
  }

  async function loadMoreActors(loadAll = false) {
    if (state.detailLoading || !state.actors.length || !state.monthStartAt) return;
    const requestId = state.requestId;
    const loadedIds = new Set(state.rows.map((row) => row.actor.id));
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
    if (state.detailLoading || !state.query.trim() || !state.actors.length) return;
    const loadedIds = new Set(state.rows.map((row) => row.actor.id));
    const matches = state.actors.filter((actor) => actorMatches(actor, state.query) && !loadedIds.has(actor.id));
    if (!matches.length) return;
    await loadActors(matches, state.monthStartAt, previousMonthStartAt(state.monthStartAt), comparisonPortion(state.monthStartAt), state.requestId);
  }

  function formatInteger(value) {
    return value == null ? "–" : Number(value).toLocaleString("en-US");
  }

  function originLabel(origin) {
    return origin || "Direct / unknown";
  }

  function actorCell(actor, total) {
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
    link.appendChild(text);
    cell.appendChild(link);
    return cell;
  }

  function metricCell(row, key, sublabel) {
    const cell = createElement("td", "aap-acquisition-metric");
    if (row.loading) {
      cell.append(createElement("strong", null, "…"), createElement("small", null, "Loading"));
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
      cell.appendChild(createElement("span", "aap-acquisition-empty", "Loading…"));
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

  function sortRows(rows) {
    return rows.sort((a, b) => {
      let result = 0;
      if (state.sort === "name") result = a.actor.title.localeCompare(b.actor.title);
      else if (state.sort === "input") result = (metric(a, "numUniqueConsolePageViews") || 0) - (metric(b, "numUniqueConsolePageViews") || 0);
      else if (state.sort === "started") result = (metric(a, "numUniqueUsersWithRun") || 0) - (metric(b, "numUniqueUsersWithRun") || 0);
      else result = (metric(a, "numUniqueViewingUsers") || 0) - (metric(b, "numUniqueViewingUsers") || 0);
      return (result * (state.direction === "asc" ? 1 : -1)) || a.actor.title.localeCompare(b.actor.title);
    });
  }

  function filteredRows() {
    const query = state.query.trim().toLowerCase();
    return sortRows(state.rows.filter((row) => !query || `${row.actor.title} ${row.actor.name}`.toLowerCase().includes(query)));
  }

  function loadedActorCount() {
    return state.rows.filter((row) => row.loaded).length;
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

  function tableRow(row, total) {
    const tableRow = document.createElement("tr");
    if (row.loading) tableRow.className = "aap-acquisition-row-loading";
    else if (row.failed) tableRow.className = "aap-acquisition-row-partial";
    tableRow.append(
      actorCell(row.actor, total),
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
    window.AAP_INSIGHTS_NAV?.ensureViewToggle("acquisition", state.showOriginal ? "original" : "custom", setViewMode);
  }

  function setViewMode(mode) {
    state.showOriginal = mode === "original";
    syncView();
    if (!state.showOriginal && !state.requestId) beginLoad(monthStartAt(), false);
  }

  function renderRows() {
    if (!refs) return;
    const rows = filteredRows();
    const loadedCount = loadedActorCount();
    refs.summary.textContent = state.loading
      ? `Loading Actor list${state.actors.length ? ` · ${state.completed} of ${state.rows.length} details` : ""} · ${monthLabel(state.monthStartAt)}…`
      : `Showing ${rows.length} matching Actors · ${loadedCount} details loaded · ${state.actors.length} total · ${monthLabel(state.monthStartAt)}`;
    if (state.error) refs.status.textContent = state.error;
    else refs.status.textContent = "";

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
      for (const row of rows) refs.body.appendChild(tableRow(row, false));
    }

    const remaining = Math.max(0, state.actors.length - state.rows.length);
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
  }

  function createHost() {
    host = createElement("section", HOST_CLASS);
    host.setAttribute("aria-label", "Actor acquisition overview");

    const header = createElement("div", "aap-acquisition-header");
    const heading = createElement("div");
    heading.append(
      createElement("h2", null, "Actor acquisition overview"),
      createElement("p", null, "Acquisition activity for all your Actors."),
    );
    const summary = createElement("span", "aap-acquisition-summary");
    header.append(heading, summary);

    const controls = createElement("div", "aap-acquisition-controls aap-insights-controls");
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Filter Actors";
    search.setAttribute("aria-label", "Filter Actors");
    search.addEventListener("input", () => {
      state.query = search.value;
      renderRows();
      loadSearchMatches().catch(() => {});
    });
    const sort = document.createElement("select");
    sort.setAttribute("aria-label", "Sort Actors by");
    for (const [value, label] of [["viewers", "Actor detail"], ["input", "Input page"], ["started", "Actor started"], ["name", "Name"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `Sort by ${label}`;
      sort.appendChild(option);
    }
    sort.addEventListener("change", () => {
      state.sort = sort.value;
      renderRows();
    });
    const order = createElement("button", "aap-acquisition-order", "↓ Desc");
    order.type = "button";
    order.setAttribute("aria-label", "Toggle sort direction");
    order.title = "Switch between descending and ascending order";
    order.addEventListener("click", () => {
      state.direction = state.direction === "asc" ? "desc" : "asc";
      order.textContent = state.direction === "asc" ? "↑ Asc" : "↓ Desc";
      renderRows();
    });
    const refresh = createElement("button", "aap-acquisition-refresh", "Refresh");
    refresh.type = "button";
    refresh.addEventListener("click", () => beginLoad(monthStartAt(), true));
    const more = createElement("button", "aap-acquisition-more", "Load more Actors");
    more.type = "button";
    more.addEventListener("click", () => loadMoreActors(false));
    const all = createElement("button", "aap-acquisition-more", "Load all Actors");
    all.type = "button";
    all.addEventListener("click", () => loadMoreActors(true));
    controls.append(search, sort, order, refresh, more, all);

    const status = createElement("div", "aap-acquisition-status");
    function tableShell(label, bodyKey) {
      const section = createElement("section", `aap-acquisition-table-section ${bodyKey === "totalBody" ? "aap-acquisition-total-section" : "aap-acquisition-actors-section"}`);
      section.setAttribute("aria-label", label);
      const shell = createElement("div", "aap-acquisition-table-shell");
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
    host.append(header, controls, status, totalSection, actorsSection);
    refs = { summary, status, more, all, totalBody: totalSection.totalBody, body: actorsSection.body };
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
    if (created) renderRows();
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
      renderRows();
    }
    const month = monthStartAt();
    if (state.showOriginal || !restoreSettled) return;
    if (!state.requestId || state.monthStartAt !== month) { beginLoad(month, false); return; }
    if (Date.now() - state.loadedAt > refreshTtl(month)) beginLoad(month, false, true);
  }

  function removeHost() {
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
      renderRows();
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
      if (!silent) {
        state.rows = actors.slice(0, ACTOR_PAGE_SIZE).map(placeholderRow);
        renderRows();
      }
      const actorsToLoad = silent
        ? state.rows.filter((row) => row.loaded).map((row) => row.actor)
        : actors.slice(0, ACTOR_PAGE_SIZE);
      await loadActors(actorsToLoad, month, previousMonth, portion, requestId, silent);
      if (requestId !== state.requestId) return;
    } catch (error) {
      if (requestId === state.requestId && !silent) state.error = `Couldn't load acquisition data${error?.message ? `: ${error.message}` : "."}`;
    } finally {
      if (requestId === state.requestId) {
        state.loading = false;
        renderRows();
        loadSearchMatches().catch(() => {});
      }
    }
  }

  const poll = setInterval(() => {
    if (onOverviewRoute()) ensureHost();
    else removeHost();
  }, 400);
  window.addEventListener("beforeunload", () => clearInterval(poll));
})();
