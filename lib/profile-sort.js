/* Shared helpers for sorting public Actor cards on an Apify profile page. */
(function () {
  const SORT_OPTIONS = [
    { key: "default", label: "Default order" },
    { key: "runs", label: "Runs" },
    { key: "monthlyRuns", label: "Monthly runs" },
    { key: "mau", label: "MAUs" },
    { key: "users", label: "Users" },
    { key: "bookmarks", label: "Bookmarks" },
    { key: "newest", label: "Newest created" },
  ];

  const FILTER_OPTIONS = [
    { key: "mau", label: "MAUs" },
    { key: "users", label: "Users" },
    { key: "runs", label: "Runs" },
    { key: "monthlyRuns", label: "Monthly runs" },
    { key: "bookmarks", label: "Bookmarks" },
  ];

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
      monthlyRuns,
      mau,
      users,
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

  function aggregateActorStats(actors) {
    return {
      totalRuns: sumMetric(actors, "runs"),
      monthlyRuns: sumMetric(actors, "monthlyRuns"),
      totalReviews: sumMetric(actors, "actorReviewCount"),
      totalBookmarks: sumMetric(actors, "bookmarks"),
    };
  }

  function metricValue(actor, key) {
    if (key === "runs") return actor?.runs;
    if (key === "monthlyRuns") return actor?.monthlyRuns;
    if (key === "mau") return actor?.mau;
    if (key === "users") return actor?.users;
    if (key === "bookmarks") return actor?.bookmarks;
    if (key === "newest") {
      const timestamp = Date.parse(actor?.createdAt || "");
      return Number.isFinite(timestamp) ? timestamp : -(actor?.index ?? 0);
    }
    return actor?.index ?? 0;
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
    SORT_OPTIONS,
    actorKey,
    aggregateActorStats,
    filterActors,
    filterOperatorLabel,
    filterOptionLabel,
    metricValue,
    normalizeActor,
    normalizeStoreResponse,
    optionLabel,
    profileRoute,
    responseData,
    sortActors,
    storeItems,
    storeTotal,
  };
})();
