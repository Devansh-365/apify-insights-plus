/* Adds a "Store status" filter to the Console's My Actors page, next to
   Apify's own Last run status and Pricing model filters. It finds the
   account's Actors that are under maintenance or deprecated. The Console's table pages on the server and cannot
   filter by these, so a choice swaps the table for a list of the matches. */
(function () {
  const MODEL = self.AAP_VISIBILITY;
  const FILTER_SELECTOR = '[data-test="actor-list-pricing-model-filter-combobox"]';
  const TABLE_ID = "my-actors-list-table";
  const SELECTED_KEY = "aap-store-status-filter";
  // The previous "Not public" toggle's key, cleared on the next choice.
  const LEGACY_ACTIVE_KEY = "aap-visibility-filter";
  const STORE_PAGE = 1000;
  // A result is reused for this long when the page is opened again.
  const RESULT_TTL_MS = 10 * 60 * 1000;
  // A class, not the hidden attribute: the Console's styles set display.
  const HIDDEN_CLASS = "aap-visibility-hidden";
  const SVG_NS = "http://www.w3.org/2000/svg";

  const state = {
    selected: readSelected(),
    root: null,
    button: null,
    buttonLabel: null,
    buttonCount: null,
    popover: null,
    open: false,
    panel: null,
    table: null,
    query: null,
    result: null,
    resultScope: null,
    loadedAt: 0,
    loading: null,
    // The running scan's request options; a click raises its priority.
    loadOptions: null,
    error: null,
    requestId: 0,
  };

  function readSelected() {
    try {
      const stored = JSON.parse(sessionStorage.getItem(SELECTED_KEY) || "null");
      if (Array.isArray(stored)) return MODEL.normalizeSelection(stored);
    } catch {
      // Starts unfiltered.
    }
    return [];
  }

  function writeSelected(selected) {
    try {
      sessionStorage.removeItem(LEGACY_ACTIVE_KEY);
      if (selected.length) sessionStorage.setItem(SELECTED_KEY, JSON.stringify(selected));
      else sessionStorage.removeItem(SELECTED_KEY);
    } catch {
      // The filter still works for this page view.
    }
  }

  function active() {
    return state.selected.length > 0;
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  // A storefront: this filter is about each Actor's Apify Store listing,
  // and a different mark keeps it apart from Apify's funnel filters.
  function storeIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("aap-status-filter-icon");
    for (const d of [
      "m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7",
      "M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8",
      "M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4",
      "M2 7h20",
      "M22 7v3a2 2 0 0 1-2 2a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7",
    ]) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }

  // The account's username comes from any Actor's basic info when the Actor
  // list does not carry it.
  async function ownerUsername(owned, options) {
    const known = owned.find((actor) => actor.username)?.username;
    if (known) return known;
    const info = await AAP_API.actorBasicInfo(owned[0].id, options);
    const username = String(info?.username || "").trim();
    if (!username) throw new Error("the account's username is unknown");
    return username;
  }

  async function storeItems(username, options) {
    const items = [];
    let offset = 0;
    let total = 0;
    do {
      const response = await AAP_API.publicActorStore(username, {
        limit: STORE_PAGE,
        offset,
        includeUnrunnableActors: true,
        priority: options.priority,
        ...(options.fresh ? { cacheMode: "no-store" } : {}),
      });
      const data = response?.data && typeof response.data === "object" ? response.data : response || {};
      const page = Array.isArray(data.items) ? data.items : [];
      items.push(...page);
      total = Number(data.total) || 0;
      offset += page.length;
      if (!page.length) break;
    } while (offset < total);
    return items;
  }

  // Deprecation also shows in the monetization breakdown; a failure there
  // only loses that extra signal.
  async function breakdownDeprecated(options) {
    try {
      const month = `${new Date().toISOString().slice(0, 7)}-01`;
      return MODEL.deprecatedIds(await AAP_API.actorBreakdown(month, [], { priority: options.priority, tag: options.tag }));
    } catch {
      return new Set();
    }
  }

  // An Actor missing from the Store: the Console's basic info first. When
  // that does not say whether it is deprecated, Apify's public API answers
  // without a login for a public Actor (a 404 means a private one, which the
  // basic info alone has to answer for).
  async function actorInfo(actor, username, options) {
    const basic = await AAP_API.actorBasicInfo(actor.id, options).catch(() => null);
    if (basic && (typeof basic.isDeprecated === "boolean" || basic.isPublic === false)) return basic;
    const name = actor.name || basic?.name;
    const owner = actor.username || basic?.username || username;
    if (!name || !owner) return basic;
    try {
      const response = await AAP_API.publicActorDetails(`${owner}/${name}`, { priority: options.priority, tag: options.tag });
      const details = response?.data && typeof response.data === "object" ? response.data : response || {};
      return {
        ...(basic || {}),
        isPublic: typeof details.isPublic === "boolean" ? details.isPublic : basic?.isPublic ?? true,
        isDeprecated: basic?.isDeprecated === true || details.isDeprecated === true,
        notice: basic?.notice || details.notice || null,
        title: basic?.title || details.title,
        pictureUrl: basic?.pictureUrl || details.pictureUrl,
        username: basic?.username || details.username || owner,
      };
    } catch {
      return basic;
    }
  }

  // The Store must answer first: without it every owned Actor would need
  // its own requests, so a Store failure is an error instead.
  async function loadStatuses(options) {
    const owned = MODEL.ownedActors(await AAP_API.actorList(options));
    if (!owned.length) return { rows: [], counts: {}, unknown: 0, total: 0, listed: 0, scope: AAP_API.authScope?.() || null };
    const deprecatedTask = breakdownDeprecated(options);
    const username = await ownerUsername(owned, options);
    const store = MODEL.storeEntries(await storeItems(username, options));
    const publicIds = new Set(store.keys());
    const infos = new Map();
    await AAP_API.pooled(MODEL.candidates(owned, publicIds), async (actor) => {
      infos.set(actor.id, await actorInfo(actor, username, options));
    }, { priority: options.priority });
    const result = MODEL.statusRows(owned, store, infos, await deprecatedTask);
    // Known by now: the Actor list needed the account's token.
    const listed = owned.filter((actor) => publicIds.has(actor.id)).length;
    return { ...result, total: owned.length, listed, username, scope: AAP_API.authScope?.() || null };
  }

  // The user is waiting on a background scan: move its queued requests up
  // and run the rest in the foreground.
  function promoteLoad() {
    if (!state.loadOptions || state.loadOptions.priority === "foreground") return;
    state.loadOptions.priority = "foreground";
    AAP_API.promote?.(state.loadOptions.tag);
  }

  // A page-load count runs in the background; Refresh skips every cache.
  function load({ fresh = false, background = false } = {}) {
    if (state.loading && !fresh) return state.loading;
    const requestId = ++state.requestId;
    state.error = null;
    const options = { fresh, priority: background ? "background" : "foreground", tag: `aap-visibility-${requestId}` };
    state.loadOptions = options;
    state.loading = loadStatuses(options)
      .then((result) => {
        if (requestId !== state.requestId) return;
        state.result = result;
        state.resultScope = result.scope;
        state.loadedAt = Date.now();
      })
      .catch((error) => {
        if (requestId !== state.requestId) return;
        state.error = AAPF.loadError("Actor statuses", error);
      })
      .finally(() => {
        if (requestId !== state.requestId) return;
        state.loading = null;
        state.loadOptions = null;
        render();
      });
    render();
    return state.loading;
  }

  const TABLE_SELECTOR = 'table, [role="table"], [role="grid"]';

  // The block right after the filter bar that holds the Console table.
  function findTable(filter) {
    const byId = document.getElementById(TABLE_ID);
    if (byId) return byId;
    for (let node = filter; node && node !== document.body; node = node.parentElement) {
      let next = node.nextElementSibling;
      while (next?.classList.contains("aap-visibility-panel")) next = next.nextElementSibling;
      if (next && (next.matches(TABLE_SELECTOR) || next.querySelector(TABLE_SELECTOR))) return next;
    }
    return null;
  }

  // Where the results go when the table can't be found (an empty account,
  // or a Console layout change): right below the filter bar, so a choice
  // never does nothing visible.
  function panelAnchor() {
    if (state.table) return { element: state.table, position: "beforebegin" };
    let bar = state.root;
    for (let depth = 0; bar?.parentElement && depth < 4; depth++) {
      if (bar.parentElement.getBoundingClientRect().width > bar.getBoundingClientRect().width * 2) break;
      bar = bar.parentElement;
    }
    return bar ? { element: bar, position: "afterend" } : null;
  }

  function searchQuery() {
    return new URLSearchParams(location.search).get("query") || "";
  }

  function statusLabel(key) {
    return MODEL.STATUSES.find((status) => status.key === key)?.label || key;
  }

  // ---- Filter button and menu ----------------------------------------------
  // The visible box of Apify's filter button: the first element, from the
  // wrapper down, that draws a border.
  function nativeBox(filter) {
    for (const element of [filter, ...filter.querySelectorAll("*")]) {
      if (element.matches("svg, svg *")) continue;
      const style = getComputedStyle(element);
      if (parseFloat(style.borderTopWidth) > 0 && element.getBoundingClientRect().height > 0) return element;
    }
    return filter.querySelector("button") || filter;
  }

  // The element that holds the button's label text ("Pricing model").
  function nativeLabel(box) {
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent.trim()) return node.parentElement;
    }
    return box;
  }

  // Copy Apify's own filter button, read live, so the three sit as one row
  // in either theme: box size, corners, colors, and the label's type.
  function matchNativeButton(filter) {
    if (!state.root) return;
    const box = nativeBox(filter);
    const boxStyle = getComputedStyle(box);
    const labelStyle = getComputedStyle(nativeLabel(box));
    const icon = box.querySelector("svg");
    const set = (name, value) => {
      if (value && value !== "auto" && value !== "normal" && value !== "0px") state.root.style.setProperty(name, value);
      else state.root.style.removeProperty(name);
    };
    const height = box.getBoundingClientRect().height;
    set("--aap-status-filter-height", height ? `${Math.round(height)}px` : "");
    set("--aap-status-filter-radius", boxStyle.borderTopLeftRadius);
    set("--aap-status-filter-padding-x", boxStyle.paddingLeft);
    set("--aap-status-filter-gap", boxStyle.columnGap);
    set("--aap-status-filter-background", boxStyle.backgroundColor);
    set("--aap-status-filter-border", boxStyle.borderTopColor);
    set("--aap-status-filter-color", labelStyle.color);
    set("--aap-status-filter-font-size", labelStyle.fontSize);
    set("--aap-status-filter-font-weight", labelStyle.fontWeight);
    set("--aap-status-filter-font-family", labelStyle.fontFamily);
    const iconSize = icon?.getBoundingClientRect().width;
    set("--aap-status-filter-icon-size", iconSize ? `${Math.round(iconSize)}px` : "");
  }

  function createFilter() {
    const root = createElement("div", "aap-status-filter");
    const button = createElement("button", "aap-visibility-toggle aap-status-filter-button");
    button.type = "button";
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", "aap-status-filter-menu");
    button.title = "Show your Actors that are under maintenance or deprecated";
    const label = createElement("span", "aap-status-filter-label", "Store status");
    const count = createElement("span", "aap-status-filter-count");
    count.hidden = true;
    button.append(storeIcon(), label, count);
    button.addEventListener("click", () => (state.open ? closeMenu(true) : openMenu()));
    button.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" && !state.open) {
        event.preventDefault();
        openMenu();
      }
    });

    const popover = createElement("div", "aap-status-filter-menu");
    popover.id = "aap-status-filter-menu";
    popover.hidden = true;
    popover.setAttribute("role", "group");
    popover.setAttribute("aria-label", "Store status");
    popover.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    });

    root.append(button, popover);
    Object.assign(state, { root, button, buttonLabel: label, buttonCount: count, popover });
    return root;
  }

  function setSelected(selected) {
    state.selected = MODEL.normalizeSelection(selected);
    writeSelected(state.selected);
    if (active() && !state.result) {
      if (state.loading) promoteLoad();
      else load();
    }
    render();
  }

  function renderMenu() {
    const menu = state.popover;
    if (!menu) return;
    const counts = state.result?.counts || null;
    const selected = new Set(state.selected);
    const options = MODEL.STATUSES.map((status) => {
      const option = createElement("label", "aap-status-filter-option");
      const input = createElement("input", "aap-status-filter-checkbox");
      input.type = "checkbox";
      input.checked = selected.has(status.key);
      input.value = status.key;
      input.addEventListener("change", () => {
        const next = new Set(state.selected);
        if (input.checked) next.add(status.key);
        else next.delete(status.key);
        setSelected([...next]);
      });
      const text = createElement("span", "aap-status-filter-text");
      text.append(
        createElement("span", "aap-status-filter-option-label", status.label),
        createElement("span", "aap-status-filter-hint", status.hint),
      );
      const number = createElement("span", "aap-status-filter-option-count", counts ? AAPF.count(counts[status.key] || 0) : "…");
      if (!counts) number.setAttribute("aria-label", "counting");
      option.append(input, text, number);
      return option;
    });
    const footer = createElement("div", "aap-status-filter-footer");
    const note = createElement("span", "aap-status-filter-note", footerNote());
    const clear = createElement("button", "aap-status-filter-clear", "Clear");
    clear.type = "button";
    clear.disabled = !active();
    clear.addEventListener("click", () => {
      setSelected([]);
      menu.querySelector("input")?.focus({ preventScroll: true });
    });
    footer.append(note, clear);
    const focused = menu.contains(document.activeElement) ? document.activeElement.value : null;
    menu.replaceChildren(...options, footer);
    if (focused) menu.querySelector(`input[value="${focused}"]`)?.focus({ preventScroll: true });
  }

  // What the check saw, so a surprising count can be told apart from a
  // failed check: Actors found, how many the Store lists, and the misses.
  function footerNote() {
    if (state.error) return state.error;
    if (state.loading && !state.result) return "Checking your Actors…";
    const result = state.result;
    if (!result) return "";
    if (!result.total) return "No Actors found on this account";
    const parts = [`${AAPF.count(result.total)} checked`, `${AAPF.count(result.listed ?? 0)} in Store`];
    if (result.unknown) parts.push(`${AAPF.count(result.unknown)} unchecked`);
    return parts.join(" · ");
  }

  function onOutside(event) {
    if (state.root && !state.root.contains(event.target)) closeMenu(false);
  }

  function openMenu() {
    if (state.open || !state.popover) return;
    state.open = true;
    state.popover.hidden = false;
    state.button.setAttribute("aria-expanded", "true");
    // The counts are what the menu is for; a background scan moves up.
    if (state.loading) promoteLoad();
    else if (!state.result) load();
    renderMenu();
    document.addEventListener("pointerdown", onOutside, true);
    state.popover.querySelector("input")?.focus({ preventScroll: true });
  }

  function closeMenu(returnFocus) {
    if (!state.open) return;
    state.open = false;
    if (state.popover) state.popover.hidden = true;
    state.button?.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    if (returnFocus) state.button?.focus({ preventScroll: true });
  }

  // ---- Results panel ---------------------------------------------------------
  function statusChip(key) {
    const tone = key === "maintenance" ? " aap-visibility-chip-warn" : key === "deprecated" ? " aap-visibility-chip-bad" : "";
    return createElement("span", `aap-visibility-chip${tone}`, statusLabel(key));
  }

  function actorRow(actor) {
    const row = createElement("a", "aap-visibility-row");
    row.href = `${MODEL.routePrefix(location.pathname)}actors/${encodeURIComponent(actor.id)}`;
    const icon = createElement(actor.pictureUrl ? "img" : "span", "aap-visibility-icon");
    if (actor.pictureUrl) {
      icon.src = actor.pictureUrl;
      icon.alt = "";
      icon.loading = "lazy";
    } else {
      icon.textContent = (actor.title || actor.name || "?").slice(0, 1).toUpperCase();
    }
    const text = createElement("span", "aap-visibility-text");
    text.append(
      createElement("strong", "aap-visibility-title", actor.title || actor.name),
      createElement("span", "aap-visibility-name", actor.username ? `${actor.username}/${actor.name}` : actor.name),
    );
    const chips = createElement("span", "aap-visibility-chips");
    chips.append(...actor.statuses.map(statusChip));
    row.append(icon, text, chips);
    return row;
  }

  // Reads after "3 Actors …" in the heading.
  const PHRASES = { maintenance: "under maintenance", deprecated: "deprecated" };

  function selectionText() {
    const labels = state.selected.map((key) => PHRASES[key] || statusLabel(key).toLowerCase());
    return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}` : labels[0] || "";
  }

  function renderPanel() {
    const panel = state.panel;
    panel.replaceChildren();
    const head = createElement("div", "aap-visibility-head");
    const heading = createElement("div", "aap-visibility-heading");
    const refresh = createElement("button", "aap-visibility-action", state.loading ? "Checking…" : "Refresh");
    refresh.type = "button";
    refresh.disabled = !!state.loading;
    refresh.addEventListener("click", () => load({ fresh: true }));
    const showAll = createElement("button", "aap-visibility-action", "Show all Actors");
    showAll.type = "button";
    showAll.addEventListener("click", () => setSelected([]));
    head.append(heading, refresh, showAll);
    panel.appendChild(head);

    const what = selectionText();
    // A failed refresh keeps the last list below its error.
    if (state.error) panel.appendChild(createElement("p", "aap-visibility-note aap-visibility-error", state.error));
    if (!state.result) {
      heading.textContent = `Actors: ${what}`;
      if (!state.error) panel.appendChild(createElement("p", "aap-visibility-note", "Checking your Actors in Apify Store…"));
      return;
    }
    const { rows, unknown } = state.result;
    const matching = MODEL.filterRows(rows, state.selected);
    const shown = MODEL.filterRows(rows, state.selected, state.query);
    heading.textContent = state.query
      ? `${AAPF.plural(shown.length, "Actor", "Actors")} ${what} matching “${state.query}” (of ${matching.length})`
      : `${AAPF.plural(matching.length, "Actor", "Actors")} ${what}`;
    if (unknown && state.selected.includes("deprecated")) {
      panel.appendChild(createElement("p", "aap-visibility-note aap-visibility-error",
        `Couldn't check ${AAPF.plural(unknown, "Actor", "Actors")}; they may be missing here. Refresh to try again.`));
    }
    if (!shown.length) {
      panel.appendChild(createElement("p", "aap-visibility-note", matching.length ? "No match for the search." : `No Actors ${what}.`));
      return;
    }
    const list = createElement("div", "aap-visibility-list");
    list.append(...shown.map(actorRow));
    panel.appendChild(list);
  }

  function renderButton() {
    if (!state.button) return;
    const count = state.selected.length;
    state.buttonCount.hidden = !count;
    state.buttonCount.textContent = count ? String(count) : "";
    state.button.classList.toggle("aap-visibility-toggle-active", active());
    state.button.setAttribute("aria-label", count ? `Store status: ${selectionText()}` : "Store status");
  }

  function render() {
    if (!state.button) return;
    renderButton();
    if (state.open) renderMenu();
    state.table?.classList.toggle(HIDDEN_CLASS, active());
    if (!active()) {
      state.panel?.remove();
      state.panel = null;
      return;
    }
    if (!state.panel) state.panel = createElement("section", "aap-visibility-panel");
    const anchor = panelAnchor();
    const placed = anchor && (anchor.position === "beforebegin"
      ? state.panel.nextElementSibling === anchor.element
      : state.panel.previousElementSibling === anchor.element);
    if (anchor && !placed) anchor.element.insertAdjacentElement(anchor.position, state.panel);
    renderPanel();
  }

  function mount() {
    const filter = document.querySelector(FILTER_SELECTOR);
    if (!filter) return;
    if (!state.root?.isConnected) {
      state.root?.remove();
      closeMenu(false);
      filter.insertAdjacentElement("afterend", createFilter());
      matchNativeButton(filter);
      renderButton();
      // The counts in the menu are worth a few cached requests.
      const fresh = state.result && state.resultScope === (AAP_API.authScope?.() || null) && Date.now() - state.loadedAt < RESULT_TTL_MS;
      if (!fresh && !state.loading) load({ background: !active() });
    }
    // Apify's styles can arrive after the first paint or change with the theme.
    if (!state.styledAt || Date.now() - state.styledAt > 2000) {
      matchNativeButton(filter);
      state.styledAt = Date.now();
    }
    const table = findTable(filter);
    let changed = table !== state.table;
    if (changed) state.table?.classList.remove(HIDDEN_CLASS);
    state.table = table;
    const query = searchQuery();
    if (query !== state.query) {
      state.query = query;
      changed = true;
    }
    if (changed || (active() && !state.panel?.isConnected)) render();
  }

  function unmount() {
    if (!state.root && !state.panel) return;
    state.requestId++;
    state.loading = null;
    closeMenu(false);
    state.table?.classList.remove(HIDDEN_CLASS);
    state.root?.remove();
    state.panel?.remove();
    // The result stays for a quick return to the page; mount() checks its age.
    Object.assign(state, { styledAt: 0, root: null, button: null, buttonLabel: null, buttonCount: null, popover: null, panel: null, table: null, query: null, error: null });
  }

  // Another account's result is never shown, even on a page that stays open.
  AAP_API.onTokenChange?.(() => {
    state.requestId++;
    Object.assign(state, { result: null, resultScope: null, loadedAt: 0, loading: null, loadOptions: null, error: null });
    render();
  });

  function sync() {
    if (MODEL.developmentRoute(location.pathname) && (self.AAP_FEATURES?.enabled("visibility") ?? true)) mount();
    else unmount();
  }

  sync();
  self.AAP_FEATURES?.onChange(sync);
  const poll = AAP_LIFECYCLE.every(sync, 500);
  window.addEventListener("beforeunload", () => clearInterval(poll));
})();
