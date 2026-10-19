/*
 * Actor portfolio: replaces Apify's alphabetical per-Actor table on the
 * Monetization page (Plus view only) with a revenue-ranked table grouped into
 * decision segments (invest, fix, convert, reprice, retire). range.js owns the
 * data and calls render()/remove(); the analysis lives in lib/portfolio.js.
 */
(function () {
  const HOST_CLASS = "aap-portfolio";
  const ACTIVE_CLASS = "aap-portfolio-active";
  const PAGE_SIZE = 50;
  const PREVIOUS_RETRY_MS = 60 * 1000;
  const MODEL = self.AAP_PORTFOLIO_MODEL;

  const ui = {
    segment: "all",
    // "auto" sorts All by revenue and a segment by its dollar impact.
    sort: "auto",
    direction: "desc",
    query: "",
    limit: PAGE_SIZE,
  };
  let host = null;
  let lastInput = null;
  let lastAnalysis = null;
  const previousRowsCache = new Map();
  const previousRowsLoading = new Set();

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function money(value) {
    const amount = Number(value) || 0;
    if (Math.abs(amount) < 0.005) return "$0.00";
    return AAPF.money(amount);
  }

  function count(value) {
    return Math.round(Number(value) || 0).toLocaleString("en-US");
  }

  function percent(value, digits = 0) {
    return value == null ? "–" : `${(value * 100).toFixed(digits)}%`;
  }

  function monthLabel(month) {
    return month ? AAPR.formatDate(month, { month: "short", year: "numeric" }) : "";
  }

  function nativeTableWrapper() {
    return document.querySelector('[class*="InsightsChartsWrapper"] [class*="simple_table_wrapper"]');
  }

  function actorHref(id) {
    const organization = location.pathname.match(/^\/organization\/[^/]+/)?.[0] || "";
    return `${organization}/actors/${encodeURIComponent(id)}`;
  }

  function scopeKey(month) {
    const auth = self.AAP_API?.authScope?.() || "";
    const organization = self.AAP_CONTEXT?.organizationKey?.() || "personal";
    return `${auth}|${organization}|${month}`;
  }

  // Pace needs the month before the latest month. When the range does not
  // include it, fetch that one breakdown (cached by the API layer) once.
  function previousRowsFor(data, rowsByMonth) {
    const months = Object.keys(rowsByMonth).sort();
    const latest = months[months.length - 1];
    if (!latest) return null;
    const previous = MODEL.previousMonthKey(latest);
    if (rowsByMonth[previous]) return null;
    // rangeData fetches the previous month in the same batch as the range.
    if (data?.previousBreakdownRows?.month === previous) return data.previousBreakdownRows.rows;
    const key = scopeKey(previous);
    const cached = previousRowsCache.get(key);
    if (cached?.rows) return cached.rows;
    // A failed fetch is retried after a minute instead of disabling pace.
    if (cached && Date.now() - cached.failedAt < PREVIOUS_RETRY_MS) return null;
    if (!previousRowsLoading.has(key) && self.AAP_API?.actorBreakdown) {
      previousRowsLoading.add(key);
      self.AAP_API.actorBreakdown(previous, [], { priority: "foreground" })
        .then((raw) => previousRowsCache.set(key, { rows: MODEL.normalizeRows(raw) }))
        .catch(() => previousRowsCache.set(key, { failedAt: Date.now() }))
        .finally(() => {
          previousRowsLoading.delete(key);
          if (lastInput) render(lastInput.data, lastInput.context, true);
        });
    }
    return null;
  }

  function sortValue(row, key) {
    if (key === "name") return row.title.toLowerCase();
    if (key === "users") return row.payingUsers * 1e6 + row.freeUsers;
    if (key === "runs") return row.failureRate ?? -Infinity;
    return row[key] ?? -Infinity;
  }

  function visibleRows(analysis) {
    const query = ui.query.trim().toLowerCase();
    const rows = analysis.rows.filter((row) => (
      (ui.segment === "all" || row.primary === ui.segment)
      && (!query || `${row.title} ${row.name}`.toLowerCase().includes(query))
    ));
    const sign = ui.direction === "asc" ? 1 : -1;
    const key = ui.sort === "auto" ? (ui.segment === "all" ? "revenue" : "impact") : ui.sort;
    return rows.sort((left, right) => {
      const a = sortValue(left, key);
      const b = sortValue(right, key);
      if (a < b) return -1 * sign;
      if (a > b) return 1 * sign;
      return right.revenue - left.revenue || left.title.localeCompare(right.title);
    });
  }

  function summaryTile(label, value, detail, tone = "neutral", title = "") {
    const tile = createElement("div", `aap-range-insight aap-range-insight-${tone}`);
    if (title) tile.title = title;
    tile.append(
      createElement("span", "aap-range-insight-label", label),
      createElement("strong", "aap-range-insight-value", value),
      createElement("span", "aap-range-insight-detail", detail),
    );
    return tile;
  }

  function renderSummary(analysis) {
    const { summary, thresholds } = analysis;
    const grid = createElement("div", "aap-range-insights-grid aap-portfolio-summary");
    const leader = summary.topThree[0];
    grid.append(
      summaryTile(
        "Revenue",
        money(summary.totalRevenue),
        `${money(summary.totalProfit)} profit · ${percent(summary.margin)} margin`,
      ),
      summaryTile(
        "Needs action",
        count(summary.actionCount),
        summary.actionCount ? `≈${money(summary.atRisk)} at stake` : "Nothing failing, declining, or losing money",
        summary.actionCount ? "bad" : "good",
        "Actors to fix, investigate, or reprice. The stake adds revenue at risk from failures, monthly revenue lost, and money lost to cost.",
      ),
      summaryTile(
        "Growing",
        count(summary.growingCount),
        thresholds.paceReady
          ? (summary.growingCount ? `+${money(summary.growingGain)}/mo pace` : "No material growth yet")
          : `Pace starts after ${thresholds.minPaceDays} days of the month`,
        summary.growingCount ? "good" : "neutral",
      ),
      summaryTile(
        "Profit concentration",
        percent(summary.topThreeShare),
        leader ? `Top 3 Actors · led by ${leader.title}` : "No profit in this range",
        summary.topThreeShare >= 0.6 ? "warning" : "neutral",
        "Share of profit from the three most profitable Actors. Above 60% means the business depends on very few Actors.",
      ),
    );
    return grid;
  }

  function renderTabs(analysis) {
    const tabs = createElement("div", "aap-portfolio-tabs");
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "Actor segments");
    for (const segment of [{ key: "all", label: "All" }, ...MODEL.SEGMENTS]) {
      const total = analysis.counts[segment.key] || 0;
      if (!total && segment.key !== "all" && ui.segment !== segment.key) continue;
      const button = createElement("button", "aap-portfolio-tab");
      button.type = "button";
      button.dataset.segment = segment.key;
      button.setAttribute("aria-pressed", String(ui.segment === segment.key));
      if (segment.action) button.title = segment.action;
      button.append(createElement("span", null, segment.label), createElement("span", "aap-portfolio-tab-count", count(total)));
      if (!total && segment.key !== "all") button.classList.add("aap-portfolio-tab-empty");
      tabs.appendChild(button);
    }
    return tabs;
  }

  const COLUMNS = [
    { key: "name", label: "Actor", align: "left" },
    { key: "revenue", label: "Revenue" },
    { key: "profit", label: "Profit" },
    { key: "users", label: "Users" },
    { key: "runs", label: "Runs" },
    { key: "results", label: "Results" },
  ];

  function renderHead() {
    const head = document.createElement("thead");
    const row = document.createElement("tr");
    for (const column of COLUMNS) {
      const cell = createElement("th", column.align === "left" ? "aap-portfolio-left" : null);
      const active = ui.sort === column.key || (ui.sort === "auto" && ui.segment === "all" && column.key === "revenue");
      cell.setAttribute("aria-sort", active ? (ui.direction === "asc" ? "ascending" : "descending") : "none");
      const button = createElement("button", "aap-portfolio-sort", column.label);
      button.type = "button";
      button.dataset.sort = column.key;
      if (active) button.appendChild(createElement("span", "aap-portfolio-sort-arrow", ui.direction === "asc" ? " ↑" : " ↓"));
      cell.appendChild(button);
      row.appendChild(cell);
    }
    head.appendChild(row);
    return head;
  }

  function cell(value, detail, className = "", detailTone = "") {
    const element = createElement("td", className);
    element.appendChild(createElement("strong", "aap-portfolio-value", value));
    if (detail) element.appendChild(createElement("span", `aap-portfolio-detail ${detailTone}`.trim(), detail));
    return element;
  }

  function paceText(pace) {
    if (!pace) return null;
    if (pace.change == null) return pace.latestPerDay > 0 ? { text: "first revenue", tone: "aap-portfolio-good" } : null;
    const change = Math.round(pace.change * 100);
    if (Math.abs(change) < 5) return { text: "→ steady", tone: "" };
    return {
      text: `${change > 0 ? "↑ +" : "↓ "}${change}% pace`,
      tone: change > 0 ? "aap-portfolio-good" : "aap-portfolio-bad",
    };
  }

  function renderRow(row) {
    const tr = document.createElement("tr");
    if (row.primary === "idle") tr.className = "aap-portfolio-row-idle";

    const actor = createElement("td", "aap-portfolio-actor aap-portfolio-left");
    const link = createElement("a", "aap-portfolio-actor-link");
    link.href = actorHref(row.id);
    if (row.pictureUrl) {
      const image = document.createElement("img");
      image.src = row.pictureUrl;
      image.alt = "";
      image.loading = "lazy";
      link.appendChild(image);
    } else {
      link.appendChild(createElement("span", "aap-portfolio-actor-placeholder"));
    }
    const text = createElement("span", "aap-portfolio-actor-text");
    text.appendChild(createElement("strong", null, row.title));
    const meta = [row.name];
    if (row.price) meta.push(`${money(row.price.priceUsd * 1000)} / 1K ${row.price.unit}`);
    text.appendChild(createElement("small", null, meta.filter(Boolean).join(" · ")));
    link.appendChild(text);
    actor.appendChild(link);
    if (row.signals.length) {
      const chips = createElement("span", "aap-portfolio-signals");
      for (const signal of row.signals.slice(0, 3)) {
        chips.appendChild(createElement(
          "span",
          `aap-portfolio-signal aap-portfolio-signal-${signal.tone}`,
          signal.detail ? `${signal.text} · ${signal.detail}` : signal.text,
        ));
      }
      actor.appendChild(chips);
    }

    const revenue = createElement("td", "aap-portfolio-revenue");
    revenue.appendChild(createElement("strong", "aap-portfolio-value", money(row.revenue)));
    const bar = createElement("span", "aap-portfolio-share");
    const fill = createElement("span", "aap-portfolio-share-fill");
    fill.style.width = `${Math.min(100, row.revenueShare * 100)}%`;
    bar.appendChild(fill);
    revenue.appendChild(bar);
    const pace = paceText(row.pace);
    const revenueDetail = createElement("span", "aap-portfolio-detail");
    revenueDetail.append(document.createTextNode(row.revenue > 0 ? `${percent(row.revenueShare, row.revenueShare < 0.01 ? 1 : 0)} of total` : "no revenue"));
    if (pace) {
      revenueDetail.append(document.createTextNode(" · "));
      revenueDetail.appendChild(createElement("span", pace.tone, pace.text));
    }
    revenue.appendChild(revenueDetail);

    const losing = row.profit < 0 && row.primary === "reprice";
    const profit = cell(
      money(row.profit),
      row.margin == null ? (row.cost > 0 ? `${money(row.cost)} cost` : "–") : `${percent(row.margin)} margin`,
      losing ? "aap-portfolio-negative" : "",
      losing ? "aap-portfolio-bad" : "",
    );

    const users = cell(
      `${count(row.payingUsers)} paying`,
      row.users ? `${count(row.freeUsers)} free · ${percent(row.payingShare)} pay` : "no users",
      "",
      row.primary === "untapped" ? "aap-portfolio-warning" : "",
    );

    const runs = cell(
      count(row.runs),
      !row.runs ? "no runs" : row.failures ? `${percent(row.failureRate, 1)} failed` : "no failures",
      "",
      row.primary === "fix" ? "aap-portfolio-bad" : "",
    );

    const results = cell(
      count(row.results),
      row.revenuePerThousand == null || row.revenue <= 0 ? null : `${money(row.revenuePerThousand)} / 1K earned`,
    );

    tr.append(actor, revenue, profit, users, runs, results);
    return tr;
  }

  function renderTable(analysis) {
    const rows = visibleRows(analysis);
    const shell = createElement("div", "aap-portfolio-table-shell");
    const scroll = createElement("div", "aap-portfolio-table-scroll");
    const table = createElement("table", "aap-portfolio-table");
    table.setAttribute("aria-label", "Actor portfolio");
    table.appendChild(renderHead());
    const body = document.createElement("tbody");
    for (const row of rows.slice(0, ui.limit)) body.appendChild(renderRow(row));
    if (!rows.length) {
      const empty = document.createElement("tr");
      const segment = MODEL.SEGMENTS.find((item) => item.key === ui.segment);
      const message = createElement("td", "aap-portfolio-empty", ui.query ? "No Actors match this search." : `No Actors in “${segment?.label || "this segment"}” right now.`);
      message.colSpan = COLUMNS.length;
      empty.appendChild(message);
      body.appendChild(empty);
    }
    table.appendChild(body);
    scroll.appendChild(table);
    shell.appendChild(scroll);

    const footer = createElement("div", "aap-portfolio-footer");
    footer.appendChild(createElement("span", null, `Showing ${count(Math.min(rows.length, ui.limit))} of ${count(rows.length)} Actors`));
    if (rows.length > ui.limit) {
      const more = createElement("button", "aap-portfolio-more", `Show all ${count(rows.length)}`);
      more.type = "button";
      more.dataset.action = "show-all";
      footer.appendChild(more);
    }
    return [shell, footer];
  }

  function renderLoading() {
    const placeholder = createElement("div", "aap-portfolio-loading");
    placeholder.setAttribute("aria-busy", "true");
    for (let index = 0; index < 6; index++) {
      const line = createElement("span", "aap-skeleton");
      line.style.setProperty("--aap-skeleton-width", `${index % 2 ? 72 : 100}%`);
      line.style.setProperty("--aap-skeleton-height", "18px");
      placeholder.appendChild(line);
    }
    return placeholder;
  }

  function onHostClick(event) {
    const tab = event.target.closest("[data-segment]");
    const sort = event.target.closest("[data-sort]");
    const action = event.target.closest("[data-action]");
    if (tab) {
      ui.segment = tab.dataset.segment;
      ui.sort = "auto";
      ui.direction = "desc";
      ui.limit = PAGE_SIZE;
    } else if (sort) {
      const key = sort.dataset.sort;
      // On "All", the automatic sort is revenue, so clicking Revenue flips it.
      const isCurrentSort = ui.sort === key || (ui.sort === "auto" && ui.segment === "all" && key === "revenue");
      if (isCurrentSort) ui.direction = ui.direction === "asc" ? "desc" : "asc";
      else {
        ui.sort = key;
        ui.direction = key === "name" ? "asc" : "desc";
      }
    } else if (action?.dataset.action === "show-all") {
      ui.limit = Infinity;
    } else {
      return;
    }
    renderBody();
  }

  function ensureHost() {
    const native = nativeTableWrapper();
    if (!native?.parentElement) return null;
    if (!host) {
      host = createElement("section", HOST_CLASS);
      host.setAttribute("aria-label", "Actor portfolio");
      host.addEventListener("click", onHostClick);
      const header = createElement("div", "aap-portfolio-header");
      const heading = createElement("div", "aap-portfolio-heading");
      heading.append(createElement("h3", null, "Actor portfolio"), createElement("p", "aap-portfolio-caption"));
      const search = document.createElement("input");
      search.type = "search";
      search.className = "aap-portfolio-search";
      search.placeholder = "Filter Actors";
      search.setAttribute("aria-label", "Filter Actors");
      search.addEventListener("input", () => {
        ui.query = search.value;
        ui.limit = PAGE_SIZE;
        renderBody();
      });
      header.append(heading, search);
      host.append(header, createElement("div", "aap-portfolio-body"));
    }
    if (host.nextElementSibling !== native) native.parentElement.insertBefore(host, native);
    document.documentElement.classList.add(ACTIVE_CLASS);
    return host;
  }

  function renderBody() {
    if (!host) return;
    const body = host.querySelector(".aap-portfolio-body");
    if (!lastAnalysis) {
      // Keep the running shimmer instead of rebuilding it on every poll.
      if (!body.querySelector(".aap-portfolio-loading")) body.replaceChildren(renderLoading());
      return;
    }
    const segment = MODEL.SEGMENTS.find((item) => item.key === ui.segment);
    const note = createElement("div", "aap-portfolio-segment-note");
    if (segment) {
      note.append(
        createElement("strong", null, segment.action),
        createElement("span", null, ` Rule: ${segment.rule(lastAnalysis.thresholds)}`),
      );
    } else {
      note.textContent = "Every Actor appears in exactly one segment, checked in this order: fix, declining, reprice, growing, core, untapped, long tail, idle. Hover a segment for its action.";
    }
    body.replaceChildren(renderSummary(lastAnalysis), renderTabs(lastAnalysis), note, ...renderTable(lastAnalysis));
  }

  function render(data, context = {}, force = false) {
    if (!MODEL || !ensureHost()) return;
    const rowsByMonth = data?.actorBreakdownRows || null;
    const previousRows = rowsByMonth ? previousRowsFor(data, rowsByMonth) : null;
    if (!force && lastInput && lastInput.data === data && lastInput.previousRows === previousRows) return;
    lastInput = { data, context, previousRows };
    lastAnalysis = rowsByMonth ? MODEL.analyze({ rowsByMonth, previousRows }) : null;

    const caption = host.querySelector(".aap-portfolio-caption");
    if (lastAnalysis) {
      const months = lastAnalysis.months;
      const period = months.length > 1 ? `${monthLabel(months[0])} – ${monthLabel(months[months.length - 1])}` : monthLabel(months[0]);
      const { thresholds } = lastAnalysis;
      const pace = !lastAnalysis.comparisonMonth
        ? ""
        : thresholds.paceReady
          ? ` Pace compares revenue per day in ${monthLabel(lastAnalysis.latestMonth)} with ${monthLabel(lastAnalysis.comparisonMonth)}.`
          : ` Pace starts after ${thresholds.minPaceDays} days of ${monthLabel(lastAnalysis.latestMonth)}.`;
      caption.textContent = `Monthly totals for ${period}. Changes under ${money(thresholds.materiality)}/month are treated as noise.${pace}`;
    } else {
      caption.textContent = "Loading Actor performance…";
    }
    renderBody();
  }

  function remove() {
    host?.remove();
    host = null;
    lastInput = null;
    lastAnalysis = null;
    document.documentElement.classList.remove(ACTIVE_CLASS);
  }

  self.AAP_PORTFOLIO = { render, remove };
})();
