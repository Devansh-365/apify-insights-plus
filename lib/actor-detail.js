/* Normalizes the public Actor response used by the Actor detail overlay. */
(function () {
  const STATUS_KEYS = [
    { key: "SUCCEEDED", label: "Succeeded", color: "#10b981" },
    { key: "FAILED", label: "Failed", color: "#ef4444" },
    { key: "ABORTED", label: "Aborted", color: "#f59e0b" },
    { key: "TIMED-OUT", label: "Timed out", color: "#8b5cf6" },
  ];

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  function latestDate(values) {
    return values
      .filter((value) => typeof value === "string" && !Number.isNaN(Date.parse(value)))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
  }

  function dailyRunCount(value) {
    if (value && typeof value === "object") {
      const total = value.TOTAL ?? value.total ?? value.runs ?? value.count ?? value.value;
      if (total != null) return number(total);
      return ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT", "TIMED_OUT"]
        .reduce((sum, key) => sum + number(value[key]), 0);
    }
    return number(value);
  }

  function normalizeDailyRuns(actor, stats) {
    const source = [
      stats.publicActorDailyRunStats30Days,
      stats.publicActorRunStatsByDay,
      stats.dailyRunStats30Days,
      stats.dailyRuns30Days,
      actor.dailyRuns,
    ].find((value) => Array.isArray(value) || (value && typeof value === "object"));
    if (!source) return [];

    const rows = Array.isArray(source)
      ? source.map((entry) => ({
        date: entry?.date || entry?.day || entry?.key,
        runs: dailyRunCount(entry),
      }))
      : Object.entries(source).map(([date, value]) => ({ date, runs: dailyRunCount(value) }));
    const byDay = new Map();
    for (const row of rows) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.date || ""))) continue;
      const date = String(row.date);
      const runs = number(row.runs);
      // Duplicate rows can appear when a backend response contains a status
      // breakdown as well as a total. Keep the largest value for that day so
      // the chart never inflates the published total.
      byDay.set(date, Math.max(byDay.get(date) || 0, runs));
    }
    return [...byDay.entries()]
      .map(([date, runs]) => ({ date, runs }))
      .sort((left, right) => left.date.localeCompare(right.date));
  }

  function normalize(raw) {
    const actor = raw?.data && typeof raw.data === "object" ? raw.data : raw || {};
    const stats = actor.stats && typeof actor.stats === "object" ? actor.stats : {};
    const rawRunStats = stats.publicActorRunStats30Days && typeof stats.publicActorRunStats30Days === "object"
      ? stats.publicActorRunStats30Days
      : {};
    const runStats = {
      SUCCEEDED: number(rawRunStats.SUCCEEDED),
      FAILED: number(rawRunStats.FAILED),
      ABORTED: number(rawRunStats.ABORTED),
      "TIMED-OUT": number(rawRunStats["TIMED-OUT"] ?? rawRunStats.TIMED_OUT),
    };
    const statusTotal = Object.values(runStats).reduce((sum, value) => sum + value, 0);
    const pricingUpdatedAt = latestDate(
      (Array.isArray(actor.pricingInfos) ? actor.pricingInfos : [])
        .flatMap((pricing) => [pricing?.updatedAt, pricing?.createdAt, pricing?.startedAt]),
    );

    return {
      id: actor.id || null,
      name: actor.name || null,
      username: actor.username || null,
      title: actor.title || actor.name || actor.id || "Actor",
      activeUsers30Days: number(stats.totalUsers30Days),
      runs30Days: number(rawRunStats.TOTAL) || statusTotal,
      totalRuns: number(stats.totalRuns ?? actor.totalRuns),
      createdAt: actor.createdAt || null,
      pricingUpdatedAt,
      lastRunAt: stats.lastRunStartedAt || stats.lastRunFinishedAt || null,
      runStats,
      runStatusDefinitions: STATUS_KEYS,
      dailyRuns: normalizeDailyRuns(actor, stats),
    };
  }

  self.AAP_ACTOR_DETAIL = { normalize, STATUS_KEYS };
})();
