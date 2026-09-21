/* Replaces the empty Actor-quality landing state with an account-wide table. */
(function () {
  const ROUTE_RE = /^(?:\/organization\/[^/]+)?\/actors\/insights\/actor-quality\/?$/;
  const OVERVIEW_CLASS = "aap-quality-overview-page";
  const HOST_CLASS = "aap-quality-overview";
  const ACTOR_PAGE_SIZE = 25;
  const CACHE_CLEAR_KEY = "aap.cacheClearedAt";

  // Quality scores/recommendations rarely change; re-check them on the same
  // cadence as Monetization's breakdown reindex so a long-open tab doesn't
  // show numbers from whenever it was first opened.
  const QUALITY_REFRESH_TTL_MS = 15 * 60 * 1000;

  const state = {
    actors: [],
    rows: [],
    query: "",
    suggestionFilter: "all",
    sort: "quality",
    direction: "desc",
    showOriginal: false,
    loading: false,
    error: null,
    completed: 0,
    detailLoading: false,
    requestId: 0,
    loadedAt: 0,
    organization: null,
  };

  let host = null;
  let refs = null;
  let pageThemeSignature = "";
  let qualityTooltip = null;

  AAP_API.onTokenChange?.(() => {
    // A tab can stay open while the user logs out or switches accounts. Do
    // not keep showing the previous account's quality data in that case.
    state.requestId = 0;
    state.loading = false;
    state.detailLoading = false;
    state.error = null;
    state.actors = [];
    state.rows = [];
    state.completed = 0;
    state.loadedAt = 0;
    state.organization = null;
  });

  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes[CACHE_CLEAR_KEY]) return;
    state.requestId++;
    state.loading = false;
    state.detailLoading = false;
    state.error = null;
    state.actors = [];
    state.rows = [];
    state.completed = 0;
    state.loadedAt = 0;
    state.organization = null;
    renderRows();
  });

  // A closed-and-reopened tab loses all in-memory state, so on a fresh page
  // load there is otherwise no way to avoid a full reload even for data that
  // was just fetched a minute ago. Paint the last durably-cached table
  // immediately, then let ensureHost()'s normal TTL/silent-refresh path (see
  // beginLoad()) decide whether to quietly bring it up to date.
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
      const cached = await AAP_CACHE.getView("quality", QUALITY_REFRESH_TTL_MS, viewScope());
      if (!cached.hit || state.requestId) return;
      state.organization = organizationScope();
      state.actors = cached.data.actors || [];
      state.rows = cached.data.rows || [];
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

  function organizationScope() {
    return self.AAP_CONTEXT?.organizationKey?.() || "personal";
  }

  function viewScope() {
    return `${organizationScope()}:${AAP_API.authScope?.() || ""}`;
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

  function settledValue(result, fallback) {
    return result.status === "fulfilled" ? result.value : fallback;
  }

  async function loadActor(actor) {
    const results = await Promise.allSettled([
      AAP_API.actorQualityScores(actor.id, { priority: "foreground" }),
      AAP_API.actorQualityRecommendations(actor.id, { priority: "foreground" }),
      AAP_API.actorQualityBusinessValue(actor.id, { priority: "foreground" }),
      AAP_API.actorMetrics(actor.id, { priority: "foreground" }),
    ]);
    return {
      actor,
      scores: settledValue(results[0], null),
      recommendations: settledValue(results[1], null),
      businessValue: settledValue(results[2], []),
      metrics: settledValue(results[3], null),
      failed: results.some((result) => result.status === "rejected"),
      loaded: true,
    };
  }

  async function loadActorRows(actors, requestId, silent) {
    const completedBefore = state.completed;
    const rows = await AAP_API.pooled(
      actors,
      async (actor) => {
        try {
          return await loadActor(actor);
        } catch {
          return { actor, scores: null, recommendations: null, businessValue: [], metrics: null, failed: true, loaded: true };
        }
      },
      (completed) => {
        if (requestId !== state.requestId || silent) return;
        state.completed = completedBefore + completed;
        renderRows();
      },
      { priority: silent ? "background" : "foreground" },
    );
    return rows.map((row, index) => row || {
      actor: actors[index],
      scores: null,
      recommendations: null,
      businessValue: [],
      metrics: null,
      failed: true,
      loaded: true,
    });
  }

  function placeholderRow(actor) {
    return { actor, scores: null, recommendations: null, businessValue: [], metrics: null, failed: false, loaded: false, loading: true };
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
    return `${actor.title} ${actor.name} ${actor.username}`.toLowerCase().includes(query.trim().toLowerCase());
  }

  async function loadActors(actors, requestId, silent = false) {
    if (!actors.length || state.detailLoading) return;
    state.detailLoading = true;
    ensureRows(actors);
    if (!silent) renderRows();
    try {
      const rows = await loadActorRows(actors, requestId, silent);
      if (requestId !== state.requestId) return;
      mergeRows(rows);
      AAP_CACHE.setView?.("quality", { actors: state.actors, rows: state.rows }, viewScope());
    } finally {
      if (requestId === state.requestId) {
        state.detailLoading = false;
        renderRows();
      }
    }
  }

  async function loadMoreActors(loadAll = false) {
    if (state.detailLoading || !state.actors.length) return;
    const requestId = state.requestId;
    const loadedIds = new Set(state.rows.map((row) => row.actor.id));
    const remaining = state.actors.filter((actor) => !loadedIds.has(actor.id));
    if (!remaining.length) return;
    if (loadAll) {
      for (let index = 0; index < remaining.length; index += ACTOR_PAGE_SIZE) {
        if (requestId !== state.requestId) return;
        await loadActors(remaining.slice(index, index + ACTOR_PAGE_SIZE), requestId);
      }
    } else {
      await loadActors(remaining.slice(0, ACTOR_PAGE_SIZE), requestId);
    }
  }

  async function loadSearchMatches() {
    if (state.detailLoading || !state.query.trim() || !state.actors.length) return;
    const loadedIds = new Set(state.rows.map((row) => row.actor.id));
    const matches = state.actors.filter((actor) => actorMatches(actor, state.query) && !loadedIds.has(actor.id));
    if (matches.length) await loadActors(matches, state.requestId);
  }

  function recommendationItems(row, key) {
    const value = row?.recommendations?.[key];
    return Array.isArray(value) ? value : [];
  }

  function businessValueItems(row) {
    const value = row?.businessValue;
    if (Array.isArray(value)) return value;
    return Array.isArray(value?.improvements) ? value.improvements : [];
  }

  function improvements(row) {
    const seen = new Set();
    return [...recommendationItems(row, "improvements"), ...businessValueItems(row)].filter((item) => {
      const key = item?.id || item?.title;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function praises(row) {
    return recommendationItems(row, "praises");
  }

  function number(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function qualityScore(row) {
    return number(row?.scores?.actorQuality);
  }

  function sortRows(rows) {
    return rows.sort((a, b) => {
      const actorA = a.actor;
      const actorB = b.actor;
      let result = 0;
      if (state.sort === "name") {
        result = actorA.title.localeCompare(actorB.title);
      } else if (state.sort === "improvements") {
        result = improvements(a).length - improvements(b).length;
      } else if (state.sort === "runs") {
        result = (number(a.metrics?.publicActorRunStats30Days?.TOTAL) || 0) - (number(b.metrics?.publicActorRunStats30Days?.TOTAL) || 0);
      } else if (state.sort === "users") {
        result = (number(a.metrics?.totalUsers) || 0) - (number(b.metrics?.totalUsers) || 0);
      } else {
        result = (qualityScore(a) || -1) - (qualityScore(b) || -1);
      }
      return (result * (state.direction === "asc" ? 1 : -1)) || actorA.title.localeCompare(actorB.title);
    });
  }

  function filteredRows() {
    const query = state.query.trim().toLowerCase();
    const rows = state.rows.filter((row) => {
      const suggestionCount = improvements(row).length;
      if (state.suggestionFilter === "with" && suggestionCount === 0) return false;
      if (state.suggestionFilter === "without" && suggestionCount > 0) return false;
      if (!query) return true;
      const suggestions = improvements(row).map((item) => item.title || "").join(" ");
      return `${row.actor.title} ${row.actor.name} ${suggestions}`.toLowerCase().includes(query);
    });
    return sortRows(rows);
  }

  function loadedActorCount() {
    return state.rows.filter((row) => row.loaded).length;
  }

  function formatInteger(value) {
    return value == null ? "–" : Number(value).toLocaleString("en-US");
  }

  function formatPercent(value) {
    return value == null ? "–" : `${(value * 100).toFixed(1)}%`;
  }

  function formatPercentile(value) {
    if (value == null) return "–";
    const rounded = (value * 100).toFixed(1);
    return `${rounded}th percentile`;
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

  function insightsCell(items, emptyText, className) {
    const cell = createElement("td", className);
    if (!items.length) {
      cell.appendChild(createElement("span", "aap-quality-empty", emptyText));
      return cell;
    }
    const list = createElement("span", "aap-quality-insight-list");
    items.forEach((item, index) => {
      const title = item.title || "Untitled";
      const description = plainText(item.description);
      const insight = createElement("span", "aap-quality-insight-item", title);
      if (description) {
        insight.tabIndex = 0;
        insight.setAttribute("aria-label", `${title}: ${description}`);
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
    return cell;
  }

  function actorCell(actor, total) {
    const cell = createElement("td", "aap-quality-actor-cell");
    if (total) {
      const text = createElement("span", "aap-quality-actor-name");
      text.appendChild(createElement("strong", null, "All actors"));
      text.appendChild(createElement("small", null, "Account total"));
      cell.appendChild(text);
      return cell;
    }
    const link = document.createElement("a");
    link.className = "aap-quality-actor-link";
    link.href = `${location.pathname}?actorId=${encodeURIComponent(actor.id)}`;
    link.title = "Open Apify's detailed Actor quality view";
    if (actor.pictureUrl) {
      const image = document.createElement("img");
      image.src = actor.pictureUrl;
      image.alt = "";
      image.loading = "lazy";
      link.appendChild(image);
    }
    const text = createElement("span", "aap-quality-actor-name");
    text.appendChild(createElement("strong", null, actor.title));
    text.appendChild(createElement("small", null, actor.name));
    link.appendChild(text);
    cell.appendChild(link);
    return cell;
  }

  function setupCell(row) {
    const cell = createElement("td", "aap-quality-setup");
    if (row.totalSummary) {
      cell.appendChild(createElement("strong", null, `${row.totalSummary.setupReady}/${row.totalSummary.setupTotal}`));
      cell.appendChild(createElement("small", null, "Actors fully set up"));
      return cell;
    }
    const badges = createElement("span", "aap-quality-setup-list");
    const checks = [
      ["Input", row.scores?.hasInputSchema],
      ["Output", row.scores?.hasOutputSchema],
      ["README", row.scores?.hasReadme],
    ];
    for (const [label, present] of checks) {
      const badge = createElement("span", `aap-quality-badge ${present ? "aap-quality-badge-good" : "aap-quality-badge-missing"}`, label);
      badge.title = present ? `${label} available` : `${label} missing`;
      badges.appendChild(badge);
    }
    cell.appendChild(badges);
    return cell;
  }

  function qualityCell(row) {
    const cell = createElement("td", "aap-quality-score");
    const score = qualityScore(row);
    if (score == null) {
      cell.appendChild(createElement("span", "aap-quality-empty", row.failed ? "Unavailable" : "–"));
      return cell;
    }
    const value = createElement("strong", null, formatPercent(score));
    const meter = createElement("span", "aap-quality-meter");
    const fill = createElement("span", "aap-quality-meter-fill");
    fill.style.width = `${Math.max(0, Math.min(100, score * 100))}%`;
    meter.appendChild(fill);
    cell.append(value, meter, createElement("small", null, row.totalSummary ? "average" : formatPercentile(number(row.scores?.actorQualityPercentile))));
    return cell;
  }

  function insightCountCell(count, label, className) {
    const cell = createElement("td", className);
    cell.append(createElement("strong", null, formatInteger(count)), createElement("small", null, label));
    return cell;
  }

  function metricsCell(row, kind) {
    const cell = createElement("td", "aap-quality-metric");
    const metrics = row.metrics;
    if (!metrics) {
      cell.appendChild(createElement("span", "aap-quality-empty", "Unavailable"));
      return cell;
    }
    if (kind === "runs") {
      cell.appendChild(createElement("strong", null, formatInteger(metrics.publicActorRunStats30Days?.TOTAL)));
      cell.appendChild(createElement("small", null, "last 30 days"));
    } else if (kind === "users") {
      cell.appendChild(createElement("strong", null, formatInteger(metrics.totalUsers)));
      cell.appendChild(createElement("small", null, `${formatInteger(metrics.totalUsers30Days)} last 30 days`));
    } else {
      cell.appendChild(createElement("strong", null, formatPercent(number(metrics.runSuccessRate))));
      cell.appendChild(createElement("small", null, "run success"));
    }
    return cell;
  }

  function qualityTotalRow() {
    if (!state.rows.length) return null;
    const scored = state.rows.map((row) => qualityScore(row)).filter((value) => value != null);
    const setupRows = state.rows.filter((row) => row.scores);
    const setupReady = setupRows.filter((row) => row.scores.hasInputSchema && row.scores.hasOutputSchema && row.scores.hasReadme).length;
    const metricRows = state.rows.filter((row) => row.metrics);
    const runs = metricRows.reduce((sum, row) => sum + (number(row.metrics.publicActorRunStats30Days?.TOTAL) || 0), 0);
    const users = metricRows.reduce((sum, row) => sum + (number(row.metrics.totalUsers) || 0), 0);
    const users30Days = metricRows.reduce((sum, row) => sum + (number(row.metrics.totalUsers30Days) || 0), 0);
    const weightedSuccess = metricRows.reduce((sum, row) => {
      const rate = number(row.metrics.runSuccessRate);
      const actorRuns = number(row.metrics.publicActorRunStats30Days?.TOTAL) || 0;
      return rate == null ? sum : sum + rate * (actorRuns || 1);
    }, 0);
    const successWeight = metricRows.reduce((sum, row) => {
      const rate = number(row.metrics.runSuccessRate);
      return rate == null ? sum : sum + (number(row.metrics.publicActorRunStats30Days?.TOTAL) || 1);
    }, 0);
    return {
      actor: { id: "__all__", title: "All actors", name: "Account total" },
      scores: scored.length ? { actorQuality: scored.reduce((sum, value) => sum + value, 0) / scored.length } : null,
      metrics: metricRows.length ? {
        publicActorRunStats30Days: { TOTAL: runs },
        totalUsers: users,
        totalUsers30Days: users30Days,
        runSuccessRate: successWeight ? weightedSuccess / successWeight : null,
      } : null,
      totalSummary: {
        setupReady,
        setupTotal: state.actors.length,
        highlights: state.rows.reduce((sum, row) => sum + praises(row).length, 0),
        suggestions: state.rows.reduce((sum, row) => sum + improvements(row).length, 0),
      },
    };
  }

  function tableRow(row, total) {
    const tableRow = document.createElement("tr");
    if (row.loading) tableRow.className = "aap-quality-row-loading";
    else if (row.failed) tableRow.className = "aap-quality-row-partial";
    tableRow.append(
      actorCell(row.actor, total),
      qualityCell(row),
      setupCell(row),
      total ? insightCountCell(row.totalSummary.highlights, "highlights", "aap-quality-insights") : insightsCell(praises(row), "None", "aap-quality-insights"),
      total ? insightCountCell(row.totalSummary.suggestions, "suggestions", "aap-quality-insights aap-quality-improvements") : insightsCell(improvements(row), "None", "aap-quality-insights aap-quality-improvements"),
      metricsCell(row, "runs"),
      metricsCell(row, "users"),
      metricsCell(row, "success"),
    );
    return tableRow;
  }

  function loadingTotalRow() {
    const tableRow = document.createElement("tr");
    const loadingCell = (className, label) => {
      const cell = createElement("td", className);
      cell.append(createElement("strong", null, "–"), createElement("small", null, label));
      return cell;
    };
    tableRow.append(
      actorCell({ title: "All actors", name: "Account total" }, true),
      loadingCell("aap-quality-score", "Quality"),
      loadingCell("aap-quality-setup", "Setup"),
      loadingCell("aap-quality-insights", "Highlights"),
      loadingCell("aap-quality-insights aap-quality-improvements", "Suggestions"),
      loadingCell("aap-quality-metric", "last 30 days"),
      loadingCell("aap-quality-metric", "Users"),
      loadingCell("aap-quality-metric", "run success"),
    );
    return tableRow;
  }

  function appendTableHeader(table) {
    const head = document.createElement("thead");
    const row = document.createElement("tr");
    for (const label of ["Actor", "Quality", "Setup", "Highlights", "Suggestions", "Runs (30d)", "Users", "Success"]) {
      const header = createElement("th", null, label);
      if (label === "Setup") header.title = "Checks whether the Actor has an input schema, output schema, and README.";
      row.appendChild(header);
    }
    head.appendChild(row);
    table.appendChild(head);
  }

  function syncView() {
    const active = onOverviewRoute();
    document.documentElement.classList.toggle(OVERVIEW_CLASS, active && !state.showOriginal);
    host?.classList.toggle("aap-quality-original-mode", state.showOriginal);
    window.AAP_INSIGHTS_NAV?.ensureViewToggle("quality", state.showOriginal ? "original" : "custom", setViewMode);
  }

  function setViewMode(mode) {
    state.showOriginal = mode === "original";
    syncView();
    if (!state.showOriginal && !state.requestId) beginLoad(false);
  }

  function renderRows() {
    if (!refs) return;
    const rows = filteredRows();
    const loadedCount = loadedActorCount();
    refs.summary.textContent = state.loading
      ? `Loading Actor list${state.actors.length ? ` · ${state.completed} of ${state.rows.length} details` : ""}…`
      : `Showing ${rows.length} matching Actors · ${loadedCount} details loaded · ${state.actors.length} total`;
    if (state.error) refs.status.textContent = state.error;
    else refs.status.textContent = "";

    hideQualityTooltip();
    refs.totalBody.replaceChildren();
    const total = qualityTotalRow();
    if (state.loading) refs.totalBody.appendChild(loadingTotalRow());
    else if (total) refs.totalBody.appendChild(tableRow(total, true));

    refs.body.replaceChildren();
    if (!rows.length) {
      if (!state.loading) {
        const empty = document.createElement("tr");
        const cell = createElement("td", "aap-quality-table-empty", state.error ? "No quality data available." : "No Actors match this filter.");
        cell.colSpan = 8;
        empty.appendChild(cell);
        refs.body.appendChild(empty);
      }
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
    host.setAttribute("aria-label", "Actor quality overview");

    const header = createElement("div", "aap-quality-header");
    const heading = createElement("div");
    heading.append(
      createElement("h2", null, "Actor quality overview"),
      createElement("p", null, "Quality scores and recommendations for all your Actors."),
    );
    const summary = createElement("span", "aap-quality-summary");
    header.append(heading, summary);

    const controls = createElement("div", "aap-quality-controls aap-insights-controls");
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Filter Actors or suggestions";
    search.setAttribute("aria-label", "Filter Actors or suggestions");
    search.addEventListener("input", () => {
      state.query = search.value;
      renderRows();
      loadSearchMatches().catch(() => {});
    });
    const suggestionFilter = document.createElement("select");
    suggestionFilter.className = "aap-quality-suggestion-filter";
    suggestionFilter.setAttribute("aria-label", "Filter Actors by suggestions");
    for (const [value, label] of [["all", "All Actors"], ["with", "With suggestions"], ["without", "Without suggestions"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      suggestionFilter.appendChild(option);
    }
    suggestionFilter.addEventListener("change", () => {
      state.suggestionFilter = suggestionFilter.value;
      renderRows();
    });
    const sort = document.createElement("select");
    sort.setAttribute("aria-label", "Sort Actors by");
    for (const [value, label] of [["quality", "Quality"], ["improvements", "Suggestions"], ["runs", "Runs"], ["users", "Users"], ["name", "Name"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `Sort by ${label}`;
      sort.appendChild(option);
    }
    sort.addEventListener("change", () => {
      state.sort = sort.value;
      renderRows();
    });
    const order = createElement("button", "aap-quality-order", "↓ Desc");
    order.type = "button";
    order.setAttribute("aria-label", "Toggle sort direction");
    order.title = "Switch between descending and ascending order";
    order.addEventListener("click", () => {
      state.direction = state.direction === "asc" ? "desc" : "asc";
      order.textContent = state.direction === "asc" ? "↑ Asc" : "↓ Desc";
      renderRows();
    });
    const refresh = createElement("button", "aap-quality-refresh", "Refresh");
    refresh.type = "button";
    refresh.addEventListener("click", () => beginLoad(true));
    const more = createElement("button", "aap-quality-more", "Load more Actors");
    more.type = "button";
    more.addEventListener("click", () => loadMoreActors(false));
    const all = createElement("button", "aap-quality-more", "Load all Actors");
    all.type = "button";
    all.addEventListener("click", () => loadMoreActors(true));
    controls.append(search, suggestionFilter, sort, order, refresh, more, all);

    const status = createElement("div", "aap-quality-status");
    function tableShell(label, bodyKey) {
      const section = createElement("section", "aap-quality-table-section");
      section.setAttribute("aria-label", label);
      const shell = createElement("div", "aap-quality-table-shell");
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
    if (created) renderRows();
    const organization = organizationScope();
    if (state.organization !== organization) {
      state.requestId++;
      state.loading = false;
      state.detailLoading = false;
      state.error = null;
      state.actors = [];
      state.rows = [];
      state.completed = 0;
      state.loadedAt = 0;
      state.organization = organization;
      renderRows();
    }
    if (state.showOriginal || !restoreSettled) return;
    if (!state.loadedAt) beginLoad(false);
    else if (Date.now() - state.loadedAt > QUALITY_REFRESH_TTL_MS) beginLoad(false, true);
  }

  function removeHost() {
    document.documentElement.classList.remove(OVERVIEW_CLASS);
    window.AAP_INSIGHTS_NAV?.removeViewToggle("quality");
    hideQualityTooltip();
    host?.remove();
    host = null;
    refs = null;
  }

  async function beginLoad(force, silent = false) {
    if (state.loading) return;
    if (!force && !silent && state.requestId && state.loadedAt) return;
    const requestId = ++state.requestId;
    state.organization = organizationScope();
    state.loadedAt = Date.now();
    if (!silent) {
      state.loading = true;
      state.error = null;
      state.actors = [];
      state.rows = [];
      state.completed = 0;
      state.detailLoading = false;
      renderRows();
    }
    try {
      const actors = normalizeActors(await AAP_API.actorList());
      if (requestId !== state.requestId) return;
      state.actors = actors;
      if (!silent) {
        state.rows = actors.slice(0, ACTOR_PAGE_SIZE).map(placeholderRow);
        renderRows();
      }
      const actorsToLoad = silent
        ? state.rows.filter((row) => row.loaded).map((row) => row.actor)
        : actors.slice(0, ACTOR_PAGE_SIZE);
      await loadActors(actorsToLoad, requestId, silent);
    } catch (error) {
      if (requestId === state.requestId && !silent) state.error = `Couldn't load Actor quality data${error?.message ? `: ${error.message}` : "."}`;
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
