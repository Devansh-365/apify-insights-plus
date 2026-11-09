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
    clearFilterButton: null,
    filter: null,
    filterError: null,
    view: "all",
    viewButtons: null,
    filterToggle: null,
    filterGroup: null,
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
    profileStatsLoadedAt: 0,
    profileUserStats: null,
    profileUserStatsPromise: null,
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
    if (!(self.AAP_FEATURES?.enabled("profileSort") ?? true)) return null;
    return AAP_CONTEXT.isPublicSite() ? AAP_PROFILE_SORT.profileRoute(location.pathname) : null;
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

  // Apify's own value node, e.g. "6.6K" in "6.6K total users".
  function nativeValueNode(label) {
    return [...label.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.nodeValue.trim());
  }

  // Swaps the rounded value for the exact count in place, so the row keeps
  // Apify's own markup; React can still update the same text node.
  function showExactNativeValue(label, metricKey) {
    const exact = state.profileUserStats?.[metricKey];
    const node = nativeValueNode(label);
    if (exact == null || !node) return;
    const text = AAPF.count(exact);
    if (node.nodeValue === text) return;
    if (!/^[\d.,]+\s*[KMB]?$/i.test(node.nodeValue.trim())) return;
    label.dataset.aapCompactValue = node.nodeValue;
    node.nodeValue = text;
    label.title = `Exact count. Apify rounds it to ${label.dataset.aapCompactValue.trim()}.`;
  }

  function restoreNativeValue(label) {
    const node = nativeValueNode(label);
    if (node && label.dataset.aapCompactValue != null) node.nodeValue = label.dataset.aapCompactValue;
    delete label.dataset.aapCompactValue;
    label.removeAttribute("title");
  }

  function clearNativeMetricDecorations() {
    document.querySelectorAll("[data-aap-profile-native-metric]").forEach((row) => {
      row.querySelectorAll("[data-aap-profile-benchmark-tag]").forEach((slot) => slot.remove());
      row.querySelectorAll(".aap-profile-native-metric-label").forEach((label) => {
        restoreNativeValue(label);
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
      showExactNativeValue(label, metricKey);
      let slot = row.querySelector(`[data-aap-profile-benchmark-tag="${metricKey}"]`);
      if (!slot) {
        slot = createElement("span", "aap-profile-benchmark-slot aap-profile-benchmark-slot-row");
        slot.dataset.aapProfileBenchmarkTag = metricKey;
        row.appendChild(slot);
      }
    }
  }

  // Stroke icons drawn on the same 20px grid as Apify's own profile metric icons.
  const METRIC_ICON_PATHS = {
    trend: "M2.5 14.167 7.5 9.167l3.333 3.333L17.5 5.833M12.5 5.833h5v5",
    calendar: "M3.333 7.5h13.334M6.667 2.5v3.333M13.333 2.5v3.333M4.167 4.167h11.666c.46 0 .834.373.834.833v10.833c0 .46-.373.834-.834.834H4.167a.833.833 0 0 1-.834-.834V5c0-.46.373-.833.834-.833",
    star: "m10 2.5 2.318 4.697 5.182.753-3.75 3.655.885 5.162L10 14.33l-4.635 2.437.885-5.162L2.5 7.95l5.182-.753z",
    bookmark: "M5 3.333c0-.46.373-.833.833-.833h8.334c.46 0 .833.373.833.833V17.5L10 14.167 5 17.5z",
  };

  function metricIcon(name) {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("fill", "none");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", METRIC_ICON_PATHS[name] || "");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.667");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  function renderProfileStats() {
    if (!state.profileStatsHost?.isConnected) return;
    const loading = state.profileStatsLoading;
    const error = state.profileStatsError;
    const runMetrics = [
      ["totalRuns", "Total runs", state.profileStats?.totalRuns, "trend"],
      ["monthlyRuns", "Monthly runs", state.profileStats?.monthlyRuns, "calendar"],
    ];
    const communityMetrics = [
      [null, "Reviews", state.profileStats?.totalReviews, "star"],
      [null, "Bookmarks", state.profileStats?.totalBookmarks, "bookmark"],
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
      const iconElement = createElement("span", "aap-profile-run-metric-icon");
      iconElement.setAttribute("aria-hidden", "true");
      iconElement.appendChild(metricIcon(icon));
      // Saved numbers stay on screen while a fresh copy loads or if it fails.
      const displayValue = state.profileStats ? formatCompact(value) : loading ? "Loading…" : error ? "Unavailable" : formatCompact(value);
      const text = createElement("span", "aap-profile-run-metric-text");
      text.append(
        createElement("strong", "aap-profile-run-metric-value", displayValue),
        createElement("span", "aap-profile-run-metric-label", label),
      );
      row.append(iconElement, text);
      const rankSlot = takeRankSlot(metricKey);
      if (rankSlot) row.appendChild(rankSlot);
      if (error) row.title = state.profileStats ? `Could not refresh: ${error}` : error;
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
    state.profileStatsLoadedAt = 0;
    state.profileUserStats = null;
    state.profileUserStatsPromise = null;
  }

  // The profile page embeds its exact user counts. A full page load has them
  // in its own scripts; after in-app navigation those scripts belong to the
  // first profile, so the new profile's page is fetched instead.
  async function fetchDeveloperUserStats(route) {
    for (const script of document.scripts) {
      const text = script.textContent;
      if (!text.includes("actorsTotalUsers")) continue;
      const stats = AAP_PROFILE_SORT.parseDeveloperUserStats(text, route.username);
      if (stats) return stats;
    }
    const response = await fetch(`/${encodeURIComponent(route.username)}`, {
      credentials: "omit",
      headers: { Accept: "text/html" },
    });
    if (!response.ok) throw new Error(`Profile page request failed: HTTP ${response.status}`);
    return AAP_PROFILE_SORT.parseDeveloperUserStats(await response.text(), route.username);
  }

  function loadDeveloperUserStats(route) {
    if (state.profileUserStats || state.profileUserStatsPromise) return;
    const operation = fetchDeveloperUserStats(route)
      .then((stats) => {
        if (state.profileStatsRouteKey !== route.key || !stats) return;
        state.profileUserStats = stats;
        const mount = findProfileStatsMount();
        if (mount) decorateNativeMetricRows(mount);
      })
      // Without exact counts, Apify's rounded values simply stay.
      .catch(() => {});
    state.profileUserStatsPromise = operation;
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
        if (!state.profileStats) {
          const saved = await savedCatalog(route);
          if (saved && state.profileStatsRouteKey === route.key) {
            state.profileStats = AAP_PROFILE_SORT.aggregateActorStats(saved);
            renderProfileStats();
          }
        }
        const actors = await fetchCatalog(route, "default", "background");
        if (state.profileStatsRouteKey !== route.key) return;
        state.profileStats = AAP_PROFILE_SORT.aggregateActorStats(actors);
        state.profileStatsLoadedAt = catalogCache.get(`${route.key}:default`)?.loadedAt ?? Date.now();
        // The same catalog counts the quick views.
        updateControls();
      } catch (error) {
        if (state.profileStatsRouteKey !== route.key) return;
        state.profileStatsError = AAPF.errorText(error, "Profile run statistics could not be loaded.");
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

    loadDeveloperUserStats(route);
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
    // Refresh while the profile stays open, once the shown catalog expires.
    const due = state.profileStatsLoadedAt && Date.now() - state.profileStatsLoadedAt >= CATALOG_TTL_MS;
    if (!state.profileStatsLoading && (due || (!state.profileStats && !state.profileStatsError))) loadProfileStats(route);
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
    if (key === "newest") return formatCreatedAt(actor);
    // The Store gives no update date, only the order: show the place in it.
    if (key === "updated") return actor?.index === 0 ? "Latest" : `#${(actor?.index ?? 0) + 1}`;
    return formatCompact(metricValue(actor, key));
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

  // Whether the cards differ from Apify's own list at all.
  function isCustomized() {
    return state.sortKey !== "default" || Boolean(state.filter) || state.view !== "all";
  }

  function filteredActors() {
    if (!state.catalog) return [];
    const inView = AAP_PROFILE_SORT.viewActors(state.catalog, state.view);
    if (!state.filter) return inView;
    return AAP_PROFILE_SORT.filterActors(
      inView,
      state.filter.key,
      state.filter.operator,
      state.filter.threshold,
    );
  }

  // Any loaded catalog counts the views; the profile stats load one early.
  function countingCatalog() {
    return state.catalog || catalogCache.get(`${state.routeKey}:default`)?.actors || null;
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

  function viewChip(actor) {
    const kind = AAP_PROFILE_SORT.viewFor(state.view).chip;
    if (kind === "drop") {
      const drop = AAP_PROFILE_SORT.userDrop(actor);
      if (!drop) return null;
      const chip = metricChip(`Last ${drop.window}`, `−${Math.round(-drop.change * 100)}% vs avg`);
      chip.title = `At least ${Math.round(-drop.change * 100)}% fewer users in the last ${drop.window} than the Actor's average for that length of time.`;
      return chip;
    }
    if (kind === "health") {
      if (actor.notice === "UNDER_MAINTENANCE") return metricChip("Status", "Under maintenance");
      return metricChip("Rating", `${actor.actorReviewRating.toFixed(1)} (${actor.actorReviewCount} reviews)`);
    }
    if (kind === "week") return metricChip("7-day users", formatCompact(actor.users7));
    return null;
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
      // A view shows the number that put the Actor in it.
      viewChip(actor) || metricChip("Pricing", pricingLabel(actor)),
      state.sortKey === "mau" ? metricChip("Users", formatCompact(actor.users)) : metricChip("MAU", formatCompact(actor.mau)),
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

  // `detail` follows the main text in quieter type.
  function setStatus(text, isError = false, detail = "") {
    if (!state.status) return;
    if (detail) {
      state.status.replaceChildren(
        createElement("strong", "aap-profile-sort-status-main", text),
        createElement("span", "aap-profile-sort-status-detail", detail),
      );
    } else {
      state.status.textContent = text || "";
    }
    state.status.classList.toggle("aap-profile-sort-status-error", isError);
  }

  // Apify's list styles set `display`, which beats the hidden attribute, and
  // its virtualized rows would keep drawing over the sorted cards.
  function setNativeListHidden(hidden) {
    if (!state.list?.isConnected) return;
    state.list.hidden = hidden;
    state.list.toggleAttribute("data-aap-profile-native-hidden", hidden);
  }

  function updateControls() {
    if (!state.host) return;
    state.host.setAttribute("aria-busy", state.loading ? "true" : "false");
    state.host.dataset.filterActive = state.filter || state.view !== "all" ? "true" : "false";
    const counts = countingCatalog() ? AAP_PROFILE_SORT.viewCounts(countingCatalog()) : null;
    for (const [key, button] of state.viewButtons || []) {
      button.setAttribute("aria-pressed", key === state.view ? "true" : "false");
      const count = button.querySelector(".aap-profile-view-count");
      count.textContent = counts ? counts[key].toLocaleString() : "";
      count.hidden = !counts;
      // Views that call for action stand out while they have Actors in them.
      const tone = AAP_PROFILE_SORT.viewFor(key).tone;
      if (tone && counts?.[key] > 0) button.dataset.tone = tone;
      else delete button.dataset.tone;
    }
    if (state.filterToggle) {
      state.filterToggle.setAttribute("aria-expanded", state.filterGroup.hidden ? "false" : "true");
      state.filterToggle.textContent = state.filter ? "Custom filter · on" : "Custom filter";
    }
    state.host.dataset.state = state.loading
      ? "loading"
      : (state.error || state.filterError ? "error" : "ready");
    if (state.filterInput) {
      state.filterInput.setAttribute("aria-invalid", state.filterError ? "true" : "false");
    }
    if (state.select) state.select.value = state.sortKey;
    if (state.directionButton) {
      const [first, last] = AAP_PROFILE_SORT.orderLabels(state.sortKey) || ["High → low", "Low → high"];
      const [current, other] = state.direction === "desc" ? [first, last] : [last, first];
      state.directionButton.textContent = current;
      state.directionButton.setAttribute("aria-label", `${current.replace("→", "to")}; switch to ${other.replace("→", "to").toLowerCase()}`);
      state.directionButton.disabled = state.sortKey === "default";
    }
    if (state.retryButton) state.retryButton.hidden = !state.error;
    if (state.clearFilterButton) state.clearFilterButton.hidden = !state.filter;
    if (state.loading) {
      setStatus("Loading Actor metrics…");
    } else if (state.filterError) {
      setStatus(state.filterError, true);
    } else if (state.error) {
      setStatus(state.error, true);
    } else if (state.catalog && (state.filter || state.view !== "all")) {
      const view = AAP_PROFILE_SORT.viewFor(state.view);
      const share = state.view === "top" ? AAP_PROFILE_SORT.topShare(state.catalog) : null;
      const details = [
        state.view !== "all" ? view.description : null,
        share == null ? null : `Top 10 hold ${Math.round(share * 100)}% of monthly users`,
        state.filter ? filterDescription(state.filter) : null,
      ];
      setStatus(
        `${filteredActors().length.toLocaleString()} of ${state.catalog.length.toLocaleString()} Actors`,
        false,
        details.filter(Boolean).join(" · "),
      );
    } else if (state.sortKey === "default") {
      setStatus("Pick a view to answer a question in one click, or sort by any metric.");
    } else if (state.catalog) {
      const label = AAP_PROFILE_SORT.optionLabel(state.sortKey);
      const missing = state.catalog.filter((actor) => metricValue(actor, state.sortKey) == null).length;
      const suffix = missing ? ` · ${missing} without data at the bottom` : "";
      setStatus(`${label} · ${state.catalog.length.toLocaleString()} Actors${suffix}`);
    }
  }

  // Shows the cards for the current view, sort, and filter, or Apify's own
  // list when none of them changes anything.
  function showCurrentView() {
    if (isCustomized()) requestView();
    else restoreOriginal();
  }

  // The custom filter applies as it is typed; an empty threshold removes it.
  function applyFilter() {
    const key = state.filterSelect?.value;
    const operator = state.filterOperatorSelect?.value;
    const rawValue = String(state.filterInput?.value || "").trim();
    const threshold = Number(rawValue);
    if (!rawValue) {
      if (state.filter || state.filterError) clearFilter();
      return;
    }
    if (!Number.isFinite(threshold) || threshold < 0) {
      state.filterError = "Enter a number of 0 or more.";
      updateControls();
      return;
    }
    state.filter = { key, operator, threshold };
    state.filterError = null;
    state.error = null;
    showCurrentView();
  }

  function clearFilter() {
    state.filter = null;
    state.filterError = null;
    if (state.filterInput) state.filterInput.value = "";
    showCurrentView();
    updateControls();
  }

  // A view sets its own sort; "All Actors" returns to Apify's order.
  function selectView(key) {
    const view = AAP_PROFILE_SORT.viewFor(key);
    state.view = view.key;
    state.sortKey = view.sortKey || "default";
    state.direction = "desc";
    state.error = null;
    showCurrentView();
    updateControls();
  }

  function resetView() {
    state.filter = null;
    state.filterError = null;
    if (state.filterInput) state.filterInput.value = "";
    selectView("all");
  }

  function createControls() {
    const host = createElement("div", HOST_CLASS);
    host.setAttribute("role", "region");
    host.setAttribute("aria-label", "Sort and filter public Actors");

    const label = createElement("label", "aap-profile-sort-label", "Sort by");
    const select = createElement("select", "aap-profile-sort-select");
    select.id = `aap-profile-sort-${Date.now()}`;
    label.htmlFor = select.id;
    for (const option of AAP_PROFILE_SORT.SORT_OPTIONS) {
      select.appendChild(new Option(option.label, option.key));
    }
    select.addEventListener("change", () => {
      state.sortKey = select.value;
      state.error = null;
      showCurrentView();
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
    let filterTimer = null;
    filterInput.addEventListener("input", () => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(applyFilter, 300);
    });
    filterInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      clearTimeout(filterTimer);
      applyFilter();
    });
    for (const control of [filterSelect, filterOperatorSelect]) {
      control.addEventListener("change", () => {
        if (String(filterInput.value).trim()) applyFilter();
      });
    }

    const clearFilterButton = createElement("button", "aap-profile-filter-clear", "Clear filter");
    clearFilterButton.type = "button";
    clearFilterButton.hidden = true;
    clearFilterButton.addEventListener("click", clearFilter);

    const viewGroup = createElement("div", "aap-profile-view-group");
    viewGroup.setAttribute("role", "group");
    viewGroup.setAttribute("aria-label", "Quick views");
    const viewButtons = new Map();
    for (const view of AAP_PROFILE_SORT.VIEWS) {
      const button = createElement("button", "aap-profile-view");
      button.type = "button";
      button.title = view.description;
      button.setAttribute("aria-pressed", view.key === state.view ? "true" : "false");
      const count = createElement("span", "aap-profile-view-count");
      count.hidden = true;
      button.append(createElement("span", "aap-profile-view-label", view.label), count);
      button.addEventListener("click", () => (view.key === "all" ? resetView() : selectView(view.key)));
      viewButtons.set(view.key, button);
      viewGroup.appendChild(button);
    }

    const filterToggle = createElement("button", "aap-profile-filter-toggle", "Custom filter");
    filterToggle.type = "button";

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
      clearFilterButton,
    );
    filterGroup.id = `${filterSelect.id}-group`;
    filterGroup.hidden = !state.filter;
    filterToggle.setAttribute("aria-controls", filterGroup.id);
    filterToggle.addEventListener("click", () => {
      filterGroup.hidden = !filterGroup.hidden;
      updateControls();
      if (!filterGroup.hidden) filterInput.focus();
    });
    sortGroup.append(filterToggle, retryButton);

    const status = createElement("span", "aap-profile-sort-status");
    status.id = `${filterSelect.id}-status`;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    filterInput.setAttribute("aria-describedby", status.id);
    host.append(viewGroup, sortGroup, filterGroup, status);
    state.viewButtons = viewButtons;
    state.filterToggle = filterToggle;
    state.filterGroup = filterGroup;
    state.host = host;
    state.select = select;
    state.directionButton = directionButton;
    state.retryButton = retryButton;
    state.filterSelect = filterSelect;
    state.filterOperatorSelect = filterOperatorSelect;
    state.filterInput = filterInput;
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
    setNativeListHidden(false);
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
    if (!state.list?.isConnected || !state.catalog || !isCustomized()) return;
    state.renderToken++;
    const token = state.renderToken;
    if (state.sortedList) state.sortedList.remove();
    const root = createElement("div", SORTED_LIST_CLASS);
    root.dataset.sortKey = state.sortKey;
    root.dataset.direction = state.direction;
    if (state.filter) root.dataset.filter = filterDescription(state.filter);
    state.sortedList = root;
    setNativeListHidden(true);
    state.list.parentNode.insertBefore(root, state.list);
    const items = AAP_PROFILE_SORT.sortActors(filteredActors(), state.sortKey, state.direction);
    if (!items.length) {
      root.appendChild(createElement(
        "p",
        "aap-profile-sort-empty",
        state.filter || state.view !== "all" ? "No public Actors match this view." : "No public Actors were returned for this profile.",
      ));
      updateControls();
      return;
    }
    setStatus(`Rendering sorted Actors…`);
    appendRenderChunk(items, root, token);
  }

  function catalogCacheScope(routeKey, catalogSortKey) {
    // v2: Actors carry 7- and 90-day user counts.
    return `profile:v2:${routeKey}:${catalogSortKey}`;
  }

  // The last saved catalog at any age, for painting before a refresh.
  async function savedCatalog(route) {
    const cached = catalogCache.get(`${route.key}:default`);
    if (cached) return cached.actors;
    try {
      const persisted = await AAP_CACHE.getView(CATALOG_CACHE_NAME, CATALOG_TTL_MS, catalogCacheScope(route.key, "default"));
      return persisted.hit && Array.isArray(persisted.data?.actors) ? persisted.data.actors : null;
    } catch {
      return null;
    }
  }

  async function fetchCatalog(route, catalogSortKey = "default", priority = "background", force = false, onProgress) {
    const normalizedSortKey = AAP_PROFILE_SORT.catalogOrder(catalogSortKey);
    const cacheKey = `${route.key}:${normalizedSortKey}`;
    const cacheScope = catalogCacheScope(route.key, normalizedSortKey);
    const cached = catalogCache.get(cacheKey);
    if (!force && cached && Date.now() - cached.loadedAt < CATALOG_TTL_MS) return cached.actors;
    const existing = catalogFetches.get(cacheKey);
    if (existing) return existing;

    const operation = (async () => {
      let saved = null;
      if (!force) {
        try {
          const persisted = await AAP_CACHE.getView(CATALOG_CACHE_NAME, CATALOG_TTL_MS, cacheScope);
          const actors = persisted.hit && Array.isArray(persisted.data?.actors) ? persisted.data.actors : null;
          if (actors && !persisted.stale) {
            catalogCache.set(cacheKey, { actors, loadedAt: persisted.updatedAt || Date.now() });
            return actors;
          }
          // An expired copy is only a fallback if the live catalog fails.
          saved = actors;
        } catch {
          // A view-cache failure should fall through to the live catalog.
        }
      }
      const actors = [];
      try {
        let offset = 0;
        let total = null;
        do {
          if (onProgress) onProgress(actors.length);
          // This catalog is cached above, so skip the request cache: its
          // stale-while-revalidate copy could be up to an hour old.
          const response = await AAP_API.publicActorStore(route.username, {
            limit: PAGE_SIZE,
            offset,
            sortBy: AAP_PROFILE_SORT.storeSortFor(normalizedSortKey),
            priority,
            cacheMode: "no-store",
          });
          const page = AAP_PROFILE_SORT.normalizeStoreResponse(response, offset);
          total = AAP_PROFILE_SORT.storeTotal(response);
          actors.push(...page);
          if (!page.length) break;
          offset += page.length;
        } while (offset < total);
      } catch (error) {
        if (saved) return saved;
        throw error;
      }
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
    const catalogSortKey = AAP_PROFILE_SORT.catalogOrder(state.sortKey);
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
      if (isCustomized()) renderSortedList();
    } catch (error) {
      if (requestId !== state.requestId || state.routeKey !== route.key) return;
      state.error = AAPF.errorText(error, "Actor metrics could not be loaded.");
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
    if (!route || !isCustomized()) return;
    // Metric sorts work on any catalog; Store-ordered sorts and the default
    // order (a filter alone) need the catalog in that order.
    const wanted = AAP_PROFILE_SORT.catalogOrder(state.sortKey);
    const needsCatalog = (wanted !== "default" || state.sortKey === "default") && state.catalogSortKey !== wanted;
    if (state.catalog && !force && !needsCatalog) {
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
      setNativeListHidden(false);
      state.requestId++;
      state.routeKey = route.key;
      state.username = route.username;
      state.sortKey = "default";
      state.direction = "desc";
      state.filterSelect = null;
      state.filterOperatorSelect = null;
      state.filterInput = null;
      state.clearFilterButton = null;
      state.filter = null;
      state.filterError = null;
      state.view = "all";
      state.viewButtons = null;
      state.filterToggle = null;
      state.filterGroup = null;
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
      // Counts the quick views; shares the profile stats' cached request.
      fetchCatalog(route, "default", "background").then(() => updateControls()).catch(() => {});
    }
    if (isCustomized() && state.catalog && (!state.sortedList || !state.sortedList.isConnected)) {
      renderSortedList();
    }
    updateControls();
  }

  function removePage() {
    state.requestId++;
    state.renderToken++;
    setNativeListHidden(false);
    state.sortedList?.remove();
    state.host?.remove();
    state.routeKey = null;
    state.username = null;
    state.filterSelect = null;
    state.filterOperatorSelect = null;
    state.filterInput = null;
    state.clearFilterButton = null;
    state.filter = null;
    state.filterError = null;
    state.view = "all";
    state.viewButtons = null;
    state.filterToggle = null;
    state.filterGroup = null;
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
  self.AAP_FEATURES?.onChange(sync);
  const poll = AAP_LIFECYCLE.every(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      sync();
      return;
    }
    sync();
  }, 500);
  window.addEventListener("beforeunload", () => clearInterval(poll));
})();
