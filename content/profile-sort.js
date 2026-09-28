/* Adds cached profile Actor statistics and on-demand sorting to public profiles. */
(function () {
  const HOST_CLASS = "aap-profile-sort-controls";
  const SORTED_LIST_CLASS = "aap-profile-sorted-list";
  const PROFILE_STATS_HOST_CLASS = "aap-profile-extra-metrics";
  const PAGE_CLASS = "aap-profile-sort-page";
  const PAGE_SIZE = 1000;
  const CATALOG_TTL_MS = 15 * 60 * 1000;
  const ROUTE_EXCLUSIONS = new Set([
    "about",
    "account",
    "actors",
    "admin",
    "api",
    "api-reference",
    "assets",
    "contact",
    "crawlers",
    "dashboard",
    "developers",
    "docs",
    "documentation",
    "downloads",
    "ext",
    "help",
    "hiring",
    "image",
    "images",
    "integrations",
    "job",
    "jobs",
    "library",
    "live-status",
    "login",
    "logout",
    "market",
    "marketplace",
    "password",
    "pricing",
    "privacy",
    "products",
    "profiles",
    "release-notes",
    "request-form",
    "request-solution",
    "reset-password",
    "schemas",
    "settings",
    "sign-in",
    "sign-up",
    "signin",
    "signup",
    "solutions",
    "store",
    "support",
    "team",
    "terms",
    "user",
    "users",
  ]);

  const catalogCache = new Map();
  const catalogFetches = new Map();
  const state = {
    routeKey: null,
    username: null,
    sortKey: "default",
    direction: "desc",
    heading: null,
    list: null,
    host: null,
    select: null,
    directionButton: null,
    status: null,
    retryButton: null,
    sortedList: null,
    profileStatsRouteKey: null,
    profileStatsHost: null,
    profileStats: null,
    profileStatsLoading: false,
    profileStatsError: null,
    profileStatsPromise: null,
    catalog: null,
    catalogSortKey: null,
    loading: false,
    error: null,
    loadPromise: null,
    requestId: 0,
    renderToken: 0,
    renderedCount: 0,
  };

  let lastPath = location.pathname;

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function profileRoute() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts.length !== 1 || ROUTE_EXCLUSIONS.has(parts[0].toLowerCase())) return null;
    let username;
    try {
      username = decodeURIComponent(parts[0]);
    } catch {
      return null;
    }
    if (!/^[^/?#\s]+$/.test(username)) return null;
    return { key: username.toLowerCase(), username };
  }

  function headingText(element) {
    return String(element?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function findSurface() {
    const heading = [...document.querySelectorAll("h2, h3, [role='heading']")]
      .find((element) => headingText(element) === "public actors");
    if (!heading) return null;
    let list = heading.nextElementSibling;
    while (list?.classList.contains(HOST_CLASS) || list?.classList.contains(SORTED_LIST_CLASS)) {
      list = list.nextElementSibling;
    }
    if (!list) return null;
    return { heading, list };
  }

  function formatCompact(value) {
    if (value == null) return "–";
    return new Intl.NumberFormat(undefined, {
      notation: "compact",
      maximumFractionDigits: value >= 1000 ? 1 : 0,
    }).format(value);
  }

  function renderProfileStats() {
    if (!state.profileStatsHost?.isConnected) return;
    const loading = state.profileStatsLoading;
    const error = state.profileStatsError;
    const metrics = [
      ["Total runs", state.profileStats?.totalRuns, "↗"],
      ["Monthly runs", state.profileStats?.monthlyRuns, "↻"],
    ];
    state.profileStatsHost.replaceChildren(...metrics.map(([label, value, icon]) => {
      const row = createElement("div", "aap-profile-run-metric");
      const iconElement = createElement("span", "aap-profile-run-metric-icon", icon);
      iconElement.setAttribute("aria-hidden", "true");
      const displayValue = loading ? "Loading…" : error ? "Unavailable" : formatCompact(value);
      const text = createElement("span", "aap-profile-run-metric-text");
      text.append(
        createElement("strong", "aap-profile-run-metric-value", displayValue),
        document.createTextNode(` ${label}`),
      );
      row.append(iconElement, text);
      if (error) row.title = error;
      return row;
    }));
    state.profileStatsHost.setAttribute("aria-live", "polite");
  }

  function resetProfileStats() {
    state.profileStatsHost?.remove();
    state.profileStatsRouteKey = null;
    state.profileStatsHost = null;
    state.profileStats = null;
    state.profileStatsLoading = false;
    state.profileStatsError = null;
    state.profileStatsPromise = null;
  }

  function findProfileStatsMount() {
    return document.querySelector('[data-test="developer-metrics"]');
  }

  function loadProfileStats(route) {
    if (state.profileStatsPromise || state.profileStatsLoading) return;
    state.profileStatsLoading = true;
    state.profileStatsError = null;
    renderProfileStats();

    let operation;
    operation = (async () => {
      try {
        const actors = await fetchCatalog(route, "default", "background");
        if (state.profileStatsRouteKey !== route.key) return;
        state.profileStats = AAP_PROFILE_SORT.aggregateActorStats(actors);
      } catch (error) {
        if (state.profileStatsRouteKey !== route.key) return;
        state.profileStatsError = error?.message || "Profile run statistics could not be loaded.";
      } finally {
        if (state.profileStatsRouteKey === route.key) {
          state.profileStatsLoading = false;
          if (state.profileStatsPromise === operation) state.profileStatsPromise = null;
          renderProfileStats();
        }
      }
    })();
    state.profileStatsPromise = operation;
  }

  function ensureProfileStats(route) {
    if (state.profileStatsRouteKey !== route.key) {
      resetProfileStats();
      state.profileStatsRouteKey = route.key;
    }
    const mount = findProfileStatsMount();
    if (!mount) return;

    let host = mount.querySelector(`.${PROFILE_STATS_HOST_CLASS}`);
    if (!host) {
      host = createElement("div", PROFILE_STATS_HOST_CLASS);
      mount.appendChild(host);
    }
    state.profileStatsHost = host;
    renderProfileStats();
    if (!state.profileStats && !state.profileStatsLoading && !state.profileStatsError) loadProfileStats(route);
  }

  function formatRelativeTime(value) {
    if (!value) return "No runs yet";
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return "Last run unavailable";
    const delta = Date.now() - timestamp;
    if (delta < 0) return "Recently";
    const minutes = Math.floor(delta / 60_000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  }

  function formatCreatedAt(actor) {
    if (actor?.createdAt) {
      const date = new Date(actor.createdAt);
      if (!Number.isNaN(date.getTime())) {
        return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      }
    }
    return actor?.index === 0 ? "Newest" : `#${(actor?.index ?? 0) + 1}`;
  }

  function metricDisplay(actor, key) {
    return key === "newest" ? formatCreatedAt(actor) : formatCompact(metricValue(actor, key));
  }

  function pricingLabel(actor) {
    const model = actor?.pricingInfo?.pricingModel;
    if (!model || model === "FREE") return "Free";
    if (model === "PAY_PER_EVENT") return "Pay per event";
    if (model === "PRICE_PER_DATASET_ITEM") return "Per result";
    if (model === "FLAT_PRICE_PER_MONTH") return "Monthly";
    return "Paid Actor";
  }

  function metricValue(actor, key) {
    return AAP_PROFILE_SORT.metricValue(actor, key);
  }

  function metricChip(label, value) {
    const chip = createElement("span", "aap-profile-sort-card-chip");
    chip.append(createElement("span", "aap-profile-sort-card-chip-label", label));
    chip.append(createElement("span", "aap-profile-sort-card-chip-value", value));
    return chip;
  }

  function createActorCard(actor) {
    const card = createElement("a", "aap-profile-sort-card");
    const href = `/${encodeURIComponent(actor.username)}/${encodeURIComponent(actor.name)}`;
    card.href = href;
    card.dataset.test = "actor-card";
    card.dataset.actorRef = AAP_PROFILE_SORT.actorKey(actor);
    card.setAttribute("aria-label", `${actor.title} by ${actor.username}`);

    const main = createElement("div", "aap-profile-sort-card-main");
    const header = createElement("div", "aap-profile-sort-card-header");
    if (actor.pictureUrl) {
      const picture = createElement("img", "aap-profile-sort-card-picture");
      picture.src = actor.pictureUrl;
      picture.alt = "";
      picture.loading = "lazy";
      picture.addEventListener("error", () => picture.remove());
      header.appendChild(picture);
    }
    const titleWrap = createElement("div", "aap-profile-sort-card-title-wrap");
    titleWrap.append(
      createElement("h3", "aap-profile-sort-card-title", actor.title),
      createElement("code", "aap-profile-sort-card-slug", `${actor.username}/${actor.name}`),
    );
    header.appendChild(titleWrap);
    if (actor.notice && actor.notice !== "NONE") {
      header.appendChild(createElement("span", "aap-profile-sort-card-notice", actor.notice));
    }
    main.appendChild(header);
    main.appendChild(createElement("p", "aap-profile-sort-card-description", actor.description || "No description"));

    const summary = createElement("div", "aap-profile-sort-card-summary");
    summary.append(
      metricChip(AAP_PROFILE_SORT.optionLabel(state.sortKey), metricDisplay(actor, state.sortKey)),
      metricChip("Pricing", pricingLabel(actor)),
      metricChip("MAU", formatCompact(actor.mau)),
      metricChip("Last run", formatRelativeTime(actor.lastRunAt)),
    );
    main.appendChild(summary);
    card.appendChild(main);

    const footer = createElement("div", "aap-profile-sort-card-footer");
    const author = createElement("span", "aap-profile-sort-card-author");
    if (actor.userPictureUrl) {
      const avatar = createElement("img", "aap-profile-sort-card-avatar");
      avatar.src = actor.userPictureUrl;
      avatar.alt = "";
      avatar.loading = "lazy";
      avatar.addEventListener("error", () => avatar.remove());
      author.appendChild(avatar);
    }
    author.appendChild(createElement("span", null, actor.userFullName || actor.username));
    footer.appendChild(author);
    const totals = createElement("span", "aap-profile-sort-card-totals");
    totals.append(
      metricChip("Runs", formatCompact(actor.runs)),
      metricChip("Users", formatCompact(actor.users)),
      metricChip("Bookmarks", formatCompact(actor.bookmarks)),
    );
    footer.appendChild(totals);
    card.appendChild(footer);
    return card;
  }

  function setStatus(text, isError = false) {
    if (!state.status) return;
    state.status.textContent = text || "";
    state.status.classList.toggle("aap-profile-sort-status-error", isError);
  }

  function updateControls() {
    if (!state.host) return;
    state.host.setAttribute("aria-busy", state.loading ? "true" : "false");
    if (state.select) state.select.value = state.sortKey;
    if (state.directionButton) {
      const isNewest = state.sortKey === "newest";
      state.directionButton.textContent = isNewest
        ? (state.direction === "desc" ? "Newest first" : "Oldest first")
        : (state.direction === "desc" ? "High → low" : "Low → high");
      state.directionButton.setAttribute(
        "aria-label",
        isNewest
          ? (state.direction === "desc" ? "Newest first; switch to oldest first" : "Oldest first; switch to newest first")
          : (state.direction === "desc" ? "Sorted high to low; switch to low to high" : "Sorted low to high; switch to high to low"),
      );
      state.directionButton.disabled = state.sortKey === "default";
    }
    if (state.retryButton) state.retryButton.hidden = !state.error;
    if (state.loading) {
      setStatus("Loading Actor metrics…");
    } else if (state.error) {
      setStatus(state.error, true);
    } else if (state.sortKey === "default") {
      setStatus("Choose Runs, MAUs, Users, or Bookmarks to sort the cards.");
    } else if (state.catalog) {
      const label = AAP_PROFILE_SORT.optionLabel(state.sortKey);
      const missing = state.catalog.filter((actor) => metricValue(actor, state.sortKey) == null).length;
      const suffix = missing ? ` · ${missing} without data at the bottom` : "";
      setStatus(`${label} · ${state.catalog.length.toLocaleString()} Actors${suffix}`);
    }
  }

  function createControls() {
    const host = createElement("div", HOST_CLASS);
    host.setAttribute("role", "region");
    host.setAttribute("aria-label", "Sort public Actors");

    const label = createElement("label", "aap-profile-sort-label", "Sort Actors by");
    const select = createElement("select", "aap-profile-sort-select");
    select.id = `aap-profile-sort-${Date.now()}`;
    label.htmlFor = select.id;
    for (const option of AAP_PROFILE_SORT.SORT_OPTIONS) {
      select.appendChild(new Option(option.label, option.key));
    }
    select.addEventListener("change", () => {
      state.sortKey = select.value;
      state.error = null;
      if (state.sortKey === "default") {
        restoreOriginal();
      } else {
        requestSort();
      }
    });

    const directionButton = createElement("button", "aap-profile-sort-direction", "High → low");
    directionButton.type = "button";
    directionButton.addEventListener("click", () => {
      if (state.sortKey === "default") return;
      state.direction = state.direction === "desc" ? "asc" : "desc";
      renderSortedList();
    });

    const retryButton = createElement("button", "aap-profile-sort-retry", "Retry");
    retryButton.type = "button";
    retryButton.hidden = true;
    retryButton.addEventListener("click", () => {
      state.error = null;
      state.catalog = null;
      state.catalogSortKey = null;
      requestSort(true);
    });

    const status = createElement("span", "aap-profile-sort-status");
    host.append(label, select, directionButton, retryButton, status);
    state.host = host;
    state.select = select;
    state.directionButton = directionButton;
    state.retryButton = retryButton;
    state.status = status;
    updateControls();
    return host;
  }

  function restoreOriginal() {
    state.renderToken++;
    state.renderedCount = 0;
    if (state.sortedList) state.sortedList.remove();
    state.sortedList = null;
    if (state.list?.isConnected) state.list.hidden = false;
    updateControls();
  }

  function appendRenderChunk(items, root, token, index = 0) {
    if (token !== state.renderToken || state.sortedList !== root || !root.isConnected) return;
    const fragment = document.createDocumentFragment();
    const nextIndex = Math.min(items.length, index + 80);
    for (let i = index; i < nextIndex; i++) fragment.appendChild(createActorCard(items[i]));
    root.appendChild(fragment);
    state.renderedCount = nextIndex;
    setStatus(`Rendering ${nextIndex.toLocaleString()} of ${items.length.toLocaleString()} sorted Actors…`);
    if (nextIndex < items.length) {
      const schedule = window.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
      schedule(() => appendRenderChunk(items, root, token, nextIndex));
      return;
    }
    updateControls();
  }

  function renderSortedList() {
    if (!state.list?.isConnected || !state.catalog || state.sortKey === "default") return;
    state.renderToken++;
    const token = state.renderToken;
    if (state.sortedList) state.sortedList.remove();
    const root = createElement("div", SORTED_LIST_CLASS);
    root.dataset.sortKey = state.sortKey;
    root.dataset.direction = state.direction;
    state.sortedList = root;
    state.list.hidden = true;
    state.list.parentNode.insertBefore(root, state.list);
    const items = AAP_PROFILE_SORT.sortActors(state.catalog, state.sortKey, state.direction);
    if (!items.length) {
      root.appendChild(createElement("p", "aap-profile-sort-empty", "No public Actors were returned for this profile."));
      updateControls();
      return;
    }
    setStatus(`Rendering sorted Actors…`);
    appendRenderChunk(items, root, token);
  }

  async function fetchCatalog(route, catalogSortKey = "default", priority = "background", force = false, onProgress) {
    const normalizedSortKey = catalogSortKey === "newest" ? "newest" : "default";
    const cacheKey = `${route.key}:${normalizedSortKey}`;
    const cached = catalogCache.get(cacheKey);
    if (!force && cached && Date.now() - cached.loadedAt < CATALOG_TTL_MS) return cached.actors;
    const existing = catalogFetches.get(cacheKey);
    if (existing) return existing;

    const operation = (async () => {
      const actors = [];
      let offset = 0;
      let total = null;
      do {
        if (onProgress) onProgress(actors.length);
        const response = await AAP_API.publicActorStore(route.username, {
          limit: PAGE_SIZE,
          offset,
          sortBy: normalizedSortKey === "newest" ? "newest" : undefined,
          priority,
        });
        const page = AAP_PROFILE_SORT.normalizeStoreResponse(response, offset);
        total = AAP_PROFILE_SORT.storeTotal(response);
        actors.push(...page);
        if (!page.length) break;
        offset += page.length;
      } while (offset < total);
      catalogCache.set(cacheKey, { actors, loadedAt: Date.now() });
      return actors;
    })();
    catalogFetches.set(cacheKey, operation);

    try {
      return await operation;
    } finally {
      if (catalogFetches.get(cacheKey) === operation) catalogFetches.delete(cacheKey);
    }
  }

  async function loadCatalog(route, force = false) {
    if (state.loadPromise && !force) return state.loadPromise;
    const requestId = ++state.requestId;
    state.loading = true;
    state.error = null;
    updateControls();
    const catalogSortKey = state.sortKey === "newest" ? "newest" : "default";
    const operation = fetchCatalog(
      route,
      catalogSortKey,
      "foreground",
      force,
      (loaded) => setStatus(`Loading Actor metrics… ${loaded.toLocaleString()} loaded`),
    );
    state.loadPromise = operation;

    try {
      const actors = await operation;
      if (requestId !== state.requestId || state.routeKey !== route.key) return;
      state.catalog = actors;
      state.catalogSortKey = catalogSortKey;
      if (state.sortKey !== "default") renderSortedList();
    } catch (error) {
      if (requestId !== state.requestId || state.routeKey !== route.key) return;
      state.error = error?.message || "Actor metrics could not be loaded.";
      restoreOriginal();
    } finally {
      if (state.loadPromise === operation) state.loadPromise = null;
      if (requestId === state.requestId && state.routeKey === route.key) {
        state.loading = false;
        updateControls();
      }
    }
  }

  function requestSort(force = false) {
    const route = profileRoute();
    if (!route || state.sortKey === "default") return;
    const needsNewestCatalog = state.sortKey === "newest" && state.catalogSortKey !== "newest";
    if (state.catalog && !force && !needsNewestCatalog) {
      renderSortedList();
      updateControls();
      return;
    }
    loadCatalog(route, force);
  }

  function ensureSurface(route, surface) {
    if (state.routeKey !== route.key) {
      state.renderToken++;
      state.sortedList?.remove();
      state.host?.remove();
      if (state.list?.isConnected) state.list.hidden = false;
      state.requestId++;
      state.routeKey = route.key;
      state.username = route.username;
      state.sortKey = "default";
      state.direction = "desc";
      state.heading = null;
      state.list = null;
      state.host = null;
      state.select = null;
      state.directionButton = null;
      state.status = null;
      state.retryButton = null;
      state.sortedList = null;
      state.catalog = null;
      state.catalogSortKey = null;
      state.loading = false;
      state.error = null;
      state.loadPromise = null;
    }

    if (state.list && state.list !== surface.list) {
      restoreOriginal();
      state.list = null;
    }
    state.heading = surface.heading;
    state.list = surface.list;
    if (!state.host || !state.host.isConnected || state.host.previousElementSibling !== surface.heading) {
      state.host?.remove();
      const host = createControls();
      surface.heading.insertAdjacentElement("afterend", host);
    }
    if (state.sortKey !== "default" && state.catalog && (!state.sortedList || !state.sortedList.isConnected)) {
      renderSortedList();
    }
    updateControls();
  }

  function removePage() {
    state.requestId++;
    state.renderToken++;
    if (state.list?.isConnected) state.list.hidden = false;
    state.sortedList?.remove();
    state.host?.remove();
    state.routeKey = null;
    state.username = null;
    state.heading = null;
    state.list = null;
    state.host = null;
    state.select = null;
    state.directionButton = null;
    state.status = null;
    state.retryButton = null;
    state.sortedList = null;
    state.catalog = null;
    state.catalogSortKey = null;
    state.loading = false;
    state.error = null;
    state.loadPromise = null;
    resetProfileStats();
    document.documentElement.classList.remove(PAGE_CLASS);
  }

  function sync() {
    const route = profileRoute();
    if (!route) {
      if (state.routeKey || state.host || state.profileStatsRouteKey || state.profileStatsHost) removePage();
      return;
    }
    document.documentElement.classList.add(PAGE_CLASS);
    ensureProfileStats(route);
    const surface = findSurface();
    if (!surface) return;
    ensureSurface(route, surface);
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
