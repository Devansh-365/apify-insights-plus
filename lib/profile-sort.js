/* Shared helpers for sorting public Actor cards on an Apify profile page. */
(function () {
  const SORT_OPTIONS = [
    { key: "default", label: "Default order" },
    { key: "runs", label: "Runs" },
    { key: "monthlyRuns", label: "Monthly runs" },
    { key: "mau", label: "MAUs" },
    { key: "users", label: "Users" },
    { key: "users7", label: "7-day users" },
    { key: "users90", label: "90-day users" },
    { key: "bookmarks", label: "Bookmarks" },
    // These follow the Store's own order (`storeSort`), fetched as a separate
    // catalog: Store items carry no update date to sort by locally.
    { key: "newest", label: "Newest created", storeSort: "newest", order: ["Newest first", "Oldest first"] },
    { key: "updated", label: "Recently updated", storeSort: "lastUpdate", order: ["Latest update first", "Oldest update first"] },
  ];

  const FILTER_OPTIONS = [
    { key: "mau", label: "MAUs" },
    { key: "users", label: "Users" },
    { key: "runs", label: "Runs" },
    { key: "monthlyRuns", label: "Monthly runs" },
    { key: "bookmarks", label: "Bookmarks" },
  ];

  const RANK_METRIC_KEYS = ["totalUsers", "monthlyUsers", "totalRuns", "monthlyRuns"];

  const FILTER_OPERATORS = [
    { key: "gte", label: "at least" },
    { key: "gt", label: "more than" },
    { key: "lte", label: "at most" },
    { key: "lt", label: "less than" },
    { key: "eq", label: "exactly" },
  ];

  const PROFILE_ROUTE_EXCLUSIONS = new Set([
    "about", "account", "actors", "admin", "api", "api-reference", "assets", "contact",
    "crawlers", "dashboard", "developers", "docs", "documentation", "downloads", "ext",
    "help", "hiring", "image", "images", "integrations", "job", "jobs", "library",
    "live-status", "login", "logout", "market", "marketplace", "password", "pricing",
    "privacy", "products", "profiles", "release-notes", "request-form", "request-solution",
    "reset-password", "schemas", "settings", "sign-in", "sign-up", "signin", "signup",
    "solutions", "store", "support", "team", "terms", "user", "users",
  ]);

  function numberOrNull(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  function actorKey(actor) {
    const username = String(actor?.username || "").trim();
    const name = String(actor?.name || "").trim();
    return username && name ? `${username}/${name}` : actor?.id || "";
  }

  function profileRoute(pathname = "") {
    const parts = String(pathname || "").split("/").filter(Boolean);
    if (parts.length !== 1 || PROFILE_ROUTE_EXCLUSIONS.has(parts[0].toLowerCase())) return null;
    let username;
    try {
      username = decodeURIComponent(parts[0]);
    } catch {
      return null;
    }
    if (!/^[^/?#\s]+$/.test(username)) return null;
    return { key: username.toLowerCase(), username };
  }

  function normalizeActor(item, index = 0) {
    const stats = item?.stats && typeof item.stats === "object" ? item.stats : {};
    const bookmarks = numberOrNull(stats.bookmarkCount ?? item?.bookmarkCount);
    const runs = numberOrNull(stats.totalRuns);
    const monthlyRuns = numberOrNull(stats.publicActorRunStats30Days?.TOTAL);
    const mau = numberOrNull(stats.totalUsers30Days);
    const users = numberOrNull(stats.totalUsers);
    const users7 = numberOrNull(stats.totalUsers7Days);
    const users90 = numberOrNull(stats.totalUsers90Days);
    return {
      id: item?.id || null,
      name: String(item?.name || item?.id || "").trim(),
      title: String(item?.title || item?.name || item?.id || "Actor").trim(),
      username: String(item?.username || "").trim(),
      description: String(item?.description || "").trim(),
      pictureUrl: item?.pictureUrl || null,
      userPictureUrl: item?.userPictureUrl || null,
      userFullName: String(item?.userFullName || item?.username || "").trim(),
      notice: item?.notice || null,
      actorReviewRating: numberOrNull(item?.actorReviewRating ?? stats.actorReviewRating),
      actorReviewCount: numberOrNull(item?.actorReviewCount ?? stats.actorReviewCount),
      pricingInfo: item?.currentPricingInfo || null,
      createdAt: item?.createdAt || stats.createdAt || null,
      lastRunAt: stats.lastRunStartedAt || stats.lastRunFinishedAt || null,
      runs,
      totalRuns: runs,
      monthlyRuns,
      mau,
      monthlyUsers: mau,
      users,
      totalUsers: users,
      users7,
      users90,
      bookmarks,
      index,
    };
  }

  function responseData(response) {
    return response?.data && typeof response.data === "object" ? response.data : response || {};
  }

  function storeItems(response) {
    const data = responseData(response);
    return Array.isArray(data.items) ? data.items : [];
  }

  function storeTotal(response) {
    const data = responseData(response);
    return numberOrNull(data.total) ?? storeItems(response).length;
  }

  function normalizeStoreResponse(response, startIndex = 0) {
    return storeItems(response).map((item, index) => normalizeActor(item, startIndex + index));
  }

  function sumMetric(actors, key) {
    let total = 0;
    let hasValue = false;
    for (const actor of Array.isArray(actors) ? actors : []) {
      const value = numberOrNull(actor?.[key]);
      if (value == null) continue;
      total += value;
      hasValue = true;
    }
    return hasValue ? total : null;
  }

  // The exact counts behind the profile's rounded "Actor stats" rows, read
  // from the page's embedded Next.js data (escaped inside script strings).
  // Monthly users are distinct developer-wide users, so they cannot be
  // rebuilt by summing Actors. Returns null unless the block is `username`'s.
  function parseDeveloperUserStats(text, username) {
    const source = String(text || "").replace(/\\"/g, '"');
    const wanted = String(username || "").toLowerCase();
    const totals = /"actorsTotalUsers":(\d+)/g;
    let match;
    while ((match = totals.exec(source))) {
      const before = source.slice(Math.max(0, match.index - 20000), match.index);
      const owner = [...before.matchAll(/"username":"([^"]+)"/g)].pop();
      if (!owner || owner[1].toLowerCase() !== wanted) continue;
      const monthly = [...before.matchAll(/"activeUsers30Days":(\d+)/g)].pop();
      return {
        totalUsers: Number(match[1]),
        monthlyUsers: monthly && monthly.index > owner.index ? Number(monthly[1]) : null,
      };
    }
    return null;
  }

  function aggregateActorStats(actors) {
    return {
      totalRuns: sumMetric(actors, "runs"),
      monthlyRuns: sumMetric(actors, "monthlyRuns"),
      totalReviews: sumMetric(actors, "actorReviewCount"),
      totalBookmarks: sumMetric(actors, "bookmarks"),
    };
  }

  // Distinct users over 90 days can never exceed three 30-day counts added
  // up, so 30-day users under a third of 90-day users prove the last month
  // was below the Actor's own monthly average, however often users return.
  // The same holds for 7 against 30 days. The ratio says how far below.
  function userTrend(actor) {
    const users = numberOrNull(actor?.users);
    const users90 = numberOrNull(actor?.users90);
    const mau = numberOrNull(actor?.mau);
    const users7 = numberOrNull(actor?.users7);
    // Every user arrived in the last 90 days: a launch, with no past to compare.
    const isNew = users > 0 && users90 != null && users90 >= users;
    const month = !isNew && users90 >= 20 && mau != null ? mau / (users90 / 3) - 1 : null;
    const week = !isNew && mau >= 10 && users7 != null ? users7 / (mau * 7 / 30) - 1 : null;
    return { isNew, month, week };
  }

  // A real drop is at least a quarter below the average period.
  const DROP_THRESHOLD = -0.25;

  // The stronger of the two drops, for the card: { window, change }.
  function userDrop(actor) {
    const { month, week } = userTrend(actor);
    const drops = [
      month != null && month <= DROP_THRESHOLD ? { window: "30 days", change: month } : null,
      week != null && week <= DROP_THRESHOLD ? { window: "7 days", change: week } : null,
    ].filter(Boolean);
    return drops.sort((left, right) => left.change - right.change)[0] || null;
  }

  function needsFixing(actor) {
    const lowRating = actor?.actorReviewCount >= 3 && actor?.actorReviewRating != null && actor.actorReviewRating < 4;
    return actor?.notice === "UNDER_MAINTENANCE" || lowRating;
  }

  // One-click answers to the questions a portfolio owner asks most, each a
  // fixed filter plus the order that answers it best.
  const VIEWS = [
    {
      key: "all",
      label: "All Actors",
      description: "Every public Actor, in Apify's order",
      match: () => true,
    },
    {
      key: "top",
      label: "Most used",
      description: "Most users in the last 30 days first",
      sortKey: "mau",
      match: (actor) => actor.mau > 0,
    },
    {
      key: "losing",
      label: "Losing users",
      description: "25%+ below their own average (last 30 days vs 90, or 7 vs 30). Biggest audience first",
      sortKey: "users90",
      chip: "drop",
      tone: "warning",
      match: (actor) => Boolean(userDrop(actor)),
    },
    {
      key: "fix",
      label: "Needs fixing",
      description: "Under maintenance, or rated under 4 with 3+ reviews. Most used first",
      sortKey: "mau",
      chip: "health",
      tone: "danger",
      match: needsFixing,
    },
    {
      key: "new",
      label: "New launches",
      description: "All users arrived in the last 90 days. Most used first",
      sortKey: "mau",
      chip: "week",
      match: (actor) => userTrend(actor).isNew,
    },
    {
      key: "inactive",
      label: "No users this month",
      description: "No users in 30 days. Biggest past audience first",
      sortKey: "users",
      match: (actor) => actor.mau === 0,
    },
  ];

  function viewFor(key) {
    return VIEWS.find((view) => view.key === key) || VIEWS[0];
  }

  function viewActors(actors, key) {
    const view = viewFor(key);
    return (Array.isArray(actors) ? actors : []).filter((actor) => view.match(actor));
  }

  function viewCounts(actors) {
    return Object.fromEntries(VIEWS.map((view) => [view.key, viewActors(actors, view.key).length]));
  }

  // Share of the Actors' summed monthly users held by the top `count`.
  // Users of several Actors count once per Actor.
  function topShare(actors, count = 10) {
    const values = (Array.isArray(actors) ? actors : [])
      .map((actor) => numberOrNull(actor?.mau) || 0)
      .sort((left, right) => right - left);
    const total = values.reduce((sum, value) => sum + value, 0);
    if (!total || values.length <= count) return null;
    return values.slice(0, count).reduce((sum, value) => sum + value, 0) / total;
  }

  function metricValue(actor, key) {
    if (key === "runs") return actor?.runs;
    if (key === "monthlyRuns") return actor?.monthlyRuns;
    if (key === "mau") return actor?.mau;
    if (key === "users") return actor?.users;
    if (key === "users7") return actor?.users7;
    if (key === "users90") return actor?.users90;
    if (key === "bookmarks") return actor?.bookmarks;
    if (key === "newest") {
      const timestamp = Date.parse(actor?.createdAt || "");
      return Number.isFinite(timestamp) ? timestamp : -(actor?.index ?? 0);
    }
    if (key === "updated") return -(actor?.index ?? 0);
    return actor?.index ?? 0;
  }

  // The Store-ordered catalog a sort needs: "default" unless the sort follows
  // the Store's own order.
  function catalogOrder(key) {
    return SORT_OPTIONS.find((option) => option.key === key && option.storeSort)?.key || "default";
  }

  function storeSortFor(catalogKey) {
    return SORT_OPTIONS.find((option) => option.key === catalogKey)?.storeSort;
  }

  // "Newest first"-style labels for a date-ordered sort, else null.
  function orderLabels(key) {
    return SORT_OPTIONS.find((option) => option.key === key)?.order || null;
  }

  function filterOptionLabel(key) {
    return FILTER_OPTIONS.find((option) => option.key === key)?.label || "Metric";
  }

  function filterOperatorLabel(key) {
    return FILTER_OPERATORS.find((operator) => operator.key === key)?.label || "at least";
  }

  function filterActors(actors, key, operator, threshold) {
    const numericThreshold = Number(threshold);
    if (!FILTER_OPTIONS.some((option) => option.key === key) || !Number.isFinite(numericThreshold)) return [];
    return (Array.isArray(actors) ? actors : []).filter((actor) => {
      const value = metricValue(actor, key);
      if (value == null) return false;
      if (operator === "gt") return value > numericThreshold;
      if (operator === "lte") return value <= numericThreshold;
      if (operator === "lt") return value < numericThreshold;
      if (operator === "eq") return value === numericThreshold;
      return value >= numericThreshold;
    });
  }

  function compareText(left, right) {
    return String(left || "").localeCompare(String(right || ""), undefined, { sensitivity: "base" });
  }

  function sortActors(actors, key = "default", direction = "desc") {
    const sorted = [...(Array.isArray(actors) ? actors : [])];
    if (key === "default") return sorted.sort((left, right) => left.index - right.index);

    const multiplier = direction === "asc" ? 1 : -1;
    return sorted.sort((left, right) => {
      const leftValue = metricValue(left, key);
      const rightValue = metricValue(right, key);
      const leftMissing = leftValue == null;
      const rightMissing = rightValue == null;
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
      if (!leftMissing && leftValue !== rightValue) return (leftValue - rightValue) * multiplier;
      return compareText(left.title, right.title) || left.index - right.index;
    });
  }

  function optionLabel(key) {
    return SORT_OPTIONS.find((option) => option.key === key)?.label || "Default order";
  }

  self.AAP_PROFILE_SORT = {
    FILTER_OPERATORS,
    FILTER_OPTIONS,
    RANK_METRIC_KEYS,
    SORT_OPTIONS,
    VIEWS,
    actorKey,
    aggregateActorStats,
    catalogOrder,
    filterActors,
    filterOperatorLabel,
    filterOptionLabel,
    metricValue,
    normalizeActor,
    normalizeStoreResponse,
    optionLabel,
    orderLabels,
    parseDeveloperUserStats,
    profileRoute,
    responseData,
    sortActors,
    storeItems,
    storeSortFor,
    storeTotal,
    topShare,
    userDrop,
    userTrend,
    viewActors,
    viewCounts,
    viewFor,
  };
})();
