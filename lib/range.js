/* Date/range helpers and response aggregation for the Insights range view. */
(function () {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function parseDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
  }

  function isDate(value) {
    return !!parseDate(value);
  }

  function isMonth(value) {
    return typeof value === "string" && /^\d{4}-\d{2}$/.test(value) && isDate(`${value}-01`);
  }

  function monthStart(value) {
    if (isMonth(value)) return `${value}-01`;
    const date = parseDate(value);
    return date ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01` : null;
  }

  function monthEnd(value) {
    const start = parseDate(monthStart(value));
    if (!start) return null;
    const date = new Date(start);
    date.setUTCMonth(date.getUTCMonth() + 1);
    date.setUTCDate(0);
    return date.toISOString().slice(0, 10);
  }

  function monthKeysBetween(start, end) {
    const first = parseDate(monthStart(start));
    const last = parseDate(monthStart(end));
    if (!first || !last || first > last) return [];

    const months = [];
    for (let date = new Date(first); date <= last; date.setUTCMonth(date.getUTCMonth() + 1)) {
      months.push(date.toISOString().slice(0, 10));
    }
    return months;
  }

  function datesBetween(start, end) {
    const first = parseDate(start);
    const last = parseDate(end);
    if (!first || !last || first > last) return [];

    const dates = [];
    for (let date = first; date <= last; date = new Date(date.getTime() + DAY_MS)) {
      dates.push(date.toISOString().slice(0, 10));
    }
    return dates;
  }

  function inRange(date, start, end) {
    return date >= start && date <= end;
  }

  function number(value) {
    if (typeof value !== "number" && typeof value !== "string") return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function dailyMoney(margin, day) {
    return margin?.dailyProfitMarginStats?.[day]?.payingUsersUsd || null;
  }

  function dailyRuns(runs, day) {
    return runs?.dailyStats?.[day] || null;
  }

  function dailyUsers(users, day) {
    return users?.[day] || null;
  }

  function dailyCost(costs, day) {
    return costs?.dailyActorRunsCost?.[day];
  }

  function todayDate() {
    return new Date().toISOString().slice(0, 10);
  }

  function dayRecord(byDay, day) {
    let record = byDay.get(day);
    if (!record) {
      record = {};
      byDay.set(day, record);
    }
    return record;
  }

  function actorRow(entry, day) {
    const money = entry?.margin?.dailyProfitMarginStats?.[day]?.payingUsersUsd;
    const revenue = number(money?.revenueUsd);
    const runStats = entry?.runs?.dailyStats?.[day] || {};
    const runs = number(runStats.TOTAL);
    if (!(revenue > 0 || runs > 0)) return null;
    return {
      actorId: entry.actorId,
      name: entry.name || entry.actorId,
      revenue,
      cost: number(money?.costUsd),
      profit: number(money?.profitUsd),
      margin: money?.margin == null ? null : number(money.margin),
      runs,
      results: number(runStats.RESULTS),
    };
  }

  function summary(values) {
    return {
      average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
      minimum: values.length ? Math.min(...values) : 0,
      maximum: values.length ? Math.max(...values) : 0,
    };
  }

  function aggregate(months, start, end) {
    const effectiveEnd = end > todayDate() ? todayDate() : end;
    const days = datesBetween(start, effectiveEnd);
    const daily = {};
    const actorDaily = {};
    const actorNames = {};

    // The response for each month is disjoint by date. Indexing it first makes
    // the aggregation deterministic even when requests finish out of order,
    // and also makes partial-month ranges straightforward to trim.
    const byDay = new Map();
    const actorByDay = new Map();
    for (const month of months || []) {
      for (const day of Object.keys(month?.margin?.dailyProfitMarginStats || {})) {
        if (inRange(day, start, effectiveEnd)) dayRecord(byDay, day).margin = month.margin;
      }
      for (const day of Object.keys(month?.runs?.dailyStats || {})) {
        if (inRange(day, start, effectiveEnd)) dayRecord(byDay, day).runs = month.runs;
      }
      for (const day of Object.keys(month?.users || {})) {
        if (inRange(day, start, effectiveEnd)) dayRecord(byDay, day).users = month.users;
      }
      for (const day of Object.keys(month?.costs?.dailyActorRunsCost || {})) {
        if (inRange(day, start, effectiveEnd)) dayRecord(byDay, day).costs = month.costs;
      }

      for (const entry of month?.actorMargins || []) {
        if (!entry?.actorId) continue;
        const marginByDay = entry.margin?.dailyProfitMarginStats || {};
        const runsByDay = entry.runs?.dailyStats || {};
        const entryDays = new Set([...Object.keys(marginByDay), ...Object.keys(runsByDay)]);
        for (const day of entryDays) {
          if (!inRange(day, start, effectiveEnd)) continue;
          const row = actorRow(entry, day);
          if (row) {
            actorNames[entry.actorId] = row.name;
            let actorsForDay = actorByDay.get(day);
            if (!actorsForDay) {
              actorsForDay = new Map();
              actorByDay.set(day, actorsForDay);
            }
            actorsForDay.set(entry.actorId, row);
          }
        }
      }
    }

    const totals = {
      revenue: 0,
      cost: 0,
      profit: 0,
      runs: 0,
      results: 0,
    };

    for (const day of days) {
      const source = byDay.get(day) || {};
      const money = dailyMoney(source.margin, day);
      const runStats = dailyRuns(source.runs, day);
      const userStats = dailyUsers(source.users, day);
      const costPerThousand = dailyCost(source.costs, day);
      const totalRuns = number(runStats?.TOTAL);
      const succeeded = totalRuns ? number(runStats.SUCCEEDED) : 0;
      const aborted = totalRuns ? number(runStats.ABORTED) : 0;
      const timedOut = totalRuns ? number(runStats["TIMED-OUT"] ?? runStats.TIMED_OUT) : 0;
      const failed = totalRuns
        ? runStats.FAILED == null
          ? Math.max(0, totalRuns - succeeded - aborted - timedOut)
          : number(runStats.FAILED)
        : 0;

      const row = {
        revenue: number(money?.revenueUsd),
        cost: number(money?.costUsd),
        profit: number(money?.profitUsd),
        margin: money?.margin == null ? null : number(money.margin),
        runs: totalRuns,
        results: number(runStats?.RESULTS),
        succeeded,
        aborted,
        failed,
        timedOut,
        successRate: runStats?.TOTAL ? succeeded / runStats.TOTAL : null,
        freeUsers: number(userStats?.freeUsers),
        payingUsers: number(userStats?.payingUsers),
        // A missing cost value means there were no billable results that day;
        // it is not the same thing as a real $0.00 cost-per-thousand value.
        costPerThousandResults: costPerThousand == null ? null : number(costPerThousand),
      };
      daily[day] = row;
      totals.revenue += row.revenue;
      totals.cost += row.cost;
      totals.profit += row.profit;
      totals.runs += row.runs;
      totals.results += row.results;

      const actors = [...(actorByDay.get(day)?.values() || [])];
      if (actors.length) actorDaily[day] = actors;
    }

    totals.margin = totals.revenue ? totals.profit / totals.revenue : null;

    const runValues = days.map((day) => daily[day].runs);
    const resultValues = days.map((day) => daily[day].results);
    const costValues = days.map((day) => daily[day].costPerThousandResults).filter((value) => value != null);

    return {
      start,
      end: effectiveEnd,
      days,
      daily,
      actorDaily,
      actorNames,
      totals,
      runsSummary: summary(runValues),
      resultsSummary: summary(resultValues),
      costsSummary: summary(costValues),
    };
  }

  function weekStart(day) {
    const date = parseDate(day);
    if (!date) return null;
    const offset = date.getUTCDay() === 0 ? -6 : 1 - date.getUTCDay();
    return new Date(date.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
  }

  function bucketKey(day, grouping) {
    if (grouping === "month") return `${day.slice(0, 7)}-01`;
    return grouping === "day" ? day : weekStart(day);
  }

  // Converts the raw daily endpoint data into the three supported chart
  // granularities. Money/runs/results are summed; user counts are average
  // daily counts because the endpoint reports daily unique users and cannot
  // deduplicate a person seen on multiple days of a week/month.
  function group(data, grouping) {
    const mode = grouping === "month" || grouping === "day" ? grouping : "week";
    const buckets = new Map();
    for (const day of data?.days || []) {
      const key = bucketKey(day, mode);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          dayCount: 0,
          revenue: 0,
          cost: 0,
          profit: 0,
          runs: 0,
          results: 0,
          succeeded: 0,
          aborted: 0,
          failed: 0,
          timedOut: 0,
          freeUsers: 0,
          payingUsers: 0,
          costWeighted: 0,
          costWeight: 0,
          costSum: 0,
          costCount: 0,
          actorRevenue: {},
          actorStats: {},
        };
        buckets.set(key, bucket);
      }

      const row = data.daily[day] || {};
      bucket.dayCount++;
      bucket.revenue += number(row.revenue);
      bucket.cost += number(row.cost);
      bucket.profit += number(row.profit);
      bucket.runs += number(row.runs);
      bucket.results += number(row.results);
      bucket.succeeded += row.succeeded == null ? number(row.runs) * number(row.successRate) : number(row.succeeded);
      bucket.aborted += number(row.aborted);
      bucket.failed += number(row.failed);
      bucket.timedOut += number(row.timedOut);
      bucket.freeUsers += number(row.freeUsers);
      bucket.payingUsers += number(row.payingUsers);
      if (row.costPerThousandResults != null) {
        bucket.costSum += number(row.costPerThousandResults);
        bucket.costCount++;
        // A cost-per-1,000 result value is most useful across a bucket when
        // weighted by the number of results represented by each day.
        const weight = number(row.results);
        if (weight > 0) {
          bucket.costWeighted += number(row.costPerThousandResults) * weight;
          bucket.costWeight += weight;
        }
      }

      for (const actor of data.actorDaily?.[day] || []) {
        const stats = bucket.actorStats[actor.actorId] || {
          actorId: actor.actorId,
          name: actor.name || actor.actorId,
          revenue: 0,
          cost: 0,
          profit: 0,
          runs: 0,
          results: 0,
        };
        stats.revenue += number(actor.revenue);
        stats.cost += number(actor.cost);
        stats.profit += number(actor.profit);
        stats.runs += number(actor.runs);
        stats.results += number(actor.results);
        bucket.actorStats[actor.actorId] = stats;
      }
    }

    const daily = {};
    for (const [key, bucket] of buckets) {
      const costPerThousandResults = bucket.costWeight
        ? bucket.costWeighted / bucket.costWeight
        : bucket.costCount
          ? bucket.costSum / bucket.costCount
          : null;
      const actorStats = Object.fromEntries(
        Object.entries(bucket.actorStats).filter(([, actor]) => actor.revenue > 0 || actor.runs > 0),
      );
      const actorRevenue = Object.fromEntries(
        Object.entries(actorStats).map(([actorId, actor]) => [actorId, actor.revenue]),
      );
      daily[key] = {
        revenue: bucket.revenue,
        cost: bucket.cost,
        profit: bucket.profit,
        margin: bucket.revenue ? bucket.profit / bucket.revenue : null,
        runs: bucket.runs,
        results: bucket.results,
        succeeded: bucket.succeeded,
        aborted: bucket.aborted,
        failed: bucket.failed,
        timedOut: bucket.timedOut,
        successRate: bucket.runs ? bucket.succeeded / bucket.runs : null,
        freeUsers: bucket.dayCount ? bucket.freeUsers / bucket.dayCount : 0,
        payingUsers: bucket.dayCount ? bucket.payingUsers / bucket.dayCount : 0,
        costPerThousandResults,
        actorRevenue,
        actorStats,
      };
    }

    const periods = [...buckets.keys()].sort();
    const runValues = periods.map((period) => daily[period].runs);
    const resultValues = periods.map((period) => daily[period].results);
    const costValues = periods.map((period) => daily[period].costPerThousandResults).filter((value) => value != null);
    return {
      ...data,
      grouping: mode,
      days: periods,
      daily,
      runsSummary: summary(runValues),
      resultsSummary: summary(resultValues),
      costsSummary: summary(costValues),
    };
  }

  function formatDate(value, options) {
    const date = parseDate(value);
    return date
      ? date.toLocaleDateString("en-US", { timeZone: "UTC", ...options })
      : "–";
  }

  // Choose a readable y-axis step while keeping the ceiling close to the
  // largest plotted value. The chart can use between five and nine gridlines
  // instead of inflating every range to a fixed number of broad intervals.
  function niceScale(value) {
    const targetTicks = 6;
    const maxTicks = 8;
    const niceMultipliers = [1, 2, 2.5, 5, 10];
    const safeValue = Number.isFinite(value) && value > 0 ? value : 0;
    if (!safeValue) return { max: 1, step: 0.2, ticks: 5 };

    const rawStep = safeValue / targetTicks;
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const normalized = rawStep / magnitude;
    let multiplierIndex = niceMultipliers.findIndex((multiplier) => normalized <= multiplier);
    if (multiplierIndex < 0) multiplierIndex = niceMultipliers.length - 1;

    let step = niceMultipliers[multiplierIndex] * magnitude;
    let ticks = Math.max(1, Math.ceil(safeValue / step));
    if (multiplierIndex > 0) {
      const finerStep = niceMultipliers[multiplierIndex - 1] * magnitude;
      const finerTicks = Math.max(1, Math.ceil(safeValue / finerStep));
      const currencyPrecisionWouldBeAmbiguous = finerStep < 0.1 && safeValue < 1;
      if (finerTicks <= maxTicks && !currencyPrecisionWouldBeAmbiguous) {
        step = finerStep;
        ticks = finerTicks;
      }
    }
    return { max: step * ticks, step, ticks };
  }

  self.AAPR = {
    isDate,
    isMonth,
    monthStart,
    monthEnd,
    monthKeysBetween,
    datesBetween,
    aggregate,
    group,
    formatDate,
    niceScale,
  };
})();
