/* Per-Actor portfolio analysis for the Monetization range view (pure, no DOM). */
(function () {
  /*
   * Every Actor gets exactly one primary decision, checked in urgency order,
   * so segment counts add up to the portfolio and each Actor has one next
   * step. Secondary facts (core earner, single customer, ...) are chips.
   *
   * Noise control: small portfolios swing by cents, so money rules only fire
   * above a materiality floor scaled to the portfolio (1% of monthly profit
   * pace, at least $1). Pace waits for MIN_PACE_DAYS of the latest month, and
   * reliability needs a minimum number of failures, not just a percentage.
   */
  const CORE_PROFIT_SHARE = 0.8;
  const MATERIALITY_SHARE = 0.01;
  const MIN_MATERIALITY_USD = 1;
  const MIN_LOSS_USD = 0.25;
  const MIN_PACE_DAYS = 7;
  const PACE_CHANGE = 0.25;
  const FAILURE_RATE = 0.05;
  const MIN_FAILURES = 3;
  const THIN_MARGIN = 0.3;
  const UNTAPPED_MIN_FREE_USERS = 5;
  const UNTAPPED_MAX_PAYING_SHARE = 0.2;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function usd(value) {
    const amount = Math.abs(value);
    return `$${amount >= 100 ? Math.round(amount).toLocaleString("en-US") : amount.toFixed(2)}`;
  }

  // Ordered by urgency; the first matching rule is the Actor's decision.
  const SEGMENTS = [
    {
      key: "fix",
      label: "Fix reliability",
      action: "Fix first: paying users are hitting failed runs.",
      rule: (t) => `At least ${MIN_FAILURES} failed or timed-out runs and a ${FAILURE_RATE * 100}%+ failure rate (aborts excluded, since users often abort runs themselves), on an Actor with 2+ paying users or ${usd(t.materiality / 2)}+ revenue. Sorted by revenue at risk.`,
    },
    {
      key: "declining",
      label: "Declining",
      action: "Investigate: revenue pace dropped. Check for churned users, competitors, or a broken input.",
      rule: (t) => `Revenue per day in the latest month is down 25%+ on the month before, losing at least ${usd(t.materiality)}/month, or the Actor stopped earning. Needs ${MIN_PACE_DAYS}+ days of the month. Sorted by monthly revenue lost.`,
    },
    {
      key: "reprice",
      label: "Reprice",
      action: "Reprice or cut cost per run: platform costs eat the earnings.",
      rule: (t) => `Loses at least ${usd(t.lossFloor)} in this range, or earns ${usd(t.materiality)}+ at under ${THIN_MARGIN * 100}% margin. Sorted by money lost to cost.`,
    },
    {
      key: "growing",
      label: "Growing",
      action: "Double down: promote, add features, or raise prices while demand rises.",
      rule: (t) => `Revenue per day is up 25%+ on the month before, adding at least ${usd(t.materiality)}/month (or first revenue at that level). Needs ${MIN_PACE_DAYS}+ days of the month. Sorted by monthly revenue added.`,
    },
    {
      key: "core",
      label: "Core earners",
      action: "Protect: these carry the business, so keep them stable and monitored.",
      rule: () => `The fewest Actors that together make ${CORE_PROFIT_SHARE * 100}% of profit and are not in a segment above. Sorted by profit.`,
    },
    {
      key: "untapped",
      label: "Untapped demand",
      action: "Convert: many people use it for free, so test paid value, limits, or messaging.",
      rule: (t) => `${t.untappedFreeUsers}+ free users (the top quarter of your Actors) with under ${UNTAPPED_MAX_PAYING_SHARE * 100}% paying. Sorted by free users.`,
    },
    {
      key: "tail",
      label: "Long tail",
      action: "Leave as is: small and stable. Revisit only if it starts moving.",
      rule: () => "Has runs or users but matches no rule above. Sorted by revenue.",
    },
    {
      key: "idle",
      label: "Idle",
      action: "Promote, merge, or retire: no one used it in this range.",
      rule: () => "No runs and no users in this range.",
    },
  ];

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function primaryPrice(pricing) {
    if (!pricing) return null;
    const events = Object.values(pricing.pricingPerEvent?.actorChargeEvents || {});
    const event = events.find((item) => item?.isPrimaryEvent) || events.find((item) => item && !item.isOneTimeEvent) || null;
    if (event) {
      const tiers = event.eventTieredPricingUsd;
      const price = tiers
        ? tiers.FREE?.tieredEventPriceUsd ?? Object.values(tiers)[0]?.tieredEventPriceUsd
        : event.eventPriceUsd;
      return price == null ? null : { unit: event.eventTitle || "event", priceUsd: Number(price) };
    }
    if (pricing.pricePerUnitUsd != null) {
      return { unit: pricing.unitName || "result", priceUsd: Number(pricing.pricePerUnitUsd) };
    }
    return null;
  }

  // Compact the actor-breakdown response to the fields the portfolio needs.
  function normalizeRows(raw) {
    const items = Array.isArray(raw) ? raw : raw?.monetizationPerActor || [];
    const rows = [];
    for (const item of items) {
      const actor = item?.actor || {};
      if (!actor._id) continue;
      const runs = item.runsStats || {};
      const earnings = item.earningsStats || {};
      const users = item.usersStats || {};
      rows.push({
        id: actor._id,
        title: actor.title || actor.name || actor._id,
        name: actor.name || "",
        username: actor.username || "",
        pictureUrl: actor.pictureUrl || "",
        isDeprecated: !!actor.isDeprecated,
        revenue: number(earnings.totalRevenueUsd),
        cost: number(earnings.totalCostUsd),
        profit: earnings.totalProfitUsd != null
          ? number(earnings.totalProfitUsd)
          : number(earnings.totalRevenueUsd) - number(earnings.totalCostUsd),
        payingUsers: number(users.payingUsers),
        freeUsers: number(users.freeUsers),
        runs: number(runs.TOTAL),
        succeeded: number(runs.SUCCEEDED),
        failed: number(runs.FAILED),
        timedOut: number(runs["TIMED-OUT"] ?? runs.TIMED_OUT),
        aborted: number(runs.ABORTED),
        results: number(runs.RESULTS),
        pricingModel: item.currentPricingInfo?.pricingModel || null,
        price: primaryPrice(item.currentPricingInfo),
      });
    }
    return rows;
  }

  // Elapsed days of a month, as of `now` for the current month.
  function monthDays(month, now) {
    const start = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    const stop = Math.min(end.getTime(), nowMs);
    return Math.max(0, (stop - start.getTime()) / DAY_MS);
  }

  function previousMonthKey(month) {
    const date = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() - 1);
    return date.toISOString().slice(0, 10);
  }

  function sumRows(rowsByMonth) {
    const byId = new Map();
    for (const rows of rowsByMonth) {
      for (const row of rows || []) {
        const current = byId.get(row.id);
        if (!current) {
          byId.set(row.id, { ...row });
          continue;
        }
        for (const key of ["revenue", "cost", "profit", "runs", "succeeded", "failed", "timedOut", "aborted", "results"]) {
          current[key] += row[key];
        }
        // Users are monthly unique counts; the peak month is the honest
        // range figure (summing would double-count returning users).
        current.payingUsers = Math.max(current.payingUsers, row.payingUsers);
        current.freeUsers = Math.max(current.freeUsers, row.freeUsers);
        current.isDeprecated = row.isDeprecated;
        current.pricingModel = row.pricingModel || current.pricingModel;
        current.price = row.price || current.price;
      }
    }
    return byId;
  }

  function percentile(values, fraction) {
    if (!values.length) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  }

  function percentText(value) {
    return `${Math.round(Math.abs(value) * 100)}%`;
  }

  /**
   * @param {object} input
   * @param {Object<string, Array>} input.rowsByMonth normalized rows keyed by month start (YYYY-MM-01)
   * @param {Array} [input.previousRows] normalized rows for the month before the latest month, when not in range
   * @param {Date|number} [input.now]
   */
  function analyze({ rowsByMonth, previousRows = null, now = Date.now() }) {
    const months = Object.keys(rowsByMonth || {}).sort();
    const latestMonth = months[months.length - 1] || null;
    const comparisonMonth = latestMonth ? previousMonthKey(latestMonth) : null;
    const comparisonRows = comparisonMonth && rowsByMonth[comparisonMonth] ? rowsByMonth[comparisonMonth] : previousRows;
    const latestRows = latestMonth ? rowsByMonth[latestMonth] : [];
    const latestById = new Map(latestRows.map((row) => [row.id, row]));
    const previousById = new Map((comparisonRows || []).map((row) => [row.id, row]));
    const latestDays = latestMonth ? monthDays(latestMonth, now) : 0;
    const previousDays = comparisonMonth ? monthDays(comparisonMonth, now) : 0;
    const paceReady = !!comparisonRows && latestDays >= MIN_PACE_DAYS && previousDays > 0;

    // Materiality scales with the portfolio: 1% of monthly profit pace.
    const latestProfit = latestRows.reduce((sum, row) => sum + row.profit, 0);
    const monthlyProfitPace = latestDays ? (latestProfit / Math.max(1, latestDays)) * 30 : 0;
    const materiality = Math.max(MIN_MATERIALITY_USD, MATERIALITY_SHARE * Math.max(0, monthlyProfitPace));
    const lossFloor = Math.max(MIN_LOSS_USD, materiality / 4);

    const rows = [...sumRows(months.map((month) => rowsByMonth[month])).values()];
    const totalRevenue = rows.reduce((sum, row) => sum + Math.max(0, row.revenue), 0);
    const totalProfit = rows.reduce((sum, row) => sum + row.profit, 0);
    const positiveProfit = rows.reduce((sum, row) => sum + Math.max(0, row.profit), 0);
    const freeUserCounts = rows.map((row) => row.freeUsers).filter((value) => value > 0);
    const untappedFreeUsers = Math.max(UNTAPPED_MIN_FREE_USERS, Math.ceil(percentile(freeUserCounts, 0.75)));
    const thresholds = { materiality, lossFloor, untappedFreeUsers, paceReady, latestDays, minPaceDays: MIN_PACE_DAYS };

    // Core earners: the smallest profit-ranked set covering 80% of profit.
    const core = new Set();
    let covered = 0;
    for (const row of rows.filter((item) => item.profit > 0).sort((left, right) => right.profit - left.profit)) {
      if (covered >= CORE_PROFIT_SHARE * positiveProfit) break;
      covered += row.profit;
      core.add(row.id);
    }

    for (const row of rows) {
      row.users = row.payingUsers + row.freeUsers;
      row.successRate = row.runs ? row.succeeded / row.runs : null;
      row.failures = row.failed + row.timedOut;
      row.failureRate = row.runs ? row.failures / row.runs : null;
      row.payingShare = row.users ? row.payingUsers / row.users : null;
      row.margin = row.revenue > 0 ? row.profit / row.revenue : null;
      row.revenueShare = totalRevenue ? Math.max(0, row.revenue) / totalRevenue : 0;
      row.profitShare = positiveProfit ? Math.max(0, row.profit) / positiveProfit : 0;
      row.revenuePerThousand = row.results ? (row.revenue / row.results) * 1000 : null;
      row.isCore = core.has(row.id);

      const latest = latestById.get(row.id);
      const previous = previousById.get(row.id);
      row.pace = null;
      if (paceReady) {
        const latestPerDay = (latest?.revenue || 0) / latestDays;
        const previousPerDay = (previous?.revenue || 0) / previousDays;
        row.pace = {
          latestPerDay,
          previousPerDay,
          monthlyChange: (latestPerDay - previousPerDay) * 30,
          change: previousPerDay > 0 ? (latestPerDay - previousPerDay) / previousPerDay : null,
          payingDelta: (latest?.payingUsers || 0) - (previous?.payingUsers || 0),
        };
      }

      const signals = [];
      const pace = row.pace;
      const reliability = row.failures >= MIN_FAILURES
        && row.failureRate >= FAILURE_RATE
        && (row.payingUsers >= 2 || row.revenue >= materiality / 2);
      const stoppedEarning = pace && pace.previousPerDay * 30 >= materiality && pace.latestPerDay === 0;
      const declining = pace && (stoppedEarning || (
        pace.change != null && pace.change <= -PACE_CHANGE && -pace.monthlyChange >= materiality
      ));
      const losing = row.profit <= -lossFloor;
      const thin = !losing && row.revenue >= materiality && row.margin != null && row.margin < THIN_MARGIN;
      const growing = pace && pace.monthlyChange >= materiality && (pace.change == null || pace.change >= PACE_CHANGE);
      const untapped = row.freeUsers >= untappedFreeUsers && (row.payingShare ?? 0) < UNTAPPED_MAX_PAYING_SHARE;
      const idle = row.runs === 0 && row.users === 0;

      if (reliability) {
        row.primary = "fix";
        row.impact = row.revenue * row.failureRate;
        signals.push({ tone: "bad", text: `${(row.failureRate * 100).toFixed(1)}% runs fail`, detail: row.revenue > 0 ? `≈${usd(row.impact)} at risk` : `${row.failures} failures` });
      } else if (declining) {
        row.primary = "declining";
        row.impact = -pace.monthlyChange;
        signals.push({
          tone: "bad",
          text: stoppedEarning ? "Stopped earning" : `Pace ${Math.round(pace.change * 100)}%`,
          detail: `−${usd(row.impact)}/mo`,
        });
      } else if (losing || thin) {
        row.primary = "reprice";
        row.impact = losing ? -row.profit : row.revenue * (THIN_MARGIN - row.margin);
        signals.push(losing
          ? { tone: "bad", text: `Losing ${usd(row.profit)}` }
          : { tone: "warning", text: `${percentText(row.margin)} margin` });
      } else if (growing) {
        row.primary = "growing";
        row.impact = pace.monthlyChange;
        signals.push({
          tone: "good",
          text: pace.change == null ? "First revenue" : `Pace +${Math.round(pace.change * 100)}%`,
          detail: `+${usd(row.impact)}/mo`,
        });
      } else if (row.isCore) {
        row.primary = "core";
        row.impact = row.profit;
      } else if (untapped) {
        row.primary = "untapped";
        row.impact = row.freeUsers;
        signals.push({ tone: "warning", text: `${row.freeUsers} free users`, detail: `${percentText(row.payingShare ?? 0)} pay` });
      } else if (idle) {
        row.primary = "idle";
        row.impact = 0;
      } else {
        row.primary = "tail";
        row.impact = row.revenue;
      }

      // Context chips, independent of the primary decision.
      if (row.isCore) signals.push({ tone: "good", text: `Core · ${percentText(row.profitShare)} of profit` });
      if (pace && row.primary === "growing" && pace.payingDelta > 0) signals.push({ tone: "good", text: `+${pace.payingDelta} paying users` });
      if (pace && row.primary === "declining" && pace.payingDelta < 0) signals.push({ tone: "bad", text: `${pace.payingDelta} paying users` });
      if (row.payingUsers === 1 && row.profit >= materiality) signals.push({ tone: "warning", text: "1 paying user" });
      if (row.isDeprecated) signals.push({ tone: "neutral", text: "Deprecated" });
      row.signals = signals;
    }

    const counts = { all: rows.length };
    for (const segment of SEGMENTS) counts[segment.key] = rows.filter((row) => row.primary === segment.key).length;
    const sumImpact = (key) => rows.filter((row) => row.primary === key).reduce((sum, row) => sum + row.impact, 0);
    const byProfit = rows.filter((row) => row.profit > 0).sort((left, right) => right.profit - left.profit);
    const topThree = byProfit.slice(0, 3);

    return {
      months,
      latestMonth,
      comparisonMonth: comparisonRows ? comparisonMonth : null,
      thresholds,
      rows,
      counts,
      summary: {
        totalRevenue,
        totalProfit,
        margin: totalRevenue ? totalProfit / totalRevenue : null,
        actorCount: rows.length,
        earningCount: rows.filter((row) => row.revenue > 0).length,
        coreCount: core.size,
        topThree,
        topThreeShare: positiveProfit ? topThree.reduce((sum, row) => sum + row.profit, 0) / positiveProfit : 0,
        actionCount: counts.fix + counts.declining + counts.reprice,
        atRisk: sumImpact("fix") + sumImpact("declining") + sumImpact("reprice"),
        growingCount: counts.growing,
        growingGain: sumImpact("growing"),
      },
    };
  }

  self.AAP_PORTFOLIO_MODEL = {
    SEGMENTS,
    normalizeRows,
    previousMonthKey,
    monthDays,
    analyze,
  };
})();
