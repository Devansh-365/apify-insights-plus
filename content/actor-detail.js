/* Adds public activity metrics to Apify's public Actor detail pages. */
(function () {
  const HOST_CLASS = "aap-actor-detail-insights";
  const PAGE_CLASS = "aap-actor-detail-page";
  const REFRESH_TTL_MS = 15 * 60 * 1000;
  const ROUTE_EXCLUSIONS = new Set([
    "about",
    "account",
    "actors",
    "blog",
    "contact",
    "docs",
    "developers",
    "integrations",
    "login",
    "pricing",
    "privacy",
    "products",
    "settings",
    "signup",
    "solutions",
    "store",
    "terms",
    "users",
  ]);

  const state = {
    routeKey: null,
    actorRef: null,
    data: null,
    loading: false,
    error: null,
    loadedAt: 0,
    retryAt: 0,
    requestId: 0,
  };

  let host = null;
  let lastPath = location.pathname;

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function actorRoute() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || ROUTE_EXCLUSIONS.has(parts[0].toLowerCase())) return null;
    let username;
    let actorName;
    try {
      username = decodeURIComponent(parts[0]);
      actorName = decodeURIComponent(parts[1]);
    } catch {
      return null;
    }
    if (!username || !actorName || username.includes("/") || actorName.includes("/")) return null;
    return {
      key: `${username}/${actorName}`,
      actorRef: `${username}~${actorName}`,
    };
  }

  function formatInteger(value) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Number(value) || 0);
  }

  function formatDate(value) {
    if (!value) return "–";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "–";
    return date.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function renderHeading(subtitle) {
    const heading = createElement("div", "aap-actor-detail-heading");
    heading.append(
      createElement("span", "aap-actor-detail-kicker", "Public activity"),
      createElement("h2", null, "Actor insights"),
      createElement("p", null, subtitle),
    );
    return heading;
  }

  function renderLoading() {
    host.replaceChildren(
      renderHeading("Loading the latest public activity snapshot…"),
      createElement("div", "aap-actor-detail-loading", "Loading public Actor statistics…"),
    );
    host.setAttribute("aria-busy", "true");
  }

  function renderError() {
    host.replaceChildren(
      renderHeading("Public activity snapshot"),
      createElement("div", "aap-actor-detail-error", state.error || "Actor statistics could not be loaded."),
    );
    host.removeAttribute("aria-busy");
  }

  function renderSummary(data) {
    const summary = createElement("div", "aap-actor-detail-summary");
    for (const metric of [
      {
        label: "Active users",
        context: "Last 30 days",
        value: formatInteger(data.activeUsers30Days),
        tone: "activity",
      },
      {
        label: "Runs",
        context: "Last 30 days",
        value: formatInteger(data.runs30Days),
        tone: "activity",
      },
      {
        label: "Total runs",
        context: "Lifetime",
        value: formatInteger(data.totalRuns),
        tone: "lifetime",
      },
      {
        label: "Created",
        context: "Actor profile",
        value: formatDate(data.createdAt),
        title: data.createdAt,
        tone: "metadata",
      },
      {
        label: "Pricing updated",
        context: "Latest change",
        value: formatDate(data.pricingUpdatedAt),
        title: data.pricingUpdatedAt,
        tone: "metadata",
      },
      {
        label: "Last run",
        context: "Most recent",
        value: formatDate(data.lastRunAt),
        title: data.lastRunAt,
        tone: "metadata",
      },
    ]) {
      const card = createElement("div", `aap-actor-detail-stat aap-actor-detail-stat-${metric.tone}`);
      card.dataset.metric = metric.label.toLowerCase().replace(/\s+/g, "-");
      card.setAttribute("aria-label", `${metric.label}, ${metric.context}: ${metric.value}`);
      const valueElement = createElement("strong", "aap-actor-detail-stat-value", metric.value);
      if (metric.title) valueElement.title = metric.title;
      const head = createElement("div", "aap-actor-detail-stat-head");
      card.appendChild(head);
      head.append(
        createElement("span", "aap-actor-detail-stat-label", metric.label),
        createElement("span", "aap-actor-detail-stat-context", metric.context),
      );
      card.appendChild(valueElement);
      summary.appendChild(card);
    }
    return summary;
  }

  function formatDayLabel(day) {
    const date = new Date(`${day}T00:00:00`);
    if (Number.isNaN(date.getTime())) return day;
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  }

  function renderDailyRunChart(data) {
    const section = createElement("section", "aap-actor-detail-chart-section");
    const heading = createElement("div", "aap-actor-detail-chart-heading");
    heading.append(
      createElement("h3", null, "Daily runs"),
      createElement("p", null, `Public runs · last 30 days · ${formatInteger(data.runs30Days)} total`),
    );
    section.appendChild(heading);

    const values = data.dailyRuns.slice(-30);
    const maximum = Math.max(1, ...values.map((entry) => entry.runs));
    const chart = createElement("div", "aap-actor-detail-chart aap-actor-detail-chart-daily");
    chart.setAttribute("role", "img");
    chart.setAttribute("aria-label", "Daily public Actor runs for the last 30 days");

    const yAxis = createElement("div", "aap-actor-detail-chart-axis");
    yAxis.append(
      createElement("span", null, formatInteger(maximum)),
      createElement("span", null, formatInteger(Math.ceil(maximum / 2))),
      createElement("span", null, "0"),
    );
    chart.appendChild(yAxis);

    const plot = createElement("div", "aap-actor-detail-chart-plot");
    for (const entry of values) {
      const column = createElement("div", "aap-actor-detail-chart-column");
      const count = createElement("span", "aap-actor-detail-chart-count", entry.runs ? formatInteger(entry.runs) : "");
      const barTrack = createElement("div", "aap-actor-detail-chart-bar-track");
      const bar = createElement("div", "aap-actor-detail-chart-bar");
      bar.style.backgroundColor = "#10b981";
      bar.style.height = entry.runs ? `${Math.max(5, (entry.runs / maximum) * 100)}%` : "0%";
      bar.title = `${formatDayLabel(entry.date)}: ${formatInteger(entry.runs)} runs`;
      bar.setAttribute("aria-label", bar.title);
      barTrack.appendChild(bar);
      const label = createElement("span", "aap-actor-detail-chart-label", formatDayLabel(entry.date));
      column.append(count, barTrack, label);
      plot.appendChild(column);
    }
    chart.appendChild(plot);
    section.appendChild(chart);

    const dailyTotal = values.reduce((sum, entry) => sum + entry.runs, 0);
    const legend = createElement("div", "aap-actor-detail-chart-legend");
    const item = createElement("span", "aap-actor-detail-chart-legend-item");
    const dot = createElement("span", "aap-actor-detail-chart-legend-dot");
    dot.style.backgroundColor = "#10b981";
    item.append(dot, createElement("span", null, `Runs ${formatInteger(dailyTotal)}`));
    legend.appendChild(item);
    section.appendChild(legend);
    return section;
  }

  function renderStatusTotalsChart(data) {
    const section = createElement("section", "aap-actor-detail-chart-section");
    const heading = createElement("div", "aap-actor-detail-chart-heading");
    heading.append(
      createElement("h3", null, "Run status totals"),
      createElement("p", null, `Public runs · last 30 days · ${formatInteger(data.runs30Days)} total`),
    );
    section.appendChild(heading);

    const notice = createElement(
      "p",
      "aap-actor-detail-chart-unavailable",
      "Apify currently publishes public run totals by status, not the count for each individual day.",
    );
    section.appendChild(notice);

    const values = data.runStatusDefinitions.map((status) => ({ ...status, count: data.runStats[status.key] || 0 }));
    const maximum = Math.max(1, ...values.map((status) => status.count));
    const chart = createElement("div", "aap-actor-detail-chart");
    chart.setAttribute("role", "img");
    chart.setAttribute("aria-label", "Run status distribution for the last 30 days");

    const yAxis = createElement("div", "aap-actor-detail-chart-axis");
    yAxis.append(
      createElement("span", null, formatInteger(maximum)),
      createElement("span", null, formatInteger(Math.ceil(maximum / 2))),
      createElement("span", null, "0"),
    );
    chart.appendChild(yAxis);

    const plot = createElement("div", "aap-actor-detail-chart-plot");
    for (const status of values) {
      const column = createElement("div", "aap-actor-detail-chart-column");
      const count = createElement("span", "aap-actor-detail-chart-count", formatInteger(status.count));
      const barTrack = createElement("div", "aap-actor-detail-chart-bar-track");
      const bar = createElement("div", "aap-actor-detail-chart-bar");
      bar.style.backgroundColor = status.color;
      bar.style.height = status.count ? `${Math.max(5, (status.count / maximum) * 100)}%` : "0%";
      bar.title = `${status.label}: ${formatInteger(status.count)}`;
      barTrack.appendChild(bar);
      column.append(count, barTrack, createElement("span", "aap-actor-detail-chart-label", status.label));
      plot.appendChild(column);
    }
    chart.appendChild(plot);
    section.appendChild(chart);

    const legend = createElement("div", "aap-actor-detail-chart-legend");
    for (const status of values) {
      const item = createElement("span", "aap-actor-detail-chart-legend-item");
      const dot = createElement("span", "aap-actor-detail-chart-legend-dot");
      dot.style.backgroundColor = status.color;
      item.append(dot, createElement("span", null, `${status.label} ${formatInteger(status.count)}`));
      legend.appendChild(item);
    }
    section.appendChild(legend);
    return section;
  }

  function renderRunChart(data) {
    return data.dailyRuns?.length ? renderDailyRunChart(data) : renderStatusTotalsChart(data);
  }

  function render() {
    if (!host) return;
    if (state.loading) {
      renderLoading();
      return;
    }
    if (state.error || !state.data) {
      renderError();
      return;
    }

    const heading = renderHeading("Public activity snapshot from the last 30 days");
    host.replaceChildren(heading, renderSummary(state.data), renderRunChart(state.data));
    host.removeAttribute("aria-busy");
  }

  function findMount() {
    return document.querySelector('[class*="ActorDetailContent-Content"]')
      || document.querySelector("main");
  }

  function ensureHost(route) {
    const mount = findMount();
    if (!mount) return false;
    if (!host || !host.isConnected || host.parentElement !== mount) {
      host?.remove();
      host = createElement("section", HOST_CLASS);
      host.setAttribute("aria-label", "Actor insights");
      mount.insertBefore(host, mount.firstElementChild || null);
    }
    if (state.routeKey !== route.key) {
      state.routeKey = route.key;
      state.actorRef = route.actorRef;
      state.data = null;
      state.error = null;
      state.loadedAt = 0;
      state.retryAt = 0;
      load(route);
    } else if (!state.loading
      && (!state.data || Date.now() - state.loadedAt > REFRESH_TTL_MS)
      && (!state.error || Date.now() >= state.retryAt)) {
      load(route);
    } else {
      render();
    }
    return true;
  }

  async function load(route) {
    if (state.loading) return;
    const requestId = ++state.requestId;
    state.loading = true;
    state.error = null;
    state.retryAt = 0;
    render();
    try {
      const raw = await AAP_API.publicActorDetails(route.actorRef);
      if (requestId !== state.requestId || state.routeKey !== route.key) return;
      state.data = AAP_ACTOR_DETAIL.normalize(raw);
      state.loadedAt = Date.now();
    } catch (error) {
      if (requestId !== state.requestId || state.routeKey !== route.key) return;
      state.error = error?.message || "Actor statistics could not be loaded.";
      state.retryAt = Date.now() + 30_000;
    } finally {
      if (requestId === state.requestId && state.routeKey === route.key) {
        state.loading = false;
        render();
      }
    }
  }

  function removeHost() {
    state.requestId++;
    state.routeKey = null;
    state.actorRef = null;
    state.data = null;
    state.loading = false;
    state.error = null;
    state.loadedAt = 0;
    state.retryAt = 0;
    host?.remove();
    host = null;
    document.documentElement.classList.remove(PAGE_CLASS);
  }

  function sync() {
    const route = actorRoute();
    if (!route) {
      if (host || state.routeKey) removeHost();
      return;
    }
    document.documentElement.classList.add(PAGE_CLASS);
    ensureHost(route);
  }

  sync();
  const poll = setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      sync();
      return;
    }
    sync();
  }, 500);
  window.addEventListener("beforeunload", () => clearInterval(poll));
})();
