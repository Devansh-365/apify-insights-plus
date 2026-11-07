/* Builds a range analytics export in the shape of Apify's monthly export. */
(function () {
  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  // Month start keys ("2026-08-01") from the first to the last month.
  function exportMonths(startMonth, endMonth) {
    return self.AAPR.monthKeysBetween(`${startMonth}-01`, `${endMonth}-01`);
  }

  function fileName(startMonth, endMonth) {
    return startMonth === endMonth
      ? `${startMonth}-01_analytics.json`
      : `${startMonth}-01_to_${endMonth}_analytics.json`;
  }

  function mergeDaily(target, daily) {
    for (const [day, value] of Object.entries(daily || {})) target[day] = value;
    return target;
  }

  function sortedByDay(daily) {
    return Object.fromEntries(Object.entries(daily).sort(([left], [right]) => left.localeCompare(right)));
  }

  function sumFields(target, source) {
    for (const [key, value] of Object.entries(source || {})) {
      if (typeof value === "number") target[key] = number(target[key]) + value;
    }
    return target;
  }

  // Apify's summaries are the min, max, and mean of the days it reports.
  function daySummary(values) {
    if (!values.length) return { min: 0, max: 0, avg: 0 };
    return {
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    };
  }

  function monthResults(data) {
    return Object.values(data?.runStats?.dailyStats || {}).reduce((sum, day) => sum + number(day?.RESULTS), 0);
  }

  // Apify's monthly average cost per 1,000 results is not the mean of its
  // daily values, so the range average weights each month's own average by
  // that month's results.
  function costTotals(exports) {
    let max = null;
    let min = null;
    let weighted = 0;
    let weight = 0;
    for (const data of exports) {
      const total = data?.costPerThousandResults?.totalActorRunsCostPerThousandResults;
      if (!total || total.avgActorRunsCost == null) continue;
      max = max == null ? total.maxActorRunsCost : Math.max(max, number(total.maxActorRunsCost));
      min = min == null ? total.minActorRunsCost : Math.min(min, number(total.minActorRunsCost));
      const results = monthResults(data);
      weighted += number(total.avgActorRunsCost) * results;
      weight += results;
    }
    return {
      maxActorRunsCost: max,
      minActorRunsCost: min,
      avgActorRunsCost: weight ? weighted / weight : null,
    };
  }

  function marginTotals(exports, audience) {
    const total = { costUsd: 0, revenueUsd: 0, profitUsd: 0 };
    for (const data of exports) {
      const month = data?.profitMargin?.totalProfitMarginStats?.[audience];
      total.costUsd += number(month?.costUsd);
      total.revenueUsd += number(month?.revenueUsd);
      total.profitUsd += number(month?.profitUsd);
    }
    total.margin = total.revenueUsd ? total.profitUsd / total.revenueUsd : 0;
    return total;
  }

  // Newest month first, so names and pricing models are the current ones.
  function mergeActors(exports) {
    const actorIds = [];
    const seen = new Set();
    const actors = new Map();
    for (const data of [...exports].reverse()) {
      for (const actorId of data?.actorIds || []) {
        if (!seen.has(actorId)) {
          seen.add(actorId);
          actorIds.push(actorId);
        }
      }
      for (const row of data?.actorBreakdown || []) {
        if (!row?.actorId) continue;
        if (!seen.has(row.actorId)) {
          seen.add(row.actorId);
          actorIds.push(row.actorId);
        }
        const current = actors.get(row.actorId);
        if (!current) {
          actors.set(row.actorId, {
            actorId: row.actorId,
            actorName: row.actorName,
            actorPricingModel: row.actorPricingModel,
            profitStats: sumFields({}, row.profitStats),
            usersStats: sumFields({}, row.usersStats),
            numChargedResults: number(row.numChargedResults),
          });
          continue;
        }
        sumFields(current.profitStats, row.profitStats);
        sumFields(current.usersStats, row.usersStats);
        current.numChargedResults += number(row.numChargedResults);
      }
    }
    // Apify lists the breakdown in its actorIds order.
    const actorBreakdown = actorIds.filter((actorId) => actors.has(actorId)).map((actorId) => actors.get(actorId));
    return { actorIds, actorBreakdown };
  }

  const MARKETING_FIELDS = ["numUniqueConsolePageViews", "numUniqueUsersWithRun", "numUniqueViewingUsers", "numUniqueWebPageViews"];

  function pastDays(daily, today) {
    if (!daily || typeof daily !== "object") return daily;
    return Object.fromEntries(Object.entries(daily).filter(([day]) => day <= today));
  }

  // Apify's export leaves marketingData at 0 and lists the rest of the
  // current month as empty user-stat days. This takes the marketing counts
  // from the monthly marketing statistics (what the Acquisition page shows)
  // and drops days that have not happened yet.
  function prepareMonth(item, today) {
    const data = item.data;
    const marketing = item.marketing && typeof item.marketing === "object" ? item.marketing : null;
    const marketingData = { ...(data.marketingData || {}) };
    let marketingFilled = false;
    for (const key of MARKETING_FIELDS) {
      if (typeof marketing?.[key] === "number") {
        marketingData[key] = marketing[key];
        marketingFilled = true;
      }
    }
    const prepared = {
      ...data,
      marketingData,
      userStats: pastDays(data.userStats, today),
    };
    for (const [section, field] of [
      ["costPerThousandResults", "dailyActorRunsCostPerThousandResults"],
      ["runStats", "dailyStats"],
      ["profitMargin", "dailyProfitMarginStats"],
    ]) {
      if (data[section]?.[field]) prepared[section] = { ...data[section], [field]: pastDays(data[section][field], today) };
    }
    return { month: item.month, data: prepared, marketingFilled };
  }

  function marketingNote(items) {
    const missing = items.filter((item) => !item.marketingFilled).map((item) => item.month.slice(0, 7));
    if (missing.length === items.length) return "marketingData is Apify's export value; the monthly marketing statistics could not be loaded.";
    return `marketingData comes from Apify's monthly marketing statistics (the Acquisition data), since Apify's export leaves it at 0.${
      missing.length ? ` Apify's export value is kept for ${missing.join(", ")}, which could not be loaded.` : ""
    }`;
  }

  /**
   * Merges Apify's monthly exports, oldest month first, into one file with
   * the same top-level fields. Daily values are kept up to `options.today`.
   * Totals are recomputed for the range, and `months` keeps each month's
   * marketing and per-Actor figures, since their distinct user counts cannot
   * be added up. An item's `marketing` is that month's monthly-marketing
   * response.
   */
  function merge(monthly, options = {}) {
    const today = options.today || new Date().toISOString().slice(0, 10);
    const items = (monthly || []).filter((item) => item?.data).map((item) => prepareMonth(item, today));
    if (!items.length) throw new Error("No months to export");
    const exports = items.map((item) => item.data);
    if (exports.length === 1) {
      return {
        ...exports[0],
        notes: [`Apify's analytics export, with changes by Apify Insights Plus. ${marketingNote(items)} Days after ${today} are left out.`],
      };
    }

    const first = exports[0];
    const last = exports[exports.length - 1];
    const { actorIds, actorBreakdown } = mergeActors(exports);
    const runDaily = {};
    const marginDaily = {};
    const userDaily = {};
    const costDaily = {};
    const marketingData = {};
    for (const data of exports) {
      mergeDaily(runDaily, data.runStats?.dailyStats);
      mergeDaily(marginDaily, data.profitMargin?.dailyProfitMarginStats);
      mergeDaily(userDaily, data.userStats);
      mergeDaily(costDaily, data.costPerThousandResults?.dailyActorRunsCostPerThousandResults);
      sumFields(marketingData, data.marketingData);
    }
    const runDays = Object.values(runDaily);

    return {
      actorIds,
      dateFromInclusive: first.dateFromInclusive || `${items[0].month}T00:00:00.000Z`,
      dateToExclusive: last.dateToExclusive || null,
      marketingData,
      actorBreakdown,
      costPerThousandResults: {
        dailyActorRunsCostPerThousandResults: sortedByDay(costDaily),
        totalActorRunsCostPerThousandResults: costTotals(exports),
      },
      runStats: {
        dailyStats: sortedByDay(runDaily),
        runsSummary: daySummary(runDays.map((day) => number(day?.TOTAL))),
        resultsSummary: daySummary(runDays.map((day) => number(day?.RESULTS))),
      },
      profitMargin: {
        totalProfitMarginStats: {
          payingUsersUsd: marginTotals(exports, "payingUsersUsd"),
          allUsersUsd: marginTotals(exports, "allUsersUsd"),
        },
        dailyProfitMarginStats: sortedByDay(marginDaily),
      },
      userStats: sortedByDay(userDaily),
      months: items.map((item) => ({
        month: item.month.slice(0, 7),
        dateFromInclusive: item.data.dateFromInclusive,
        dateToExclusive: item.data.dateToExclusive,
        marketingData: item.data.marketingData,
        actorBreakdown: item.data.actorBreakdown,
      })),
      notes: [
        "Merged from Apify's monthly analytics exports by Apify Insights Plus.",
        marketingNote(items),
        `Days after ${today} are left out.`,
        "marketingData and actorBreakdown.usersStats add up each month's unique counts, so a user active in two months counts twice. months[] has each month's exact figures.",
        "avgActorRunsCost weights each month's average by that month's results.",
      ],
      exportedAt: options.exportedAt || new Date().toISOString(),
    };
  }

  self.AAP_ANALYTICS_EXPORT = { exportMonths, fileName, merge };
})();
