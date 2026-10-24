/*
 * Render helpers for the Actor quality inbox. Stateless: content/quality.js
 * owns the mount point, scan, and state, and calls renderInbox() with the
 * model output plus action handlers.
 *
 * Layout is a two-pane inbox: a ranked list of issues on the left (one entry
 * per suggestion type, e.g. "Fix Actor health issues · 68 Actors") and the
 * selected issue with its Actors on the right, so each suggestion's text is
 * read once and the Actors it applies to are compared side by side.
 */
(function () {
  const ACTOR_PREVIEW = 12;
  const LEVEL_LABELS = { high: "High impact", medium: "Medium impact", low: "Low impact" };
  const GROUP_HINTS = {
    security: "Protect your users' secrets: mark sensitive inputs as secret and keep permissions minimal.",
    ops: "Reliability problems cost you users and lower the Actor's Store ranking.",
    schema: "Schemas make the Actor easier to use from the Console, the API, and AI agents.",
    pricing: "A configuration gap in pay-per-event pricing, not a price change.",
    listing: "A quick Store listing fix. Best batched across Actors in one sitting.",
    other: "A suggestion type this extension does not classify yet.",
    market: "Depends on the market more than on code. Act on it after the fixes.",
  };

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function button(label, className, onClick, ariaLabel, title) {
    const element = createElement("button", className, label);
    element.type = "button";
    if (ariaLabel) element.setAttribute("aria-label", ariaLabel);
    if (title) element.title = title;
    element.addEventListener("click", onClick);
    return element;
  }

  function plainText(value) {
    if (!value) return "";
    const parsed = new DOMParser().parseFromString(String(value), "text/html");
    return parsed.body.textContent.replace(/\s+/g, " ").trim();
  }

  const { count, plural } = self.AAPF;

  function formatScore(value) {
    return value == null ? "–" : `${(value * 100).toFixed(1)}%`;
  }

  function formatPercentile(value) {
    const rank = Math.round(value * 100);
    const suffix = rank % 100 >= 11 && rank % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[rank % 10] || "th";
    return `${rank}${suffix} pct`;
  }

  function formatMoney(value) {
    if (!value) return "$0";
    return value >= 100 ? `$${Math.round(value).toLocaleString("en-US")}` : `$${value.toFixed(2)}`;
  }

  function relativeTime(timestamp, now) {
    if (!timestamp) return "never";
    const minutes = Math.round((now - timestamp) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.round(hours / 24)} days ago`;
  }

  function shortDate(timestamp) {
    return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function signal(text, tone, title) {
    const element = createElement("span", `aap-portfolio-signal aap-portfolio-signal-${tone}`, text);
    if (title) element.title = title;
    return element;
  }

  // Resolves the selected entry: an issue key, "changes", or "hidden". Falls
  // back to the highest-impact issue when the selection no longer exists.
  function resolveSelection(input) {
    const { inbox, selection } = input;
    if (selection === "changes" && input.movements.length) return "changes";
    if (selection === "hidden" && inbox.counts.dismissed + inbox.counts.snoozed) return "hidden";
    if (inbox.issues.some((issue) => issue.key === selection)) return selection;
    return inbox.issues.find((issue) => !issue.hidden)?.key || inbox.issues[0]?.key || (input.movements.length ? "changes" : null);
  }

  // ---- Summary ---------------------------------------------------------------

  function tile(label, value, detail, tone = "neutral", title = "") {
    const element = createElement("div", `aap-range-insight aap-range-insight-${tone}`);
    if (title) element.title = title;
    element.append(
      createElement("span", "aap-range-insight-label", label),
      createElement("strong", "aap-range-insight-value", value),
      createElement("span", "aap-range-insight-detail", detail),
    );
    return element;
  }

  // Only numbers worth reading: zero-value counters stay out of the strip.
  function summary(input) {
    const { inbox } = input;
    const actionable = inbox.issues.filter((issue) => !issue.hidden);
    const suggestions = actionable.reduce((sum, issue) => sum + issue.items.length, 0);
    const high = actionable.reduce((sum, issue) => sum + issue.highCount, 0);
    const grid = createElement("div", "aap-range-insights-grid");
    grid.append(
      tile(
        "Actors to fix",
        count(inbox.actorsToFix),
        inbox.actorsToFix ? `of ${count(input.scannedCount)} · ${plural(suggestions, "suggestion", "suggestions")}` : "Nothing to fix right now",
        inbox.actorsToFix ? "bad" : "good",
        "Actors with at least one open suggestion you can act on. Market suggestions (rating, user growth) are not counted.",
      ),
      tile(
        "High impact",
        count(high),
        high ? "on your busiest Actors" : "No urgent suggestions",
        high ? "warning" : "good",
        "The top fifth of open suggestions by impact: suggestion weight times the Actor's revenue, runs, and users.",
      ),
      tile(
        "Average quality",
        input.averageQuality == null ? "–" : formatScore(input.averageQuality),
        "across scanned Actors",
      ),
    );
    if (inbox.counts.new) grid.appendChild(tile("New this week", count(inbox.counts.new), "suggestions Apify just added", "warning"));
    if (inbox.counts.fixing) grid.appendChild(tile("Awaiting rescore", count(inbox.counts.fixing), "clear when Apify rescores", "neutral", "Apify recalculates quality scores on its own schedule."));
    const wrap = createElement("div", "aap-range-insights aap-quality-inbox-summary");
    wrap.appendChild(grid);
    return wrap;
  }

  // ---- Issue list (left pane) -----------------------------------------------

  function listEntry({ key, title, meta, total, groupKey, share, selected, muted }, handlers) {
    const entry = createElement("button", "aap-quality-inbox-entry");
    entry.type = "button";
    entry.dataset.selection = key;
    if (groupKey) entry.dataset.group = groupKey;
    if (muted) entry.classList.add("aap-quality-inbox-entry-muted");
    entry.setAttribute("aria-pressed", String(selected));
    const head = createElement("span", "aap-quality-inbox-entry-head");
    head.append(createElement("span", "aap-quality-inbox-dot"), createElement("span", "aap-quality-inbox-entry-title", title), createElement("span", "aap-quality-inbox-entry-count", count(total)));
    entry.appendChild(head);
    if (meta) entry.appendChild(createElement("span", "aap-quality-inbox-entry-meta", meta));
    if (share != null) {
      const bar = createElement("span", "aap-quality-inbox-entry-bar");
      const fill = createElement("span");
      fill.style.width = `${Math.max(4, Math.round(share * 100))}%`;
      bar.appendChild(fill);
      entry.appendChild(bar);
    }
    entry.addEventListener("click", () => handlers.onSelect(key));
    return entry;
  }

  function issueList(input, selection, handlers) {
    const { inbox } = input;
    const nav = createElement("nav", "aap-quality-inbox-list");
    nav.setAttribute("aria-label", "Issues");
    const actionable = inbox.issues.filter((issue) => !issue.hidden);
    const market = inbox.issues.filter((issue) => issue.hidden);
    const maxImpact = Math.max(1, ...actionable.map((issue) => issue.impact));
    const section = (label, entries) => {
      if (!entries.length) return;
      nav.appendChild(createElement("span", "aap-quality-inbox-list-label", label));
      nav.append(...entries);
    };
    const issueEntry = (issue, muted, max) => listEntry({
      key: issue.key,
      title: issue.title,
      meta: [issue.groupLabel, issue.highCount ? `${count(issue.highCount)} high impact` : null, issue.newCount ? `${count(issue.newCount)} new` : null].filter(Boolean).join(" · "),
      total: issue.items.length,
      groupKey: issue.groupKey,
      share: issue.impact / max,
      selected: selection === issue.key,
      muted,
    }, handlers);
    section("Fix first", actionable.map((issue) => issueEntry(issue, false, maxImpact)));
    const marketMax = Math.max(1, ...market.map((issue) => issue.impact));
    section("Market", market.map((issue) => issueEntry(issue, true, marketMax)));
    const review = [];
    if (input.movements.length) {
      review.push(listEntry({ key: "changes", title: "Score changes", meta: input.previousCapturedAt ? `since ${shortDate(input.previousCapturedAt)}` : null, total: input.movements.length, selected: selection === "changes" }, handlers));
    }
    const hiddenCount = inbox.counts.dismissed + inbox.counts.snoozed;
    if (hiddenCount) review.push(listEntry({ key: "hidden", title: "Dismissed & snoozed", total: hiddenCount, selected: selection === "hidden", muted: true }, handlers));
    section("Review", review);
    return nav;
  }

  // ---- Detail (right pane) ----------------------------------------------------

  function actorCell(actor, href, signals) {
    const cell = createElement("td", "aap-portfolio-actor aap-portfolio-left");
    const link = createElement("a", "aap-portfolio-actor-link");
    link.href = href;
    link.title = "Open Apify's quality page for this Actor";
    if (actor.pictureUrl) {
      const image = document.createElement("img");
      image.src = actor.pictureUrl;
      image.alt = "";
      image.loading = "lazy";
      link.appendChild(image);
    } else {
      link.appendChild(createElement("span", "aap-portfolio-actor-placeholder"));
    }
    const text = createElement("span", "aap-portfolio-actor-text");
    text.append(createElement("strong", null, actor.title), createElement("small", null, actor.name));
    link.appendChild(text);
    cell.appendChild(link);
    if (signals.length) {
      const chips = createElement("span", "aap-portfolio-signals");
      chips.append(...signals);
      cell.appendChild(chips);
    }
    return cell;
  }

  function valueCell(value, detail, className = "") {
    const cell = createElement("td", className);
    cell.appendChild(createElement("strong", "aap-portfolio-value", value));
    if (detail) cell.appendChild(createElement("span", "aap-portfolio-detail", detail));
    return cell;
  }

  // Impact as a bar scaled to the largest in this list, so lengths compare
  // Actors directly; the level is in the label for screen readers.
  function impactCell(item, max) {
    const cell = createElement("td", `aap-quality-inbox-impact aap-quality-inbox-impact-${item.level}`);
    const bar = createElement("span", "aap-quality-inbox-impact-bar");
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", LEVEL_LABELS[item.level] || LEVEL_LABELS.low);
    bar.title = LEVEL_LABELS[item.level] || LEVEL_LABELS.low;
    const fill = createElement("span");
    fill.style.width = `${Math.max(3, Math.round((item.impact / max) * 100))}%`;
    bar.appendChild(fill);
    cell.appendChild(bar);
    return cell;
  }

  function actionsCell(item, handlers) {
    const cell = createElement("td", "aap-quality-inbox-actions");
    const subject = `${item.improvement.title} for ${item.actor.title}`;
    const act = (action) => () => handlers.onAction(item.actor.id, item.improvement.id, action);
    if (item.state === "dismissed" || item.state === "snoozed") {
      cell.appendChild(button("Restore", "aap-quality-inbox-action", act("reopen"), `Restore ${subject}`));
      return cell;
    }
    if (item.state === "fixing") cell.appendChild(button("Not fixed", "aap-quality-inbox-action", act("reopen"), `Unmark ${subject} as fixing`, "Move it back to the open list"));
    else cell.appendChild(button("Mark fixing", "aap-quality-inbox-action", act("fix"), `Mark ${subject} as fixing`, "Keep it visible as fixing until Apify rescores the Actor"));
    cell.appendChild(button("Snooze", "aap-quality-inbox-action", act("snooze"), `Snooze ${subject} for 7 days`, "Hide for 7 days"));
    cell.appendChild(button("Dismiss", "aap-quality-inbox-action", act("dismiss"), `Dismiss ${subject}`, "Hide until it clears and comes back"));
    return cell;
  }

  function itemRow(item, input, handlers, max, showSuggestion) {
    const row = document.createElement("tr");
    row.dataset.actorId = item.actor.id;
    if (input.highlightActor === item.actor.id) row.classList.add("aap-quality-inbox-highlight");
    const signals = [];
    if (showSuggestion) signals.push(signal(item.improvement.title, "neutral"));
    if (item.isNew) signals.push(signal("New", "warning", "Apify added this suggestion in the last 7 days"));
    if (item.state === "fixing") signals.push(signal("Fixing · awaiting rescore", "good"));
    if (item.state === "snoozed") signals.push(signal("Snoozed", "neutral"));
    if (item.state === "dismissed") signals.push(signal("Dismissed", "neutral"));
    const revenue = input.revenueFor(item.actor);
    const runs = input.runsFor(item.actor);
    const percentile = item.entry?.scores?.actorQualityPercentile;
    row.append(
      actorCell(item.actor, input.actorHref(item.actor), signals),
      valueCell(formatScore(item.entry?.scores?.actorQuality ?? null), percentile != null ? formatPercentile(percentile) : ""),
      valueCell(revenue.basis ? formatMoney(revenue.value) : "–", revenue.basis || "no revenue"),
      valueCell(runs ? count(runs) : "–", "this month"),
      impactCell(item, max),
      actionsCell(item, handlers),
    );
    return row;
  }

  function table(columns, className) {
    const shell = createElement("div", "aap-portfolio-table-shell");
    const scroll = createElement("div", "aap-portfolio-table-scroll");
    const element = createElement("table", `aap-portfolio-table ${className}`);
    const head = document.createElement("thead");
    const row = document.createElement("tr");
    for (const [label, align, title] of columns) {
      const header = createElement("th", align === "left" ? "aap-portfolio-left" : null, label);
      header.scope = "col";
      if (title) header.title = title;
      row.appendChild(header);
    }
    head.appendChild(row);
    element.appendChild(head);
    const body = document.createElement("tbody");
    element.appendChild(body);
    scroll.appendChild(element);
    shell.appendChild(scroll);
    return { shell, body };
  }

  const ACTOR_COLUMNS = [
    ["Actor", "left"],
    ["Quality"],
    ["Revenue", null, "The larger of last month's revenue and this month's projected pace"],
    ["Runs"],
    ["Impact", null, "Suggestion weight times the Actor's revenue, runs, and users, relative to the largest in this list"],
    [""],
  ];

  function detailHeader(eyebrow, title, groupKey, description, meta) {
    const header = createElement("header", "aap-quality-inbox-detail-header");
    if (groupKey) header.dataset.group = groupKey;
    if (eyebrow) header.appendChild(createElement("span", "aap-quality-inbox-eyebrow", eyebrow));
    const heading = createElement("h3", null, title);
    header.appendChild(heading);
    if (meta) header.appendChild(createElement("p", "aap-quality-inbox-detail-meta", meta));
    if (description) header.appendChild(createElement("p", "aap-quality-inbox-detail-text", description));
    return header;
  }

  function actorsTable(items, input, handlers, { expandKey, showSuggestion = false } = {}) {
    const { shell, body } = table(ACTOR_COLUMNS, "aap-quality-inbox-table");
    const max = Math.max(1, ...items.map((item) => item.impact));
    const expanded = expandKey && input.expandedIssues.has(expandKey);
    const visible = expandKey && !expanded ? items.slice(0, ACTOR_PREVIEW) : items;
    for (const item of visible) body.appendChild(itemRow(item, input, handlers, max, showSuggestion));
    const fragment = document.createDocumentFragment();
    fragment.appendChild(shell);
    if (expandKey && items.length > ACTOR_PREVIEW) {
      const more = button(expanded ? "Show fewer" : `Show all ${count(items.length)} Actors`, "aap-quality-inbox-link", () => handlers.onToggleIssue(expandKey));
      more.setAttribute("aria-expanded", String(!!expanded));
      fragment.appendChild(more);
    }
    return fragment;
  }

  function issueDetail(issue, input, handlers) {
    const panel = createElement("section", "aap-quality-inbox-detail");
    panel.setAttribute("aria-label", issue.title);
    const meta = [
      plural(issue.items.length, "Actor", "Actors"),
      issue.highCount ? `${count(issue.highCount)} high impact` : null,
      GROUP_HINTS[issue.groupKey],
    ].filter(Boolean).join(" · ");
    panel.append(
      detailHeader(issue.groupLabel, issue.title, issue.groupKey, plainText(issue.description), meta),
      actorsTable(issue.items, input, handlers, { expandKey: issue.key }),
    );
    return panel;
  }

  function hiddenDetail(input, handlers) {
    const panel = createElement("section", "aap-quality-inbox-detail");
    panel.setAttribute("aria-label", "Dismissed and snoozed suggestions");
    panel.append(
      detailHeader("Review", "Dismissed & snoozed", null, "Restore a suggestion to bring it back. Snoozed suggestions return on their own after 7 days."),
      actorsTable(input.inbox.hidden, input, handlers, { showSuggestion: true }),
    );
    return panel;
  }

  function subScoreValue(value) {
    // Sub-scores are 0–1 like the overall score; anything else is shown as is.
    return value >= 0 && value <= 1 ? `${Math.round(value * 100)}%` : String(Math.round(value * 100) / 100);
  }

  // A setting rather than a quality: neither direction is better.
  const NEUTRAL_KEYS = new Set(["isPPEPlatformUsagePaidByUser"]);

  function driverText(driver) {
    if (NEUTRAL_KEYS.has(driver.key)) return `${driver.label}: ${driver.before ? "yes" : "no"} → ${driver.now ? "yes" : "no"}`;
    if (driver.flag) return `${driver.label} ${driver.now > driver.before ? "added" : "removed"}`;
    return `${driver.label} ${subScoreValue(driver.before)} → ${subScoreValue(driver.now)}`;
  }

  function driverLine(driver) {
    if (NEUTRAL_KEYS.has(driver.key)) return createElement("span", "aap-quality-inbox-driver", driverText(driver));
    const down = driver.now < driver.before;
    return createElement("span", `aap-quality-inbox-driver ${down ? "aap-portfolio-bad" : "aap-portfolio-good"}`, `${down ? "↓" : "↑"} ${driverText(driver)}`);
  }

  const MISSING_TEXT = {
    before: "The earlier scan has no sub-scores to compare. The next scan will explain changes.",
    now: "This scan returned no sub-scores, so the change can't be explained yet.",
    some: "Some sub-scores are missing from one of the scans, so the change can't be fully explained.",
  };

  // One line per sub-score that moved, coloured by direction; otherwise a
  // plain statement of why the score changed. A percentile move follows.
  function whatMoved(movement) {
    const lines = movement.reason === "drivers"
      ? movement.drivers.map(driverLine)
      : [createElement(
        "span",
        "aap-quality-inbox-driver",
        movement.reason === "recalculated"
          ? "No sub-score changed. Apify recalculated the overall score; nothing to fix."
          : MISSING_TEXT[movement.missing] || MISSING_TEXT.some,
      )];
    if (movement.percentile) {
      lines.push(createElement(
        "span",
        "aap-quality-inbox-driver aap-portfolio-detail",
        `${formatPercentile(movement.percentile.before)} → ${formatPercentile(movement.percentile.now)} among Store Actors`,
      ));
    }
    return lines;
  }

  function changesDescription(movements) {
    const explained = movements.filter((movement) => movement.reason === "drivers").length;
    const recalculated = movements.filter((movement) => movement.reason === "recalculated").length;
    const unexplained = movements.length - explained - recalculated;
    const parts = [];
    if (explained) parts.push("Each change lists the sub-scores that moved most. Red ones lowered the score.");
    if (recalculated) {
      parts.push(recalculated === movements.length
        ? "No sub-score changed, so Apify recalculated these scores. Nothing here needs a fix."
        : `${plural(recalculated, "Actor", "Actors")} moved with no sub-score change, so Apify recalculated ${recalculated === 1 ? "its score" : "their scores"}.`);
    }
    if (unexplained) parts.push(`${plural(unexplained, "change", "changes")} can't be explained until both scans have sub-scores.`);
    return parts.join(" ");
  }

  function changesDetail(input) {
    const panel = createElement("section", "aap-quality-inbox-detail");
    panel.setAttribute("aria-label", "Score changes");
    const { shell, body } = table([["Actor", "left"], ["Before"], ["Now"], ["Change"], ["What moved", "left"]], "aap-quality-inbox-changes");
    for (const movement of input.movements) {
      const row = document.createElement("tr");
      const down = movement.delta < 0;
      const change = createElement("td");
      change.appendChild(createElement("strong", `aap-portfolio-value ${down ? "aap-portfolio-bad" : "aap-portfolio-good"}`, `${down ? "↓" : "↑"} ${Math.abs(movement.delta * 100).toFixed(1)} pts`));
      const why = createElement("td", "aap-portfolio-left aap-quality-inbox-why");
      why.append(...whatMoved(movement));
      row.append(actorCell(movement.actor, input.actorHref(movement.actor), []), valueCell(formatScore(movement.before)), valueCell(formatScore(movement.now)), change, why);
      body.appendChild(row);
    }
    panel.append(
      detailHeader("Review", "Score changes", null, changesDescription(input.movements), input.previousCapturedAt ? `Since the scan on ${shortDate(input.previousCapturedAt)}` : null),
      shell,
    );
    return panel;
  }

  function emptyDetail(input) {
    const panel = createElement("section", "aap-quality-inbox-detail aap-quality-inbox-detail-empty");
    const query = input.query.trim();
    const title = query ? `No suggestions match "${query}"` : input.scanning ? "Still scanning" : "Nothing to fix right now";
    const text = query
      ? "Try an Actor name or a suggestion such as README or schema."
      : input.scanning
        ? "Suggestions appear here as each Actor is scanned, busiest first."
        : "Apify has no open suggestions for your Actors. New ones show up here after the next scan.";
    panel.append(createElement("h3", null, title), createElement("p", "aap-quality-inbox-detail-text", text));
    return panel;
  }

  function loading() {
    const wrap = createElement("div", "aap-portfolio-loading");
    wrap.setAttribute("aria-hidden", "true");
    for (const width of [520, 760, 680, 720]) {
      const bar = createElement("span", "aap-skeleton");
      bar.style.setProperty("--aap-skeleton-width", `${width}px`);
      bar.style.setProperty("--aap-skeleton-height", "14px");
      wrap.appendChild(bar);
    }
    return wrap;
  }

  function renderInbox(container, input, handlers) {
    if (!input.scannedCount) {
      container.replaceChildren(input.error ? createElement("p", "aap-portfolio-segment-note", input.error) : loading());
      return;
    }
    const selection = resolveSelection(input);
    let detail;
    if (selection === "changes") detail = changesDetail(input);
    else if (selection === "hidden") detail = hiddenDetail(input, handlers);
    else {
      const issue = input.inbox.issues.find((item) => item.key === selection);
      detail = issue ? issueDetail(issue, input, handlers) : emptyDetail(input);
    }
    const layout = createElement("div", "aap-quality-inbox-layout");
    layout.append(issueList(input, selection, handlers), detail);
    container.replaceChildren(summary(input), layout);
  }

  // Scan progress: a thin bar with an accessible label, or the last scan time.
  function renderProgress(container, scan, snapshot, now) {
    container.replaceChildren();
    if (!scan.running) {
      if (snapshot.scannedAt) container.appendChild(createElement("span", null, `Scanned ${relativeTime(snapshot.scannedAt, now)}`));
      return;
    }
    const bar = createElement("span", "aap-quality-inbox-progress-bar");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(scan.total));
    bar.setAttribute("aria-valuenow", String(scan.done));
    bar.setAttribute("aria-label", "Actor quality scan");
    const fill = createElement("span", "aap-quality-inbox-progress-fill");
    fill.style.width = `${scan.total ? Math.round((scan.done / scan.total) * 100) : 0}%`;
    bar.appendChild(fill);
    container.append(bar, createElement("span", null, `${scan.background ? "Refreshing" : "Scanning"} ${count(scan.done)}/${count(scan.total)}`));
  }

  self.AAP_QUALITY_INBOX_VIEW = { renderInbox, renderProgress, relativeTime, formatMoney };
})();
