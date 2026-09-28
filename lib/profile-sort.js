/* Shared helpers for sorting public Actor cards on an Apify profile page. */
(function () {
  const SORT_OPTIONS = [
    { key: "default", label: "Default order" },
    { key: "runs", label: "Runs" },
    { key: "mau", label: "MAUs" },
    { key: "users", label: "Users" },
    { key: "bookmarks", label: "Bookmarks" },
    { key: "newest", label: "Newest created" },
  ];

  function numberOrNull(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  function actorKey(actor) {
    const username = String(actor?.username || "").trim();
    const name = String(actor?.name || "").trim();
    return username && name ? `${username}/${name}` : actor?.id || "";
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
    };
  }

  function metricValue(actor, key) {
    if (key === "runs") return actor?.runs;
    if (key === "mau") return actor?.mau;
    if (key === "users") return actor?.users;
    if (key === "bookmarks") return actor?.bookmarks;
    if (key === "newest") {
      const timestamp = Date.parse(actor?.createdAt || "");
      return Number.isFinite(timestamp) ? timestamp : -(actor?.index ?? 0);
    }
    return actor?.index ?? 0;
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
    SORT_OPTIONS,
    actorKey,
    aggregateActorStats,
    metricValue,
    normalizeActor,
    normalizeStoreResponse,
    optionLabel,
    responseData,
    sortActors,
    storeItems,
    storeTotal,
  };
})();
