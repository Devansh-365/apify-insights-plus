/* Adds a "Not public" filter to the Console's My Actors page. The Console's
   own table pages on the server and cannot filter by visibility, so the
   filter swaps the table for a list of the account's private Actors. */
(function () {
  const MODEL = self.AAP_VISIBILITY;
  const FILTER_SELECTOR = '[data-test="actor-list-pricing-model-filter-combobox"]';
  const TABLE_ID = "my-actors-list-table";
  const ACTIVE_KEY = "aap-visibility-filter";
  const STORE_PAGE = 1000;
  // A result is reused for this long when the page is opened again.
  const RESULT_TTL_MS = 10 * 60 * 1000;
  // A class, not the hidden attribute: the Console's styles set display.
  const HIDDEN_CLASS = "aap-visibility-hidden";

  const state = {
    active: readActive(),
    button: null,
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

  function readActive() {
    try {
      return sessionStorage.getItem(ACTIVE_KEY) === "1";
    } catch {
      return false;
    }
  }

  function writeActive(active) {
    try {
      if (active) sessionStorage.setItem(ACTIVE_KEY, "1");
      else sessionStorage.removeItem(ACTIVE_KEY);
    } catch {
      // The filter still works for this page view.
    }
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
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

  async function storeIds(username, options) {
    const ids = new Set();
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
      const items = Array.isArray(data.items) ? data.items : [];
      for (const item of items) if (item?.id) ids.add(item.id);
      total = Number(data.total) || 0;
      if (!items.length) break;
      offset += items.length;
    } while (offset < total);
    return ids;
  }

  // The Store must answer first: without it every owned Actor would need
  // its own basic-info request, so a Store failure is an error instead.
  async function loadHidden(options) {
    const owned = MODEL.ownedActors(await AAP_API.actorList(options));
    if (!owned.length) return { hidden: [], unknown: 0, total: 0 };
    const publicIds = await storeIds(await ownerUsername(owned, options), options);
    const infos = new Map();
    await AAP_API.pooled(MODEL.candidates(owned, publicIds), async (actor) => {
      infos.set(actor.id, await AAP_API.actorBasicInfo(actor.id, options).catch(() => null));
    }, { priority: options.priority });
    // Known by now: the Actor list needed the account's token.
    return { ...MODEL.classify(owned, publicIds, infos), total: owned.length, scope: AAP_API.authScope?.() || null };
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
    state.loading = loadHidden(options)
      .then((result) => {
        if (requestId !== state.requestId) return;
        state.result = result;
        state.resultScope = result.scope;
        state.loadedAt = Date.now();
      })
      .catch((error) => {
        if (requestId !== state.requestId) return;
        state.error = AAPF.loadError("private Actors", error);
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

  // The block right after the filter bar that holds the Console table.
  function findTable(filter) {
    const byId = document.getElementById(TABLE_ID);
    if (byId) return byId;
    for (let node = filter; node && node !== document.body; node = node.parentElement) {
      let next = node.nextElementSibling;
      while (next?.classList.contains("aap-visibility-panel")) next = next.nextElementSibling;
      if (next?.querySelector("table")) return next;
    }
    return null;
  }

  function searchQuery() {
    return new URLSearchParams(location.search).get("query") || "";
  }

  function buttonLabel() {
    const count = state.result?.hidden.length;
    if (count == null) return "Not public";
    // Unchecked Actors may be private too.
    return `Not public · ${count}${state.result.unknown ? "+" : ""}`;
  }

  function createButton() {
    const button = createElement("button", "aap-visibility-toggle");
    button.type = "button";
    button.title = "Show only your Actors that are not public in Apify Store";
    button.addEventListener("click", () => {
      state.active = !state.active;
      writeActive(state.active);
      if (state.active && !state.result) {
        if (state.loading) promoteLoad();
        else load();
      }
      render();
    });
    return button;
  }

  function dateText(time) {
    return new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
    const status = actor.firstPublishedAt
      ? createElement("span", "aap-visibility-chip aap-visibility-chip-was", `Unpublished · first published ${dateText(actor.firstPublishedAt)}`)
      : createElement("span", "aap-visibility-chip", "Never published");
    row.append(icon, text, status);
    return row;
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
    showAll.addEventListener("click", () => {
      state.active = false;
      writeActive(false);
      render();
    });
    head.append(heading, refresh, showAll);
    panel.appendChild(head);

    // A failed refresh keeps the last list below its error.
    if (state.error) panel.appendChild(createElement("p", "aap-visibility-note aap-visibility-error", state.error));
    if (!state.result && state.error) {
      heading.textContent = "Not public Actors";
      return;
    }
    if (!state.result) {
      heading.textContent = "Not public Actors";
      panel.appendChild(createElement("p", "aap-visibility-note", "Checking which of your Actors are public…"));
      return;
    }
    const { hidden, unknown } = state.result;
    const query = state.query;
    const rows = hidden.filter((actor) => MODEL.matchesQuery(actor, query));
    heading.textContent = query
      ? `${AAPF.plural(rows.length, "Actor", "Actors")} not public matching “${query}” (of ${hidden.length})`
      : `${AAPF.plural(hidden.length, "Actor", "Actors")} not public`;
    if (unknown) {
      panel.appendChild(createElement("p", "aap-visibility-note aap-visibility-error",
        `Couldn't check ${AAPF.plural(unknown, "Actor", "Actors")}; they may be missing here. Refresh to try again.`));
    }
    if (!rows.length) {
      const empty = hidden.length ? "No match for the search." : unknown ? "None of the checked Actors is private." : "All your Actors are public.";
      panel.appendChild(createElement("p", "aap-visibility-note", empty));
      return;
    }
    const list = createElement("div", "aap-visibility-list");
    list.append(...rows.map(actorRow));
    panel.appendChild(list);
  }

  function render() {
    if (!state.button) return;
    state.button.textContent = buttonLabel();
    state.button.setAttribute("aria-pressed", String(state.active));
    state.button.classList.toggle("aap-visibility-toggle-active", state.active);
    state.table?.classList.toggle(HIDDEN_CLASS, state.active);
    if (!state.active) {
      state.panel?.remove();
      state.panel = null;
      return;
    }
    if (!state.panel) state.panel = createElement("section", "aap-visibility-panel");
    if (state.table && state.panel.nextElementSibling !== state.table) state.table.insertAdjacentElement("beforebegin", state.panel);
    renderPanel();
  }

  function mount() {
    const filter = document.querySelector(FILTER_SELECTOR);
    if (!filter) return;
    if (!state.button?.isConnected) {
      state.button?.remove();
      state.button = createButton();
      filter.insertAdjacentElement("afterend", state.button);
      // The count on the button is worth a few cached requests.
      const fresh = state.result && state.resultScope === (AAP_API.authScope?.() || null) && Date.now() - state.loadedAt < RESULT_TTL_MS;
      if (!fresh && !state.loading) load({ background: !state.active });
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
    if (changed || (state.active && !state.panel?.isConnected)) render();
  }

  function unmount() {
    if (!state.button && !state.panel) return;
    state.requestId++;
    state.loading = null;
    state.table?.classList.remove(HIDDEN_CLASS);
    state.button?.remove();
    state.panel?.remove();
    // The result stays for a quick return to the page; mount() checks its age.
    Object.assign(state, { button: null, panel: null, table: null, query: null, error: null });
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
