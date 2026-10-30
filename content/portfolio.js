/*
 * Actor portfolio: replaces Apify's alphabetical per-Actor table on the
 * Monetization page (Plus view only) with a revenue-ranked table. Each Actor
 * has a group (how much it matters) and actions (what to do), and Actors
 * whose group or actions changed since an earlier day are marked. range.js
 * owns the data and calls render()/remove(); the analysis lives in
 * lib/portfolio.js.
 */
(function () {
  const HOST_CLASS = "aap-portfolio";
  const ACTIVE_CLASS = "aap-portfolio-active";
  const PAGE_SIZE = 25;
  const PREVIOUS_RETRY_MS = 60 * 1000;
  // Each range's classification is remembered per day so the table can say
  // what changed since an earlier day. Only the most recently used ranges
  // are kept.
  const SNAPSHOT_KEY = "aap.portfolio.snapshots";
  const SNAPSHOT_SCOPES = 12;
  const PACE_ACTIONS = ["declining", "growing"];
  const MODEL = self.AAP_PORTFOLIO_MODEL;

  const ui = {
    group: "all",
    // An action key, "changed", or null for any.
    action: null,
    // "auto" sorts by what the filter is about: an action by its dollar
    // impact, core earners by profit, everything else by revenue.
    sort: "auto",
    direction: "desc",
    query: "",
    page: 0,
  };
  let host = null;
  let lastInput = null;
  let lastAnalysis = null;
  // { [scope]: { latest, baseline, usedAt } } once read from storage.
  let snapshots = null;
  let snapshotsRead = false;
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

  function dayLabel(day) {
    return day ? AAPR.formatDate(day, { month: "short", day: "numeric" }) : "";
  }

  const groupOf = (key) => MODEL.GROUPS.find((group) => group.key === key);
  const actionOf = (key) => MODEL.ACTIONS.find((action) => action.key === key);

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
  // `loading` says pace is still on its way, as opposed to unavailable.
  function previousRowsFor(data, rowsByMonth) {
    const none = { rows: null, loading: false };
    const months = Object.keys(rowsByMonth).sort();
    const latest = months[months.length - 1];
    if (!latest) return none;
    const previous = MODEL.previousMonthKey(latest);
    if (rowsByMonth[previous]) return none;
    // rangeData fetches the previous month in the same batch as the range.
    if (data?.previousBreakdownRows?.month === previous) return { rows: data.previousBreakdownRows.rows, loading: false };
    const key = scopeKey(previous);
    const cached = previousRowsCache.get(key);
    if (cached?.rows) return { rows: cached.rows, loading: false };
    // A failed fetch is retried after a minute instead of disabling pace.
    if (cached && Date.now() - cached.failedAt < PREVIOUS_RETRY_MS) return none;
    if (!self.AAP_API?.actorBreakdown) return none;
    if (!previousRowsLoading.has(key)) {
      previousRowsLoading.add(key);
      self.AAP_API.actorBreakdown(previous, [], { priority: "foreground" })
        .then((raw) => previousRowsCache.set(key, { rows: MODEL.normalizeRows(raw) }))
        .catch(() => previousRowsCache.set(key, { failedAt: Date.now() }))
        .finally(() => {
          previousRowsLoading.delete(key);
          if (lastInput) render(lastInput.data, lastInput.context, true);
        });
    }
    return { rows: null, loading: true };
  }

  // Snapshots are read once per page; the table waits for them so an Actor
  // is never first shown without the tags it holds and then moved.
  function readSnapshots() {
    if (snapshotsRead) return;
    snapshotsRead = true;
    Promise.resolve()
      .then(() => chrome.storage.local.get(SNAPSHOT_KEY))
      .then((result) => result?.[SNAPSHOT_KEY])
      .catch(() => null)
      .then((value) => {
        snapshots = value && typeof value === "object" ? value : {};
        if (lastInput) render(lastInput.data, lastInput.context, true);
      });
  }

  function saveSnapshot(scope, entry) {
    const next = { ...snapshots, [scope]: entry };
    snapshots = Object.fromEntries(Object.entries(next)
      .sort((left, right) => (right[1]?.usedAt || 0) - (left[1]?.usedAt || 0))
      .slice(0, SNAPSHOT_SCOPES));
    try {
      chrome.storage.local.set({ [SNAPSHOT_KEY]: snapshots })?.catch?.(() => {});
    } catch {
      // Remembering is a convenience; the table works without it.
    }
  }

  // Today's date where the user is, so "since yesterday" follows their day.
  function localDay(now = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  // Classify with what this range had last time (so tags hold until clearly
  // past their line), mark what changed since an earlier day, and remember
  // today's result. A classification still waiting for pace is not saved.
  function classify(rowsByMonth, previous) {
    const months = Object.keys(rowsByMonth).sort();
    const scope = `${self.AAP_CONTEXT?.decisionScope?.() || "personal"}|${months[0] || ""}|${months[months.length - 1] || ""}`;
    const entry = snapshots[scope] || {};
    const today = localDay();
    const baseline = entry.latest && entry.latest.day !== today ? entry.latest : entry.baseline || null;
    const analysis = MODEL.analyze({
      rowsByMonth,
      previousRows: previous.rows,
      paceLoading: previous.loading,
      sticky: entry.latest || null,
    });
    MODEL.compareSnapshot(analysis, baseline);
    if (!analysis.thresholds.paceLoading) {
      const latest = MODEL.snapshot(analysis, today);
      if (baseline !== entry.baseline || JSON.stringify(latest) !== JSON.stringify(entry.latest)) {
        saveSnapshot(scope, { latest, baseline, usedAt: Date.now() });
      }
    }
    return analysis;
  }

  function matches(row, group = ui.group, action = ui.action) {
    if (group !== "all" && row.group !== group) return false;
    if (action === "changed") return !!row.change;
    return !action || MODEL.hasAction(row, action);
  }

  // The column the automatic sort uses, or "impact" for the selected action.
  function autoSortKey() {
    if (actionOf(ui.action)) return "impact";
    return ui.group === "core" && !ui.action ? "profit" : "revenue";
  }

  function sortValue(row, key) {
    if (key === "name") return row.title.toLowerCase();
    if (key === "users") return row.payingUsers * 1e6 + row.freeUsers;
    if (key === "impact") return row.actions.find((item) => item.key === ui.action)?.impact ?? -Infinity;
    return row[key] ?? -Infinity;
  }

  function visibleRows(analysis) {
    const query = ui.query.trim().toLowerCase();
    const rows = analysis.rows.filter((row) => (
      matches(row)
      && (!query || `${row.title} ${row.name}`.toLowerCase().includes(query))
    ));
    const sign = ui.direction === "asc" ? 1 : -1;
    const key = ui.sort === "auto" ? autoSortKey() : ui.sort;
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
        thresholds.paceLoading
          ? "Checking trends…"
          : thresholds.paceReady
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

  function filterChip(kind, key, label, total, { pressed = false, tone = null, title = "", pending = false } = {}) {
    const button = createElement("button", "aap-portfolio-tab");
    button.type = "button";
    button.dataset[kind] = key;
    button.setAttribute("aria-pressed", String(pressed));
    if (title) button.title = title;
    if (tone) button.appendChild(createElement("span", `aap-portfolio-tab-dot aap-portfolio-tab-dot-${tone}`));
    button.append(createElement("span", null, label), createElement("span", "aap-portfolio-tab-count", pending ? "…" : count(total)));
    if (pending) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    } else if (!total && !pressed) {
      button.classList.add("aap-portfolio-tab-empty");
    }
    return button;
  }

  function filterRow(label, className, { visibleLabel = false } = {}) {
    const row = createElement("div", `aap-portfolio-filter-row ${className}`);
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", label);
    if (visibleLabel) row.appendChild(createElement("span", "aap-portfolio-filter-label", label));
    const chips = createElement("div", "aap-portfolio-tabs");
    row.appendChild(chips);
    return { row, chips };
  }

  // Two filters that combine on one line: a segmented control for the group
  // (exactly one applies) and toggle chips for the action an Actor needs. Each
  // count is the Actors it would show with the other filter kept, and every
  // chip stays in place (empty ones dim) so the line does not shift.
  function renderFilters(analysis) {
    const filters = createElement("div", "aap-portfolio-filters");
    const tally = (group, action) => analysis.rows.filter((row) => matches(row, group, action)).length;
    const groups = filterRow("Group", "aap-portfolio-segmented");
    groups.chips.appendChild(filterChip("group", "all", "All", tally("all", ui.action), { pressed: ui.group === "all" }));
    for (const group of MODEL.GROUPS) {
      groups.chips.appendChild(filterChip("group", group.key, group.label, tally(group.key, ui.action), {
        pressed: ui.group === group.key,
        title: group.action,
      }));
    }
    const actions = filterRow("Needs action", "aap-portfolio-action-filters", { visibleLabel: true });
    const { paceLoading } = analysis.thresholds;
    for (const action of MODEL.ACTIONS) {
      const pending = paceLoading && PACE_ACTIONS.includes(action.key);
      actions.chips.appendChild(filterChip("action", action.key, action.label, tally(ui.group, action.key), {
        pressed: ui.action === action.key,
        tone: action.tone,
        title: pending ? `Checking trends against ${monthLabel(MODEL.previousMonthKey(analysis.latestMonth))}…` : action.action,
        pending,
      }));
    }
    if (analysis.changes) {
      actions.chips.appendChild(createElement("span", "aap-portfolio-filter-sep"));
      actions.chips.appendChild(filterChip("action", "changed", `Changed since ${dayLabel(analysis.changes.since)}`, tally(ui.group, "changed"), {
        pressed: ui.action === "changed",
        tone: "accent",
        title: `Actors whose group or actions are different from ${dayLabel(analysis.changes.since)}.`,
      }));
    }
    filters.append(groups.row, actions.row);
    return filters;
  }

  function renderNote(analysis) {
    const note = createElement("div", "aap-portfolio-segment-note");
    const action = actionOf(ui.action);
    const group = groupOf(ui.group);
    const explain = (item) => note.append(
      createElement("strong", null, item.action),
      createElement("span", null, ` Rule: ${item.rule(analysis.thresholds)}`),
    );
    if (ui.action === "changed" && analysis.changes) {
      note.append(
        createElement("strong", null, `What moved since ${dayLabel(analysis.changes.since)}.`),
        createElement("span", null, " An Actor is listed when its group changed or it gained or lost an action. Growing and Declining are compared only when both days had a month to compare against."),
      );
    } else if (action) {
      explain(action);
    } else if (group) {
      explain(group);
    } else {
      return null;
    }
    return note;
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
      const active = ui.sort === column.key || (ui.sort === "auto" && autoSortKey() === column.key);
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
      text: `${change > 0 ? "↑ +" : "↓ −"}${Math.abs(change)}% pace`,
      tone: change > 0 ? "aap-portfolio-good" : "aap-portfolio-bad",
    };
  }

  // "Since Oct 29: Long tail → Core earners · now Growing · no longer Declining".
  function changeText(row, since) {
    const { change } = row;
    const labels = (keys) => keys.map((key) => actionOf(key)?.label || key).join(", ");
    const parts = [];
    if (change.group) parts.push(`${groupOf(change.group)?.label || change.group} → ${groupOf(row.group)?.label || row.group}`);
    if (change.added.length) parts.push(`now ${labels(change.added)}`);
    if (change.removed.length) parts.push(`no longer ${labels(change.removed)}`);
    return `Since ${dayLabel(since)}: ${parts.join(" · ")}`;
  }

  function renderRow(row, analysis) {
    const tr = document.createElement("tr");
    if (row.group === "idle") tr.className = "aap-portfolio-row-idle";

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
    // One line under the name: action tags (label plus the number behind it;
    // the money impact and rule are in the tooltip), then context as text.
    if (row.actions.length || row.notes.length) {
      const chips = createElement("span", "aap-portfolio-signals");
      for (const item of row.actions) {
        const action = actionOf(item.key);
        const tag = createElement("span", `aap-portfolio-signal aap-portfolio-signal-${action.tone}`);
        tag.append(createElement("strong", null, action.label));
        if (item.text) tag.append(createElement("span", null, item.text));
        tag.title = `${item.detail ? `${item.detail}. ` : ""}${action.action} Rule: ${action.rule(analysis.thresholds)}`;
        chips.appendChild(tag);
      }
      if (row.notes.length) {
        const notes = createElement("span", "aap-portfolio-signal-notes");
        row.notes.forEach((note, index) => {
          if (index) notes.append(document.createTextNode(" · "));
          notes.appendChild(createElement("span", `aap-portfolio-note-${note.tone}`, note.text));
        });
        chips.appendChild(notes);
      }
      actor.appendChild(chips);
    }
    if (row.change && analysis.changes) {
      actor.appendChild(createElement("span", "aap-portfolio-change", changeText(row, analysis.changes.since)));
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

    const losing = row.profit < 0 && MODEL.hasAction(row, "reprice");
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
      MODEL.hasAction(row, "untapped") ? "aap-portfolio-warning" : "",
    );

    const runs = cell(
      count(row.runs),
      !row.runs ? "no runs" : row.failures ? `${percent(row.failureRate, 1)} failed` : "no failures",
      "",
      MODEL.hasAction(row, "fix") ? "aap-portfolio-bad" : "",
    );

    const results = cell(
      count(row.results),
      row.revenuePerThousand == null || row.revenue <= 0 ? null : `${money(row.revenuePerThousand)} / 1K earned`,
    );

    tr.append(actor, revenue, profit, users, runs, results);
    return tr;
  }

  function pageButton(label, page, { current = false, disabled = false, ariaLabel = "" } = {}) {
    const button = createElement("button", "aap-portfolio-page", label);
    button.type = "button";
    button.dataset.page = String(page);
    if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
    if (current) button.setAttribute("aria-current", "page");
    button.disabled = disabled;
    return button;
  }

  function renderPager(page, pageCount) {
    const pager = createElement("nav", "aap-portfolio-pager");
    pager.setAttribute("aria-label", "Actor pages");
    pager.appendChild(pageButton("‹ Prev", page - 1, { disabled: page === 0, ariaLabel: "Previous page" }));
    for (const index of MODEL.pageButtons(page, pageCount)) {
      if (index == null) pager.appendChild(createElement("span", "aap-portfolio-page-gap", "…"));
      else pager.appendChild(pageButton(count(index + 1), index, { current: index === page, ariaLabel: `Page ${index + 1}` }));
    }
    pager.appendChild(pageButton("Next ›", page + 1, { disabled: page === pageCount - 1, ariaLabel: "Next page" }));
    return pager;
  }

  function renderTable(analysis) {
    const rows = visibleRows(analysis);
    const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    // A rescan can shrink the list under the page being read.
    ui.page = Math.min(ui.page, pageCount - 1);
    const first = ui.page * PAGE_SIZE;
    const shell = createElement("div", "aap-portfolio-table-shell");
    const scroll = createElement("div", "aap-portfolio-table-scroll");
    const table = createElement("table", "aap-portfolio-table");
    table.setAttribute("aria-label", "Actor portfolio");
    table.appendChild(renderHead());
    const body = document.createElement("tbody");
    for (const row of rows.slice(first, first + PAGE_SIZE)) body.appendChild(renderRow(row, analysis));
    if (!rows.length) {
      const empty = document.createElement("tr");
      const filters = [groupOf(ui.group)?.label, actionOf(ui.action)?.label].filter(Boolean).map((label) => `“${label}”`).join(" with ");
      const message = createElement("td", "aap-portfolio-empty", ui.query
        ? "No Actors match this search."
        : ui.action === "changed"
          ? `Nothing changed since ${dayLabel(analysis.changes?.since)}${groupOf(ui.group) ? ` in “${groupOf(ui.group).label}”` : ""}.`
          : `No Actors in ${filters || "this view"} right now.`);
      message.colSpan = COLUMNS.length;
      empty.appendChild(message);
      body.appendChild(empty);
    }
    table.appendChild(body);
    scroll.appendChild(table);
    shell.appendChild(scroll);

    const footer = createElement("div", "aap-portfolio-footer");
    const range = createElement(
      "span",
      null,
      rows.length ? `Showing ${count(first + 1)}–${count(Math.min(rows.length, first + PAGE_SIZE))} of ${count(rows.length)} Actors` : "No Actors",
    );
    range.setAttribute("aria-live", "polite");
    footer.appendChild(range);
    if (pageCount > 1) footer.appendChild(renderPager(ui.page, pageCount));
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
    const group = event.target.closest("[data-group]");
    const action = event.target.closest("[data-action]");
    const sort = event.target.closest("[data-sort]");
    const page = event.target.closest("[data-page]");
    if (group || action) {
      if (group) ui.group = group.dataset.group;
      // Clicking the selected action again shows every action.
      else ui.action = ui.action === action.dataset.action ? null : action.dataset.action;
      ui.sort = "auto";
      ui.direction = "desc";
      ui.page = 0;
    } else if (sort) {
      const key = sort.dataset.sort;
      // The automatic sort's column flips when clicked.
      const isCurrentSort = ui.sort === key || (ui.sort === "auto" && autoSortKey() === key);
      if (isCurrentSort) ui.direction = ui.direction === "asc" ? "desc" : "asc";
      else {
        ui.sort = key;
        ui.direction = key === "name" ? "asc" : "desc";
      }
      ui.page = 0;
    } else if (page && !page.disabled) {
      ui.page = Number(page.dataset.page);
      renderBody();
      // Start the new page at its first row when the table top is scrolled away.
      const table = host.querySelector(".aap-portfolio-table-shell");
      if (table && table.getBoundingClientRect().top < 0) table.scrollIntoView({ block: "start" });
      host.querySelector(".aap-portfolio-page[aria-current]")?.focus({ preventScroll: true });
      return;
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
        ui.page = 0;
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
    // "Changed" goes away when there is nothing to compare against.
    if (ui.action === "changed" && !lastAnalysis.changes) ui.action = null;
    body.replaceChildren(...[renderSummary(lastAnalysis), renderFilters(lastAnalysis), renderNote(lastAnalysis), ...renderTable(lastAnalysis)].filter(Boolean));
  }

  function render(data, context = {}, force = false) {
    // Switched off in the popup: the Console's own table stays.
    if (!(self.AAP_FEATURES?.enabled("portfolio") ?? true)) {
      if (host) remove();
      return;
    }
    if (!MODEL || !ensureHost()) return;
    readSnapshots();
    const rowsByMonth = data?.actorBreakdownRows || null;
    const previous = rowsByMonth ? previousRowsFor(data, rowsByMonth) : { rows: null, loading: false };
    if (!force && lastInput && lastInput.data === data && lastInput.previousRows === previous.rows) return;
    lastInput = { data, context, previousRows: previous.rows };
    lastAnalysis = rowsByMonth && snapshots ? classify(rowsByMonth, previous) : null;

    const caption = host.querySelector(".aap-portfolio-caption");
    if (lastAnalysis) {
      const months = lastAnalysis.months;
      const period = months.length > 1 ? `${monthLabel(months[0])} – ${monthLabel(months[months.length - 1])}` : monthLabel(months[0]);
      const { thresholds } = lastAnalysis;
      const pace = thresholds.paceLoading
        ? ` Checking trends against ${monthLabel(MODEL.previousMonthKey(lastAnalysis.latestMonth))}…`
        : !lastAnalysis.comparisonMonth
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
