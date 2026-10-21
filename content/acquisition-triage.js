/*
 * Render helpers for the acquisition triage. Stateless: content/acquisition.js
 * owns the mount point, scan, and state, and calls renderTriage() with the
 * model output plus handlers.
 *
 * Same two-pane layout and classes as the Actor quality inbox, so both pages
 * read as one product: buckets on the left ("Leaking · 14"), the selected
 * bucket's Actors on the right with the reason each one landed there.
 */
(function () {
  const ACTOR_PREVIEW = 12;
  const MODEL = self.AAP_ACQUISITION_TRIAGE;
  const SECTIONS = [["act", "Act now"], ["watch", "Watch"], ["low", "Low attention"]];

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function button(label, className, onClick) {
    const element = createElement("button", className, label);
    element.type = "button";
    element.addEventListener("click", onClick);
    return element;
  }

  const { count, plural } = self.AAPF;

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

  // "Since yesterday" only when the baseline really is from yesterday.
  function sinceLabel(timestamp) {
    const day = (value) => new Date(value).setHours(0, 0, 0, 0);
    const days = Math.round((day(Date.now()) - day(timestamp)) / 86400000);
    return days === 1 ? "Since yesterday" : `Since ${shortDate(timestamp)}`;
  }

  function changeLabel(value) {
    if (value === "new") return "new this month";
    if (value == null) return "no comparison";
    if (value === 0) return "no change";
    return `${value > 0 ? "↑" : "↓"} ${MODEL.formatRate(Math.abs(value))}`;
  }

  function changeTone(value) {
    if (value === "new" || (typeof value === "number" && value > 0)) return "aap-portfolio-good";
    if (typeof value === "number" && value < 0) return "aap-portfolio-bad";
    return "";
  }

  function signal(text, tone) {
    return createElement("span", `aap-portfolio-signal aap-portfolio-signal-${tone}`, text);
  }

  function bucketSignal(key) {
    const bucket = MODEL.bucketFor(key);
    return signal(bucket?.label || key, bucket?.tone || "neutral");
  }

  // Plain explanation of each rule, with this account's actual thresholds.
  function bucketDescription(key, thresholds, early) {
    const t = thresholds || {};
    const later = early ? ` Shown from the ${MODEL.CHANGE_MIN_DAY}th of the month; the first week is too short to compare.` : "";
    const descriptions = {
      leaking: `At least ${count(t.leakFloor)} detail viewers, but fewer than 2 started or the start rate is in the bottom quarter of your Actors (under ${MODEL.formatRate(t.conversionLow || 0)}). People find it and leave: fix the listing before sending more traffic.`,
      rising: `At least ${count(t.viewerFloor)} viewers and up 30% or more on the same point last month. Interest is growing: promote it while it lasts.${later}`,
      fading: `At least ${count(t.viewerFloor)} viewers and down 25% or more on the same point last month. Check its search ranking, recent changes, and competitors.${later}`,
      converting: `${MODEL.formatRate(t.conversionHigh || 0)} or more of viewers start it, the top quarter of your Actors. It turns attention into users: worth more traffic.`,
      steady: `At least ${count(t.viewerFloor)} viewers with no strong signal either way.`,
      quiet: `Fewer than ${count(t.viewerFloor)} detail viewers this month. Low demand and poor discoverability look the same here, so check the Store before retiring it.`,
    };
    return descriptions[key] || "";
  }

  // Resolves the selected entry: a bucket key or "movers". Falls back to the
  // changes since yesterday, then the first non-empty bucket by priority.
  function resolveSelection(input) {
    const { triage, selection, movers } = input;
    if (selection === "movers" && movers.length) return "movers";
    if (triage.buckets.some((bucket) => bucket.key === selection)) return selection;
    if (movers.length) return "movers";
    return triage.buckets.find((bucket) => bucket.items.length)?.key || triage.buckets[0].key;
  }

  // ---- Summary -------------------------------------------------------------------

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

  function totalTile(label, current, previous, title) {
    const delta = MODEL.change(current, previous);
    return tile(label, count(current), delta == null ? "this month" : `${changeLabel(delta)} vs same point last month`, "neutral", title);
  }

  function summary(input) {
    const byKey = new Map(input.triage.buckets.map((bucket) => [bucket.key, bucket]));
    const leaking = byKey.get("leaking").total;
    const rising = byKey.get("rising").total;
    const grid = createElement("div", "aap-range-insights-grid");
    grid.appendChild(tile(
      "Act now",
      count(leaking + rising),
      leaking + rising ? `${count(leaking)} leaking · ${count(rising)} rising` : "Nothing urgent",
      leaking ? "bad" : rising ? "good" : "neutral",
      "Leaking Actors lose the people who find them; Rising Actors are gaining viewers.",
    ));
    if (input.totals) {
      grid.append(
        totalTile("Detail viewers", input.totals.viewers, input.totals.prevViewers, "Unique users who viewed any of your Actors' detail pages."),
        totalTile("Started", input.totals.starters, input.totals.prevStarters, "Unique users who started any of your Actors."),
      );
    }
    if (input.baselineAt) {
      grid.appendChild(tile(
        sinceLabel(input.baselineAt),
        count(input.movers.length),
        input.movers.length ? `changed bucket, vs the ${shortDate(input.baselineAt)} scan` : `no bucket changes vs the ${shortDate(input.baselineAt)} scan`,
        input.movers.length ? "accent" : "neutral",
      ));
    }
    const wrap = createElement("div", "aap-range-insights aap-quality-inbox-summary");
    wrap.appendChild(grid);
    return wrap;
  }

  // ---- Bucket list (left pane) ------------------------------------------------------

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
      bar.title = "Share of all detail viewers";
      const fill = createElement("span");
      fill.style.width = `${Math.max(share ? 4 : 0, Math.round(share * 100))}%`;
      bar.appendChild(fill);
      entry.appendChild(bar);
    }
    entry.addEventListener("click", () => handlers.onSelect(key));
    return entry;
  }

  function bucketList(input, selection, handlers) {
    const nav = createElement("nav", "aap-quality-inbox-list");
    nav.setAttribute("aria-label", "Acquisition buckets");
    const section = (label, entries) => {
      if (!entries.length) return;
      nav.appendChild(createElement("span", "aap-quality-inbox-list-label", label));
      nav.append(...entries);
    };
    if (input.movers.length) {
      section(input.baselineAt ? sinceLabel(input.baselineAt) : "Since last scan", [listEntry({
        key: "movers",
        title: "Changed bucket",
        meta: input.baselineAt ? `since the scan on ${shortDate(input.baselineAt)}` : null,
        total: input.movers.length,
        groupKey: "movers",
        selected: selection === "movers",
      }, handlers)]);
    }
    const totalViewers = Math.max(1, input.triage.viewers);
    for (const [sectionKey, label] of SECTIONS) {
      section(label, input.triage.buckets.filter((bucket) => bucket.section === sectionKey).map((bucket) => listEntry({
        key: bucket.key,
        title: bucket.label,
        meta: input.early && (bucket.key === "rising" || bucket.key === "fading") ? `From the ${MODEL.CHANGE_MIN_DAY}th` : bucket.action,
        total: bucket.items.length,
        groupKey: bucket.key,
        share: bucket.viewers / totalViewers,
        selected: selection === bucket.key,
        muted: !bucket.items.length,
      }, handlers)));
    }
    return nav;
  }

  // ---- Detail (right pane) ------------------------------------------------------------

  function actorCell(actor, href) {
    const cell = createElement("td", "aap-portfolio-actor aap-portfolio-left");
    const link = createElement("a", "aap-portfolio-actor-link");
    link.href = href;
    link.title = "Open Apify's acquisition view for this Actor";
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
    return cell;
  }

  function valueCell(value, detail, detailClass = "") {
    const cell = createElement("td");
    cell.appendChild(createElement("strong", "aap-portfolio-value", value));
    if (detail) cell.appendChild(createElement("span", `aap-portfolio-detail ${detailClass}`.trim(), detail));
    return cell;
  }

  function metricCell(current, previous) {
    const delta = MODEL.change(current, previous);
    return valueCell(current == null ? "–" : count(current), changeLabel(delta), changeTone(delta));
  }

  function whyCell(text) {
    return createElement("td", "aap-portfolio-left aap-quality-inbox-why", text);
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
    ["Viewers", null, "Unique users who viewed the Actor detail page, vs the same point last month"],
    ["Input page", null, "Unique users who viewed the Actor input page"],
    ["Started", null, "Unique users who started the Actor, including API and scheduled runs"],
    ["Start rate", null, "Starters as a share of detail viewers"],
    ["Why", "left"],
  ];

  function itemRow(item, input) {
    const row = document.createElement("tr");
    row.dataset.actorId = item.actor.id;
    if (input.highlightActor === item.actor.id) row.classList.add("aap-quality-inbox-highlight");
    const { entry } = item;
    row.append(
      actorCell(item.actor, input.actorHref(item.actor)),
      metricCell(entry.viewers, entry.prevViewers),
      metricCell(entry.inputViewers, entry.prevInputViewers),
      metricCell(entry.starters, entry.prevStarters),
      valueCell(item.rate == null ? "–" : MODEL.formatRate(item.rate)),
      whyCell(item.reason),
    );
    return row;
  }

  function detailHeader(eyebrow, title, groupKey, description, meta) {
    const header = createElement("header", "aap-quality-inbox-detail-header");
    if (groupKey) header.dataset.group = groupKey;
    if (eyebrow) header.appendChild(createElement("span", "aap-quality-inbox-eyebrow", eyebrow));
    header.appendChild(createElement("h3", null, title));
    if (meta) header.appendChild(createElement("p", "aap-quality-inbox-detail-meta", meta));
    if (description) header.appendChild(createElement("p", "aap-quality-inbox-detail-text", description));
    return header;
  }

  function emptyText(bucket, input) {
    const query = input.query.trim();
    if (query) return `No ${bucket.label.toLowerCase()} Actors match "${query}".`;
    if (input.early && (bucket.key === "rising" || bucket.key === "fading")) return `Month-over-month buckets start on the ${MODEL.CHANGE_MIN_DAY}th.`;
    if (input.scanning) return "Actors appear here as they are scanned, busiest first.";
    return `No ${bucket.label.toLowerCase()} Actors right now.`;
  }

  function bucketDetail(bucket, input, handlers) {
    const panel = createElement("section", "aap-quality-inbox-detail");
    panel.setAttribute("aria-label", `${bucket.label} Actors`);
    const sectionLabel = SECTIONS.find(([key]) => key === bucket.section)?.[1];
    const meta = [
      plural(bucket.items.length, "Actor", "Actors"),
      bucket.action,
      input.provisional ? "Provisional until the scan finishes" : null,
    ].filter(Boolean).join(" · ");
    panel.appendChild(detailHeader(sectionLabel, bucket.label, bucket.key, bucketDescription(bucket.key, input.thresholds, input.early), meta));
    if (!bucket.items.length) {
      const empty = createElement("div", "aap-quality-inbox-detail-empty");
      empty.appendChild(createElement("p", "aap-quality-inbox-detail-text", emptyText(bucket, input)));
      panel.appendChild(empty);
      return panel;
    }
    const { shell, body } = table(ACTOR_COLUMNS, "aap-acquisition-triage-table");
    const expanded = input.expanded.has(bucket.key);
    const visible = expanded ? bucket.items : bucket.items.slice(0, ACTOR_PREVIEW);
    for (const item of visible) body.appendChild(itemRow(item, input));
    panel.appendChild(shell);
    if (bucket.items.length > ACTOR_PREVIEW) {
      const more = button(expanded ? "Show fewer" : `Show all ${count(bucket.items.length)} Actors`, "aap-quality-inbox-link", () => handlers.onToggle(bucket.key));
      more.setAttribute("aria-expanded", String(expanded));
      panel.appendChild(more);
    }
    return panel;
  }

  function moversDetail(input) {
    const panel = createElement("section", "aap-quality-inbox-detail");
    panel.setAttribute("aria-label", "Actors that changed bucket");
    const { shell, body } = table([["Actor", "left"], ["Was"], ["Now"], ["Viewers"], ["Why", "left"]], "aap-acquisition-triage-movers");
    for (const mover of input.movers) {
      const row = document.createElement("tr");
      row.dataset.actorId = mover.actor.id;
      const was = createElement("td");
      was.appendChild(bucketSignal(mover.from));
      const now = createElement("td");
      now.appendChild(bucketSignal(mover.to));
      row.append(
        actorCell(mover.actor, input.actorHref(mover.actor)),
        was,
        now,
        valueCell(`${count(mover.beforeViewers)} → ${count(mover.entry.viewers)}`),
        whyCell(mover.reason),
      );
      body.appendChild(row);
    }
    panel.append(
      detailHeader(
        sinceLabel(input.baselineAt),
        "Changed bucket",
        "movers",
        "Actors whose bucket changed since that scan, judged by the same thresholds on both days, most urgent first. Moves between Steady and Quiet are left out.",
        `${plural(input.movers.length, "Actor", "Actors")} · since the scan on ${shortDate(input.baselineAt)}`,
      ),
      shell,
    );
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

  function renderTriage(container, input, handlers) {
    if (!input.triage.scanned) {
      container.replaceChildren(input.error ? createElement("p", "aap-portfolio-segment-note", input.error) : loading());
      return;
    }
    const selection = resolveSelection(input);
    const bucket = input.triage.buckets.find((item) => item.key === selection);
    const detail = selection === "movers" ? moversDetail(input) : bucketDetail(bucket, input, handlers);
    const layout = createElement("div", "aap-quality-inbox-layout");
    layout.append(bucketList(input, selection, handlers), detail);
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
    bar.setAttribute("aria-label", "Acquisition scan");
    const fill = createElement("span", "aap-quality-inbox-progress-fill");
    fill.style.width = `${scan.total ? Math.round((scan.done / scan.total) * 100) : 0}%`;
    bar.appendChild(fill);
    container.append(bar, createElement("span", null, `${scan.background ? "Refreshing" : "Scanning"} ${count(scan.done)}/${count(scan.total)}`));
  }

  self.AAP_ACQUISITION_TRIAGE_VIEW = { renderTriage, renderProgress, bucketSignal };
})();
