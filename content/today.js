/*
 * The Today page: one short list of what to do, built from the scan of the
 * page it sits on. It is the first view of the Acquisition and Actor quality
 * pages, and each keeps its own list: acquisition fixes on one, quality
 * suggestions on the other.
 *
 * The host page passes everything Today reads (its live scan, traffic, and
 * for quality the lifecycle and its actions) through ctx.live(); Today owns
 * only its decision store, kept in chrome.storage.local outside the cache so
 * "Clear cache" never brings back an item the user handled.
 */
(function () {
  const MODEL = self.AAP_TODAY_MODEL;
  const QUALITY = self.AAP_QUALITY_INBOX;
  const { count, plural, wholeMoney: money } = self.AAPF;

  const STORE_PREFIX = "aap.today:";
  const SOURCES = {
    acquisition: {
      path: "acquisition",
      sub: "Listings losing or gaining people, ranked by the users and revenue at stake.",
      nothing: "No Actor's traffic crossed a line worth acting on.",
    },
    quality: {
      path: "actor-quality",
      sub: "Apify's quality suggestions, ranked by the revenue on each Actor.",
      nothing: "No open quality suggestion is worth your time today.",
    },
  };
  const ACTION_LABELS = { done: "Done", snooze: "Snoozed", dismiss: "Not worth it", resolved: "Resolved" };
  // Today's actions map onto the quality inbox's own lifecycle, so the two
  // views always agree.
  const QUALITY_ACTIONS = { done: "fix", snooze: "snooze", dismiss: "dismiss" };

  const loaded = { key: null, pending: null, store: MODEL.emptyStore(), ready: false };
  const ui = { expanded: new Set(), batch: null, batchTotal: 0, skipped: new Set(), extra: 0, signature: "" };
  let mounted = null;

  // ---- Decision store -----------------------------------------------------------

  // Each page keeps its own list, so the source is part of the key.
  function storeKey(source) {
    return `${STORE_PREFIX}${source}:${self.AAP_CONTEXT.accountScope()}`;
  }

  function resetLoaded(key) {
    loaded.key = key;
    loaded.pending = null;
    loaded.store = MODEL.emptyStore();
    loaded.ready = false;
    ui.expanded.clear();
    ui.batch = null;
    ui.skipped.clear();
    ui.extra = 0;
    ui.signature = "";
  }

  function ensureLoaded(key) {
    if (loaded.key !== key) resetLoaded(key);
    if (loaded.ready || loaded.pending) return;
    loaded.pending = chrome.storage.local.get(key).catch(() => ({})).then((stored) => {
      if (loaded.key !== key) return;
      loaded.store = MODEL.restoreStore(stored?.[key]);
      loaded.ready = true;
    }).finally(() => {
      loaded.pending = null;
      rerender(true);
    });
  }

  function saveStore(store) {
    loaded.store = store;
    if (loaded.key) AAP_LOCAL_STORE.set(loaded.key, store);
  }

  // Decisions made in another tab show up here; this tab's own writes are
  // skipped, so a late echo never undoes a newer decision.
  chrome.storage.onChanged?.addListener((changes, area) => {
    const change = area === "local" && loaded.key ? changes[loaded.key] : null;
    if (!change || AAP_LOCAL_STORE.isEcho(loaded.key, change.newValue)) return;
    loaded.store = MODEL.restoreStore(change.newValue);
    rerender(true);
  });

  AAP_API.onTokenChange?.(() => {
    resetLoaded(null);
    rerender(true);
  });

  // ---- Inputs -------------------------------------------------------------------------

  // Only the page's own scan feeds its list, and only once it has finished
  // at least one pass.
  function inputs(ctx) {
    const source = ctx.source;
    const live = ctx.live?.() || {};
    const own = live[source] || null;
    const snapshot = own?.snapshot;
    const available = !!snapshot && snapshot.scannedAt > 0;
    const actors = new Map((snapshot?.actors || []).map((actor) => [actor.id, actor]));
    return {
      source,
      live,
      available,
      scannedAt: snapshot?.scannedAt || 0,
      acquisition: available && source === "acquisition" ? own : null,
      quality: available && source === "quality" ? own : null,
      lifecycle: live.quality?.lifecycle || {},
      traffic: live.traffic || {},
      actors,
    };
  }

  // ---- Formatting ---------------------------------------------------------------------

  // Gains carry a plus; what is at risk does not, so a loss never reads as
  // a win.
  function amount(item) {
    const sign = item.kind === "fading" ? "" : "+";
    if (item.paid && item.dollars >= 0.5) return `${sign}${money(item.dollars)}/mo`;
    if (item.users < 1) return "<1 user/mo";
    return `${sign}${plural(item.users, "user", "users")}/mo`;
  }

  function caption(kind) {
    return MODEL.KINDS[kind]?.caption || "";
  }

  function dateLabel(now) {
    return new Date(now).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  }

  function insightsPrefix() {
    const index = location.pathname.indexOf("/actors/insights");
    return index > 0 ? location.pathname.slice(0, index) : "";
  }

  function actorUrl(actorId) {
    return `${insightsPrefix()}/actors/${encodeURIComponent(actorId)}`;
  }

  function detailUrl(source, actorId) {
    return `${insightsPrefix()}/actors/insights/${SOURCES[source].path}?actorId=${encodeURIComponent(actorId)}`;
  }

  // ---- DOM helpers ------------------------------------------------------------------

  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function button(className, text, onClick, label) {
    const element = el("button", className, text);
    element.type = "button";
    if (label) element.setAttribute("aria-label", label);
    element.addEventListener("click", onClick);
    return element;
  }

  function link(className, text, href) {
    const element = el("a", className, text);
    element.href = href;
    return element;
  }

  function avatar(actor) {
    if (actor?.pictureUrl) {
      const image = document.createElement("img");
      image.className = "aap-today-avatar";
      image.src = actor.pictureUrl;
      image.alt = "";
      image.loading = "lazy";
      return image;
    }
    const placeholder = el("span", "aap-today-avatar aap-today-avatar-empty", (actor?.title || "?").trim().charAt(0).toUpperCase());
    placeholder.setAttribute("aria-hidden", "true");
    return placeholder;
  }

  function icon(path, className = "aap-today-icon") {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", className);
    const shape = document.createElementNS(ns, "path");
    shape.setAttribute("d", path);
    svg.appendChild(shape);
    return svg;
  }

  const CHECK = "M3.5 8.5l3 3 6-7";
  const CHEVRON = "M6 3.5l4.5 4.5L6 12.5";
  const EXTERNAL = "M9.5 3h3.5v3.5M13 3L7.5 8.5M11 9.5V13H3V5h3.5";

  // ---- Actions ------------------------------------------------------------------------

  // Quality decisions go through the host page's lifecycle actions, so the
  // inbox and Today always agree.
  function qualityAction(actorId, improvementId, action, options) {
    mounted?.ctx?.live?.()?.quality?.onAction?.(actorId, improvementId, action, options);
  }

  function act(candidate, action, options = {}) {
    saveStore(MODEL.applyDecision(loaded.store, candidate, action, Date.now(), options));
    if (candidate.source === "quality") {
      qualityAction(candidate.actor.id, candidate.improvementId, QUALITY_ACTIONS[action], { snoozeMs: MODEL.SNOOZES[options.snooze] || MODEL.SNOOZES.week });
    }
    rerender(true);
  }

  function undo(item) {
    saveStore(MODEL.undoDecision(loaded.store, item.key, Date.now()));
    if (item.source === "quality") qualityAction(item.actorId, item.improvementId, "reopen");
    rerender(true);
  }

  // ---- Pieces -------------------------------------------------------------------------

  function snoozeMenu(candidate, onPick) {
    const menu = el("details", "aap-today-menu");
    const summary = el("summary", "aap-today-ghost", "Snooze");
    summary.setAttribute("aria-label", `Snooze ${candidate.verb} on ${candidate.actor.title}`);
    const list = el("div", "aap-today-menu-list");
    const options = [["week", "For a week"], ["month", "For a month"]];
    if (candidate.source === "acquisition") options.push(["worse", "Until it gets worse"]);
    for (const [value, label] of options) {
      list.appendChild(button("aap-today-menu-item", label, () => {
        menu.open = false;
        onPick(value);
      }));
    }
    menu.append(summary, list);
    // Repaints pause while the menu is open; catch up once it closes.
    menu.addEventListener("toggle", () => {
      if (!menu.open) setTimeout(() => rerender(), 0);
    });
    return menu;
  }

  function funnelDetail(candidate) {
    const wrap = el("div", "aap-today-funnel");
    const { viewers, input, starters, typical } = candidate.funnel;
    const steps = [["Opened the listing", viewers], ...(input == null ? [] : [["Opened the run form", input]]), ["Ran it", starters]];
    const row = el("div", "aap-today-funnel-row");
    for (const [label, value] of steps) {
      const step = el("div", "aap-today-funnel-step");
      step.append(el("strong", null, count(value)), el("span", null, label));
      row.appendChild(step);
    }
    wrap.appendChild(row);
    if (typical && (typical.input || typical.starters)) {
      const parts = [];
      if (input != null && typical.input) parts.push(`${count(typical.input)} open the run form`);
      parts.push(`${count(typical.starters)} run it`);
      wrap.appendChild(el("p", "aap-today-fine", `Per 100 viewers, your typical Actor: ${parts.join(", ")}.`));
    }
    return wrap;
  }

  function payoffNote(candidate) {
    const perUser = candidate.users > 0 && candidate.dollars > 0 ? ` At about ${money(candidate.dollars / candidate.users)} a user, roughly ${money(candidate.dollars)} a month.` : "";
    if (candidate.kind === "listing" || candidate.kind === "runform") {
      return `If it converted like your middle Actors: about ${plural(candidate.users, "more user", "more users")} a month.${perUser}`;
    }
    if (candidate.kind === "promote") return `Gaining about ${plural(candidate.users, "user", "users")} a month over last month.${perUser}`;
    if (candidate.kind === "fading") return `On track to lose about ${plural(candidate.users, "user", "users")} a month against last month.${perUser}`;
    return `A rough estimate from this Actor's users and revenue; Apify doesn't publish how much each suggestion moves traffic.${perUser}`;
  }

  function detail(candidate) {
    const wrap = el("div", "aap-today-detail");
    if (candidate.funnel) wrap.appendChild(funnelDetail(candidate));
    if (candidate.source === "quality") wrap.appendChild(el("p", "aap-today-detail-title", candidate.verb));
    if (candidate.hint) wrap.appendChild(el("p", "aap-today-hint", candidate.hint));
    wrap.appendChild(el("p", "aap-today-fine", payoffNote(candidate)));
    return wrap;
  }

  // One row, read left to right: tick it off, which Actor, what to do and
  // why, what it is worth.
  function row({ item, candidate, status }, actors, options = {}) {
    const actor = candidate?.actor || actors.get(item.actorId) || { id: item.actorId, title: item.title };
    const handled = status !== "open";
    const urgent = !handled && !!candidate?.urgent;
    const kind = candidate?.kind || item.kind;
    const element = el("li", "aap-today-item");
    element.classList.toggle("aap-today-item-handled", handled);
    element.classList.toggle("aap-today-item-current", !!options.current);
    element.dataset.key = item.key;
    element.dataset.kind = kind;
    if (candidate?.source === "quality" || item.source === "quality") element.dataset.group = QUALITY.groupFor(item.improvementId || candidate?.improvementId).key;

    const main = el("div", "aap-today-item-main");
    const check = button("aap-today-tick", "", () => {
      if (handled) undo(item);
      else if (candidate) act(candidate, "done");
    }, handled ? `Undo ${ACTION_LABELS[status] || "Done"} on ${actor.title}` : `Mark ${(candidate || item).verb} on ${actor.title} done`);
    check.appendChild(icon(CHECK, "aap-today-tick-icon"));
    check.disabled = status === "resolved" || (!handled && !candidate);
    check.setAttribute("aria-pressed", String(handled));

    const text = el("div", "aap-today-text");
    const expanded = ui.expanded.has(item.key);
    const title = el("button", "aap-today-title", actor.title);
    title.type = "button";
    title.setAttribute("aria-expanded", String(expanded));
    title.disabled = !candidate || handled;
    title.addEventListener("click", () => {
      if (ui.expanded.has(item.key)) ui.expanded.delete(item.key);
      else ui.expanded.add(item.key);
      rerender(true);
    });
    const meta = el("div", "aap-today-meta");
    const chip = el("span", "aap-today-kind", (candidate || item).verb);
    if (urgent) chip.classList.add("aap-today-kind-urgent");
    meta.appendChild(chip);
    if (handled) meta.appendChild(el("span", "aap-today-why", ACTION_LABELS[status] || "Done"));
    else if (candidate?.why) meta.appendChild(el("span", "aap-today-why", candidate.why));
    text.append(title, meta);

    const side = el("div", "aap-today-side");
    if (!handled) {
      side.append(el("strong", "aap-today-amount", amount(candidate || item)), el("span", "aap-today-caption", urgent ? "urgent" : caption(kind)));
      if (urgent) side.classList.add("aap-today-side-urgent");
    }

    main.append(check, avatar(actor), text, side);
    element.appendChild(main);
    if (!handled && candidate && expanded) element.appendChild(detail(candidate));

    if (!handled && candidate) {
      const actions = el("div", "aap-today-actions");
      const go = el("div", "aap-today-actions-group");
      const open = link("aap-today-ghost aap-today-ghost-strong", "Open Actor", actorUrl(actor.id));
      open.appendChild(icon(EXTERNAL));
      go.append(open, link("aap-today-ghost", "Details", detailUrl(candidate.source, actor.id)));
      if (!expanded) go.appendChild(button("aap-today-ghost", "Why this?", () => {
        ui.expanded.add(item.key);
        rerender(true);
      }));
      const decide = el("div", "aap-today-actions-group");
      if (options.skip) decide.appendChild(button("aap-today-ghost", "Skip", options.skip));
      decide.append(
        snoozeMenu(candidate, (snooze) => act(candidate, "snooze", { snooze })),
        button("aap-today-ghost", "Not worth it", () => act(candidate, "dismiss"), `${actor.title}: not worth it`),
      );
      actions.append(go, decide);
      element.appendChild(actions);
    }
    return element;
  }

  function progress(statuses) {
    const handled = statuses.filter((entry) => entry.status !== "open").length;
    const wrap = el("div", "aap-today-progress");
    wrap.setAttribute("role", "img");
    wrap.setAttribute("aria-label", `${handled} of ${statuses.length} done`);
    const label = el("span", "aap-today-progress-text");
    label.append(el("strong", null, String(handled)), document.createTextNode(` / ${statuses.length} done`));
    const bar = el("span", "aap-today-progress-bar");
    for (const entry of statuses) bar.appendChild(el("span", entry.status !== "open" ? "aap-today-progress-done" : null));
    wrap.append(label, bar);
    return wrap;
  }

  function header(statuses, canPullMore, now, source) {
    const head = el("header", "aap-today-head");
    const text = el("div", "aap-today-head-text");
    text.appendChild(el("span", "aap-today-eyebrow", dateLabel(now)));
    const remaining = statuses.filter((entry) => entry.status === "open" && entry.candidate).length;
    if (!statuses.length) {
      text.append(el("h3", "aap-today-headline", "Nothing needs you today"), el("p", "aap-today-sub", `${SOURCES[source].nothing} The list refills after tomorrow's scan.`));
    } else if (!remaining) {
      text.append(el("h3", "aap-today-headline", "You're done for today"), el("p", "aap-today-sub", "Everything on today's list is handled. A new list is ready after tomorrow's scan."));
      if (canPullMore) text.appendChild(button("aap-today-text-button", "Pull in one more", () => {
        ui.extra += 1;
        rerender(true);
      }));
    } else {
      text.append(
        el("h3", "aap-today-headline", remaining === statuses.length ? `${plural(remaining, "thing", "things")} to do` : `${count(remaining)} left for today`),
        el("p", "aap-today-sub", SOURCES[source].sub),
      );
    }
    head.appendChild(text);
    if (statuses.length) head.appendChild(progress(statuses));
    return head;
  }

  function weekCard(week, snoozed, quiet) {
    const card = el("section", "aap-today-card");
    card.setAttribute("aria-label", "This week");
    card.appendChild(el("h4", "aap-today-card-title", "This week"));
    const stats = el("dl", "aap-today-stats");
    const stat = (label, value) => {
      const wrap = el("div", "aap-today-stat");
      wrap.append(el("dt", null, label), el("dd", null, value));
      stats.appendChild(wrap);
    };
    stat("Done", count(week.done));
    stat("Fixes worth", week.dollars >= 1 ? `${money(week.dollars)}/mo` : week.users >= 1 ? `${count(week.users)} users/mo` : "—");
    stat("Snoozed", count(snoozed));
    card.appendChild(stats);
    if (quiet) card.appendChild(el("p", "aap-today-fine", `Nothing flagged on ${plural(quiet, "Actor", "Actors")}.`));
    return card;
  }

  function batchCard(groups) {
    const card = el("section", "aap-today-card");
    card.setAttribute("aria-label", "Same fix, many Actors");
    card.append(el("h4", "aap-today-card-title", "Same fix, many Actors"), el("p", "aap-today-fine", "Work through one kind of fix in a single pass."));
    const list = el("ul", "aap-today-batch-list");
    for (const group of groups) {
      const item = el("li");
      const start = button("aap-today-batch", "", () => {
        ui.batch = group.fixKey;
        ui.batchTotal = group.items.length;
        ui.skipped.clear();
        rerender(true);
      }, `Start: ${group.verb}, ${group.items.length} Actors`);
      const text = el("span", "aap-today-batch-text");
      text.append(
        el("span", "aap-today-batch-verb", group.verb),
        el("span", "aap-today-batch-meta", `${plural(group.items.length, "Actor", "Actors")} · ${group.dollars >= 1 ? `about ${money(group.dollars)}/mo` : `about ${plural(group.users, "user", "users")}/mo`}`),
      );
      start.append(text, icon(CHEVRON));
      item.appendChild(start);
      list.appendChild(item);
    }
    card.appendChild(list);
    return card;
  }

  // Batch mode: one Actor at a time, all needing the same fix.
  function batchView(open, plan, actors) {
    const planned = new Set((plan?.items || []).map((item) => item.key));
    const queue = open.filter((candidate) => candidate.fixKey === ui.batch && !planned.has(candidate.key));
    const remaining = queue.filter((candidate) => !ui.skipped.has(candidate.key));
    const total = Math.max(ui.batchTotal, queue.length);
    const handled = total - queue.length;
    const first = queue[0] || remaining[0];
    const verb = first?.verb || "Batch";
    const section = el("section", "aap-today-batch-mode");
    section.setAttribute("aria-label", `Batch: ${verb}`);

    const head = el("header", "aap-today-head");
    const text = el("div", "aap-today-head-text");
    const back = button("aap-today-text-button aap-today-back", "", () => {
      ui.batch = null;
      ui.skipped.clear();
      rerender(true);
    });
    back.append(icon("M10 3.5L5.5 8l4.5 4.5"), document.createTextNode("Today"));
    text.append(back, el("h3", "aap-today-headline", verb), el("p", "aap-today-sub", `${plural(total, "Actor", "Actors")} need the same fix. One at a time, biggest first.`));
    head.appendChild(text);
    const meter = el("div", "aap-today-progress");
    const label = el("span", "aap-today-progress-text aap-today-batch-count");
    label.append(el("strong", null, count(handled)), document.createTextNode(` / ${count(total)} done`));
    const bar = el("span", "aap-today-progress-bar aap-today-progress-bar-continuous");
    const fill = el("span", "aap-today-progress-done");
    fill.style.width = `${total ? (handled / total) * 100 : 100}%`;
    bar.appendChild(fill);
    meter.append(label, bar);
    head.appendChild(meter);
    section.appendChild(head);

    const current = remaining[0];
    if (!current) {
      const finished = el("div", "aap-today-empty");
      finished.append(
        el("h3", "aap-today-headline", queue.length ? "Only skipped Actors left" : "Batch finished"),
        el("p", "aap-today-sub", queue.length ? `${plural(queue.length, "Actor", "Actors")} skipped; they stay in the batch for next time.` : `All ${plural(total, "Actor", "Actors")} handled.`),
      );
      section.appendChild(finished);
      return section;
    }
    const list = el("ol", "aap-today-list");
    list.appendChild(row({ item: { key: current.key, actorId: current.actor.id, title: current.actor.title, kind: current.kind, source: current.source, improvementId: current.improvementId }, candidate: current, status: "open" }, actors, {
      current: true,
      skip: () => {
        ui.skipped.add(current.key);
        rerender(true);
      },
    }));
    section.appendChild(list);
    const next = remaining.slice(1, 4).map((candidate) => candidate.actor.title);
    if (next.length) section.appendChild(el("p", "aap-today-next", `Up next: ${next.join(" · ")}${remaining.length > 4 ? " …" : ""}`));
    return section;
  }

  function skeleton(message) {
    const wrap = el("div", "aap-today-loading");
    wrap.appendChild(el("p", "aap-today-sub", message));
    const list = el("div", "aap-today-skeleton");
    list.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 4; index++) list.appendChild(el("span", "aap-today-skeleton-row"));
    wrap.appendChild(list);
    return wrap;
  }

  // ---- Render -------------------------------------------------------------------------

  // A hidden pane (the page shows another view) does not rebuild; the host
  // renders it again when it is shown.
  function rerender(force = false) {
    if (!mounted?.container?.isConnected || mounted.container.hidden) return;
    if (force) ui.signature = "";
    render(mounted.container, mounted.ctx);
  }

  function render(container, ctx) {
    mounted = { container, ctx };
    const root = container.querySelector(":scope > .aap-today") || container.appendChild(el("div", "aap-today"));
    const now = Date.now();
    if (!AAP_API.hasToken?.()) {
      paint(root, "waiting", () => [skeleton("Waiting for Apify to load your account…")]);
      return;
    }
    ensureLoaded(storeKey(ctx.source));
    // An open menu must not be torn down by a scan repaint.
    if (root.querySelector(".aap-today-menu[open]")) return;

    const input = inputs(ctx);
    if (input.live.unavailable) {
      paint(root, `unavailable:${input.live.unavailable}`, () => [el("p", "aap-today-sub", input.live.unavailable)]);
      return;
    }
    const scan = input.live.scan;
    if (!loaded.ready || !input.available) {
      const progress = scan?.done ? ` ${count(scan.done)} of ${count(scan.total)} Actors checked` : "";
      const message = !loaded.ready ? "Loading today's list…" : scan?.running ? `Building today's list…${progress}` : "Nothing to build a list from yet.";
      paint(root, `loading:${message}`, () => [skeleton(message)]);
      return;
    }

    const all = MODEL.buildCandidates({ acquisition: input.acquisition, quality: input.quality, traffic: input.traffic, now });
    const open = MODEL.openCandidates(all, loaded.store, now);
    const statusOptions = { available: [input.source], lifecycle: input.lifecycle };
    const existing = loaded.store.plan?.day === MODEL.dayKey(now) ? loaded.store.plan : null;
    const handled = existing ? MODEL.planStatus(existing, open, loaded.store, now, statusOptions).filter((entry) => entry.status !== "open").map((entry) => entry.item.key) : [];
    const planned = MODEL.planToday(loaded.store, open, now, { sources: { [input.source]: input.scannedAt }, handled, extra: ui.extra });
    if (planned.changed) saveStore({ ...loaded.store, plan: planned.plan });
    ui.extra = 0;
    const plan = planned.plan;
    const statuses = MODEL.planStatus(plan, open, loaded.store, now, statusOptions);
    const groups = MODEL.batches(open, plan);
    const canPullMore = MODEL.canExtend(plan, open);
    const week = MODEL.weekSummary(loaded.store, now);
    const snoozed = input.source === "quality"
      ? Object.values(input.lifecycle).filter((record) => QUALITY.effectiveState(record, now) === "snoozed").length
      : MODEL.snoozedCount(loaded.store, all, now);
    const flagged = new Set(all.map((candidate) => candidate.actor.id));
    const quiet = Math.max(0, input.actors.size - flagged.size);

    const signature = JSON.stringify([
      MODEL.dayKey(now),
      input.source,
      statuses.map((entry) => [entry.item.key, entry.status, Math.round(entry.candidate?.score || 0)]),
      groups.map((group) => [group.fixKey, group.items.length]),
      ui.batch && open.filter((candidate) => candidate.fixKey === ui.batch).map((candidate) => candidate.key),
      [...ui.expanded],
      [...ui.skipped],
      canPullMore,
      week,
      snoozed,
      quiet,
    ]);
    paint(root, signature, () => {
      const layout = el("div", "aap-today-layout");
      const main = el("div", "aap-today-main");
      if (ui.batch) main.appendChild(batchView(open, plan, input.actors));
      else {
        main.appendChild(header(statuses, canPullMore, now, input.source));
        if (statuses.length) {
          const list = el("ol", "aap-today-list");
          list.setAttribute("aria-label", "Today's list");
          // Only the first open item shows its buttons until another is
          // hovered or focused, so the eye lands on one next step.
          const current = statuses.findIndex((entry) => entry.status === "open" && entry.candidate);
          statuses.forEach((entry, index) => list.appendChild(row(entry, input.actors, { current: index === current })));
          main.appendChild(list);
        }
      }
      const aside = el("aside", "aap-today-aside");
      aside.appendChild(weekCard(week, snoozed, quiet));
      if (groups.length && !ui.batch) aside.appendChild(batchCard(groups));
      layout.append(main, aside);
      return [layout];
    });
  }

  function paint(root, signature, build) {
    if (ui.signature === signature && root.childNodes.length) return;
    ui.signature = signature;
    const focusedKey = document.activeElement?.closest?.(".aap-today-item")?.dataset.key || null;
    root.replaceChildren(...build());
    if (focusedKey) root.querySelector(`.aap-today-item[data-key="${CSS.escape(focusedKey)}"] button, .aap-today-item[data-key="${CSS.escape(focusedKey)}"] a`)?.focus({ preventScroll: true });
  }

  // A click outside an open Snooze menu closes it.
  document.addEventListener("click", (event) => {
    for (const menu of document.querySelectorAll(".aap-today-menu[open]")) {
      if (!menu.contains(event.target)) menu.open = false;
    }
  });

  self.AAP_TODAY_VIEW = { render };
})();
