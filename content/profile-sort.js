/* Adds cached profile Actor statistics and on-demand sorting to public profiles. */
(function () {
  const HOST_CLASS = "aap-profile-sort-controls";
  const SORTED_LIST_CLASS = "aap-profile-sorted-list";
  const PROFILE_STATS_HOST_CLASS = "aap-profile-extra-metrics";
  const PAGE_CLASS = "aap-profile-sort-page";
  const PAGE_SIZE = 1000;
  const CATALOG_CACHE_NAME = "profile-catalog";
  const CATALOG_TTL_MS = 15 * 60 * 1000;
  const RANK_METRIC_KEYS = AAP_PROFILE_SORT.RANK_METRIC_KEYS || ["totalUsers", "monthlyUsers", "totalRuns", "monthlyRuns"];
  const NATIVE_METRIC_LABELS = {
    totalUsers: ["total users"],
    monthlyUsers: ["monthly users", "monthly active users"],
  };
  const catalogCache = new Map();
  const catalogFetches = new Map();
  const state = {
    routeKey: null,
    username: null,
    sortKey: "default",
    direction: "desc",
    filterSelect: null,
    filterOperatorSelect: null,
    filterInput: null,
    applyFilterButton: null,
    clearFilterButton: null,
    filter: null,
    filterError: null,
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
    return AAP_PROFILE_SORT.profileRoute(location.pathname);
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

  function normalizedMetricText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function metricLabelMatches(node, labels) {
    const text = normalizedMetricText(node?.textContent);
    return labels.some((label) => text === label || text.endsWith(` ${label}`));
  }

  function findNativeMetricLabel(mount, labels) {
    return [...mount.querySelectorAll("p, span")].find((node) => (
      !node.closest(`.${PROFILE_STATS_HOST_CLASS}`)
      && node.children.length === 0
      && metricLabelMatches(node, labels)
    ));
  }

  function clearNativeMetricDecorations() {
    document.querySelectorAll("[data-aap-profile-native-metric-row]").forEach((row) => {
      row.querySelectorAll("[data-aap-profile-benchmark-tag]").forEach((slot) => slot.remove());
      row.querySelectorAll(".aap-profile-native-metric-label").forEach((label) => {
        label.classList.remove("aap-profile-native-metric-label");
      });
      row.classList.remove("aap-profile-native-metric-row");
      delete row.dataset.aapProfileNativeMetric;
    });
  }

  function decorateNativeMetricRows(mount) {
    for (const [metricKey, labels] of Object.entries(NATIVE_METRIC_LABELS)) {
      const label = findNativeMetricLabel(mount, labels);
      const row = label?.parentElement;
      if (!row || row === mount) continue;
      row.classList.add("aap-profile-native-metric-row");
      row.dataset.aapProfileNativeMetric = metricKey;
      label.classList.add("aap-profile-native-metric-label");
      let slot = row.querySelector(`[data-aap-profile-benchmark-tag="${metricKey}"]`);
      if (!slot) {
        slot = createElement("span", "aap-profile-benchmark-slot aap-profile-benchmark-slot-row");
        slot.dataset.aapProfileBenchmarkTag = metricKey;
        row.appendChild(slot);
      }
    }
  }

  function renderProfileStats() {
    if (!state.profileStatsHost?.isConnected) return;
    const loading = state.profileStatsLoading;
    const error = state.profileStatsError;
    const runMetrics = [
      ["totalRuns", "Total runs", state.profileStats?.totalRuns, "↗"],
      ["monthlyRuns", "Monthly runs", state.profileStats?.monthlyRuns, "↻"],
    ];
    const communityMetrics = [
      [null, "Reviews", state.profileStats?.totalReviews, "☆"],
      [null, "Bookmarks", state.profileStats?.totalBookmarks, "▱"],
    ];
    const createHeading = (text, className) => {
      const heading = createElement("div", className, text);
      heading.setAttribute("role", "heading");
      heading.setAttribute("aria-level", "4");
      return heading;
    };
    const reusableSlots = new Map(
      [...state.profileStatsHost.querySelectorAll("[data-aap-profile-benchmark-tag]")]
        .map((slot) => [slot.dataset.aapProfileBenchmarkTag, slot])
        .filter(([metricKey]) => RANK_METRIC_KEYS.includes(metricKey)),
    );
    const takeRankSlot = (metricKey) => {
      if (!metricKey) return null;
      const slot = reusableSlots.get(metricKey) || createElement("span", "aap-profile-benchmark-slot aap-profile-benchmark-slot-row");
      slot.classList.add("aap-profile-benchmark-slot", "aap-profile-benchmark-slot-row");
      slot.dataset.aapProfileBenchmarkTag = metricKey;
      reusableSlots.delete(metricKey);
      return slot;
    };
    const createRows = (metrics, className) => metrics.map(([metricKey, label, value, icon]) => {
      const row = createElement("div", `aap-profile-run-metric ${className}`.trim());
      const iconElement = createElement("span", "aap-profile-run-metric-icon", icon);
      iconElement.setAttribute("aria-hidden", "true");
      const displayValue = loading ? "Loading…" : error ? "Unavailable" : formatCompact(value);
      const text = createElement("span", "aap-profile-run-metric-text");
      text.append(
        createElement("strong", "aap-profile-run-metric-value", displayValue),
        createElement("span", "aap-profile-run-metric-label", label),
      );
      row.append(iconElement, text);
      const rankSlot = takeRankSlot(metricKey);
      if (rankSlot) row.appendChild(rankSlot);
      if (error) row.title = error;
      return row;
    });
    const headingRow = createElement("div", "aap-profile-run-metric-heading-row");
    headingRow.append(createHeading("Run activity", "aap-profile-run-metric-heading"));
    state.profileStatsHost.replaceChildren(
      headingRow,
      ...createRows(runMetrics, ""),
      createHeading("Community", "aap-profile-community-heading"),
      ...createRows(communityMetrics, "aap-profile-community-metric"),
    );
    state.profileStatsHost.setAttribute("aria-label", "Run activity and community metrics");
    state.profileStatsHost.setAttribute("aria-live", "off");
  }

  function resetProfileStats() {
    clearNativeMetricDecorations();
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

    decorateNativeMetricRows(mount);

    let host = mount.querySelector(`.${PROFILE_STATS_HOST_CLASS}`);
    const hostCreated = !host;
    if (!host) {
      host = createElement("div", PROFILE_STATS_HOST_CLASS);
      mount.appendChild(host);
    }
    state.profileStatsHost = host;
    const hasLegacyBenchmarkRegion = Boolean(host.querySelector("[data-aap-profile-benchmark-details]"));
    const hasRunRankSlots = RANK_METRIC_KEYS
      .filter((metricKey) => metricKey === "totalRuns" || metricKey === "monthlyRuns")
      .every((metricKey) => host.querySelector(`[data-aap-profile-benchmark-tag="${metricKey}"]`));
    if (hostCreated || hasLegacyBenchmarkRegion || !hasRunRankSlots) renderProfileStats();
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

  function filteredActors() {
    if (!state.catalog) return [];
    if (!state.filter) return [...state.catalog];
    return AAP_PROFILE_SORT.filterActors(
      state.catalog,
      state.filter.key,
      state.filter.operator,
      state.filter.threshold,
    );
  }

  function filterDescription(filter) {
    if (!filter) return "";
    return `${AAP_PROFILE_SORT.filterOptionLabel(filter.key)} ${AAP_PROFILE_SORT.filterOperatorLabel(filter.operator)} ${formatCompact(filter.threshold)}`;
  }

  function metricChip(label, value) {
    const chip = createElement("span", "aap-profile-sort-card-chip");
    const valueElement = createElement("span", "aap-profile-sort-card-chip-value", value);
    valueElement.title = String(value);
    chip.append(createElement("span", "aap-profile-sort-card-chip-label", label));
    chip.append(valueElement);
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
    const title = createElement("h3", "aap-profile-sort-card-title", actor.title);
    title.title = actor.title;
    const slugValue = `${actor.username}/${actor.name}`;
    const slug = createElement("code", "aap-profile-sort-card-slug", slugValue);
    slug.title = slugValue;
    titleWrap.append(title, slug);
    header.appendChild(titleWrap);
    if (actor.notice && actor.notice !== "NONE") {
      header.appendChild(createElement("span", "aap-profile-sort-card-notice", actor.notice));
    }
    main.appendChild(header);
    const descriptionValue = actor.description || "No description";
    const description = createElement("p", "aap-profile-sort-card-description", descriptionValue);
    description.title = descriptionValue;
    main.appendChild(description);

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
      metricChip("30d runs", formatCompact(actor.monthlyRuns)),
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
    state.host.dataset.filterActive = state.filter ? "true" : "false";
    state.host.dataset.state = state.loading
      ? "loading"
      : (state.error || state.filterError ? "error" : "ready");
    if (state.filterInput) {
      state.filterInput.setAttribute("aria-invalid", state.filterError ? "true" : "false");
    }
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
    if (state.clearFilterButton) state.clearFilterButton.hidden = !state.filter;
    if (state.applyFilterButton) state.applyFilterButton.disabled = state.loading;
    if (state.loading) {
      setStatus("Loading Actor metrics…");
    } else if (state.filterError) {
      setStatus(state.filterError, true);
    } else if (state.error) {
      setStatus(state.error, true);
    } else if (state.catalog && state.filter) {
      const visibleCount = filteredActors().length;
      setStatus(`${filterDescription(state.filter)} · ${visibleCount.toLocaleString()} of ${state.catalog.length.toLocaleString()} Actors`);
    } else if (state.sortKey === "default") {
      setStatus("Choose a sort or filter the cards by a metric threshold.");
    } else if (state.catalog) {
      const label = AAP_PROFILE_SORT.optionLabel(state.sortKey);
      const missing = state.catalog.filter((actor) => metricValue(actor, state.sortKey) == null).length;
      const suffix = missing ? ` · ${missing} without data at the bottom` : "";
      setStatus(`${label} · ${state.catalog.length.toLocaleString()} Actors${suffix}`);
    }
  }

  function applyFilter() {
    const key = state.filterSelect?.value;
    const operator = state.filterOperatorSelect?.value;
    const rawValue = String(state.filterInput?.value || "").trim();
    const threshold = Number(rawValue);
    if (!rawValue || !Number.isFinite(threshold) || threshold < 0) {
      state.filterError = "Enter a non-negative number to apply this filter.";
      updateControls();
      state.filterInput?.focus();
      return;
    }
    state.filter = { key, operator, threshold };
    state.filterError = null;
    state.error = null;
    requestView();
  }

  function clearFilter() {
    state.filter = null;
    state.filterError = null;
    if (state.filterInput) state.filterInput.value = "";
    if (state.sortKey === "default") restoreOriginal();
    else renderSortedList();
    updateControls();
  }

  function createControls() {
    const host = createElement("div", HOST_CLASS);
    host.setAttribute("role", "region");
    host.setAttribute("aria-label", "Sort and filter public Actors");

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
      if (state.sortKey === "default" && !state.filter) {
        restoreOriginal();
      } else {
        requestView();
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
      requestView(true);
    });

    const filterLabel = createElement("label", "aap-profile-filter-label", "Filter by");
    const filterSelect = createElement("select", "aap-profile-filter-select");
    filterSelect.id = `aap-profile-filter-${Date.now()}`;
    filterLabel.htmlFor = filterSelect.id;
    for (const option of AAP_PROFILE_SORT.FILTER_OPTIONS) {
      filterSelect.appendChild(new Option(option.label, option.key));
    }

    const filterOperatorSelect = createElement("select", "aap-profile-filter-operator");
    filterOperatorSelect.id = `${filterSelect.id}-operator`;
    filterOperatorSelect.setAttribute("aria-label", "Filter condition");
    for (const operator of AAP_PROFILE_SORT.FILTER_OPERATORS) {
      filterOperatorSelect.appendChild(new Option(operator.label, operator.key));
    }

    const filterOperatorLabel = createElement("span", "aap-profile-filter-operator-label", "Condition");
    filterOperatorLabel.setAttribute("aria-hidden", "true");

    const filterInput = createElement("input", "aap-profile-filter-input");
    filterInput.id = `${filterSelect.id}-threshold`;
    filterInput.type = "number";
    filterInput.min = "0";
    filterInput.step = "1";
    filterInput.inputMode = "numeric";
    filterInput.placeholder = "e.g. 100";
    filterInput.setAttribute("aria-label", "Filter threshold");
    const filterThresholdLabel = createElement("label", "aap-profile-filter-threshold-label", "Threshold");
    filterThresholdLabel.htmlFor = filterInput.id;
    if (state.filter) {
      filterSelect.value = state.filter.key;
      filterOperatorSelect.value = state.filter.operator;
      filterInput.value = String(state.filter.threshold);
    }
    filterInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") applyFilter();
    });

    const applyFilterButton = createElement("button", "aap-profile-filter-apply", "Apply filter");
    applyFilterButton.type = "button";
    applyFilterButton.addEventListener("click", applyFilter);

    const clearFilterButton = createElement("button", "aap-profile-filter-clear", "Clear filter");
    clearFilterButton.type = "button";
    clearFilterButton.hidden = true;
    clearFilterButton.addEventListener("click", clearFilter);

    const sortGroup = createElement("div", "aap-profile-sort-group");
    sortGroup.setAttribute("role", "group");
    sortGroup.setAttribute("aria-label", "Sort public Actors");
    sortGroup.append(label, select, directionButton);

    const filterGroup = createElement("div", "aap-profile-filter-group");
    filterGroup.setAttribute("role", "group");
    filterGroup.setAttribute("aria-label", "Filter public Actors");
    filterGroup.append(
      filterLabel,
      filterSelect,
      filterOperatorLabel,
      filterOperatorSelect,
      filterThresholdLabel,
      filterInput,
      applyFilterButton,
      clearFilterButton,
      retryButton,
    );

    const status = createElement("span", "aap-profile-sort-status");
    status.id = `${filterSelect.id}-status`;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    filterInput.setAttribute("aria-describedby", status.id);
    host.append(sortGroup, filterGroup, status);
    state.host = host;
    state.select = select;
    state.directionButton = directionButton;
    state.retryButton = retryButton;
    state.filterSelect = filterSelect;
    state.filterOperatorSelect = filterOperatorSelect;
    state.filterInput = filterInput;
    state.applyFilterButton = applyFilterButton;
    state.clearFilterButton = clearFilterButton;
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
    if (!state.list?.isConnected || !state.catalog || (state.sortKey === "default" && !state.filter)) return;
    state.renderToken++;
    const token = state.renderToken;
    if (state.sortedList) state.sortedList.remove();
    const root = createElement("div", SORTED_LIST_CLASS);
    root.dataset.sortKey = state.sortKey;
    root.dataset.direction = state.direction;
    if (state.filter) root.dataset.filter = filterDescription(state.filter);
    state.sortedList = root;
    state.list.hidden = true;
    state.list.parentNode.insertBefore(root, state.list);
    const items = AAP_PROFILE_SORT.sortActors(filteredActors(), state.sortKey, state.direction);
    if (!items.length) {
      root.appendChild(createElement(
        "p",
        "aap-profile-sort-empty",
        state.filter ? "No public Actors match this filter." : "No public Actors were returned for this profile.",
      ));
      updateControls();
      return;
    }
    setStatus(`Rendering sorted Actors…`);
    appendRenderChunk(items, root, token);
  }

  function catalogCacheScope(routeKey, catalogSortKey) {
    return `profile:${routeKey}:${catalogSortKey}`;
  }

  async function fetchCatalog(route, catalogSortKey = "default", priority = "background", force = false, onProgress) {
    const normalizedSortKey = catalogSortKey === "newest" ? "newest" : "default";
    const cacheKey = `${route.key}:${normalizedSortKey}`;
    const cacheScope = catalogCacheScope(route.key, normalizedSortKey);
    const cached = catalogCache.get(cacheKey);
    if (!force && cached && Date.now() - cached.loadedAt < CATALOG_TTL_MS) return cached.actors;
    const existing = catalogFetches.get(cacheKey);
    if (existing) return existing;

    const operation = (async () => {
      if (!force) {
        try {
          const persisted = await AAP_CACHE.getView(CATALOG_CACHE_NAME, CATALOG_TTL_MS, cacheScope);
          const actors = persisted.hit && Array.isArray(persisted.data?.actors) ? persisted.data.actors : null;
          if (actors) {
            catalogCache.set(cacheKey, { actors, loadedAt: persisted.updatedAt || Date.now() });
            return actors;
          }
        } catch {
          // A view-cache failure should fall through to the live catalog.
        }
      }
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
      // The normalized catalog is much smaller than the raw Store response,
      // so it remains reusable even when the raw response exceeds the API
      // cache's per-entry limit.
      AAP_CACHE.setView(CATALOG_CACHE_NAME, { actors }, cacheScope).catch(() => {});
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
      if (state.sortKey !== "default" || state.filter) renderSortedList();
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

  function requestView(force = false) {
    const route = profileRoute();
    if (!route || (state.sortKey === "default" && !state.filter)) return;
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
      state.filterSelect = null;
      state.filterOperatorSelect = null;
      state.filterInput = null;
      state.applyFilterButton = null;
      state.clearFilterButton = null;
      state.filter = null;
      state.filterError = null;
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
    if ((state.sortKey !== "default" || state.filter) && state.catalog && (!state.sortedList || !state.sortedList.isConnected)) {
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
    state.filterSelect = null;
    state.filterOperatorSelect = null;
    state.filterInput = null;
    state.applyFilterButton = null;
    state.clearFilterButton = null;
    state.filter = null;
    state.filterError = null;
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
