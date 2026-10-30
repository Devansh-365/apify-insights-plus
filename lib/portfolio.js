/* Per-Actor portfolio analysis for the Monetization range view (pure, no DOM). */
(function () {
  /*
   * Every Actor has one group, by how much it matters (core earner, long
   * tail, idle), and any number of actions, by what needs doing (fix,
   * declining, reprice, growing, untapped). The group never hides an action
   * and an action never moves an Actor out of its group, so a core earner
   * that starts failing stays a core earner, tagged "Fix reliability".
   *
   * Noise control: small portfolios swing by cents, so money rules only fire
   * above a materiality floor scaled to the portfolio (1% of monthly profit
   * pace, at least $1). Pace waits for MIN_PACE_DAYS of the latest month, and
   * reliability needs a minimum number of failures, not just a percentage.
   * An Actor keeps a group or action it already had until it is clearly past
   * the line (the *_KEEP values), so it does not flip back and forth.
   */
  const CORE_PROFIT_SHARE = 0.8;
  const CORE_KEEP_SHARE = 0.85;
  const MATERIALITY_SHARE = 0.01;
  const MIN_MATERIALITY_USD = 1;
  const MIN_LOSS_USD = 0.25;
  const MIN_PACE_DAYS = 7;
  const PACE_CHANGE = 0.25;
  const PACE_CHANGE_KEEP = 0.2;
  const FAILURE_RATE = 0.05;
  const FAILURE_RATE_KEEP = 0.04;
  const MIN_FAILURES = 3;
  const THIN_MARGIN = 0.3;
  const THIN_MARGIN_KEEP = 0.33;
  const UNTAPPED_MIN_FREE_USERS = 5;
  const UNTAPPED_MAX_PAYING_SHARE = 0.2;
  const UNTAPPED_KEEP_PAYING_SHARE = 0.22;
  // Money and user floors an Actor must stay above to keep a tag.
  const KEEP_FACTOR = 0.8;
  const PACE_ACTIONS = ["declining", "growing"];
  const DAY_MS = 24 * 60 * 60 * 1000;

  function usd(value) {
    const amount = Math.abs(value);
    return `$${amount >= 100 ? Math.round(amount).toLocaleString("en-US") : amount.toFixed(2)}`;
  }

  function pct(value, digits = 0) {
    return `${(Math.abs(value) * 100).toFixed(digits)}%`;
  }

  function shortMonth(month) {
    return month ? new Date(`${month.slice(0, 7)}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" }) : "last month";
  }

  // How much an Actor matters. Every Actor is in exactly one.
  const GROUPS = [
    {
      key: "core",
      label: "Core earners",
      action: "Protect: these carry the business, so keep them stable and monitored.",
      rule: () => `The fewest Actors that together make ${pct(CORE_PROFIT_SHARE)} of profit. An Actor stays one while it is within the top ${pct(CORE_KEEP_SHARE)}. Sorted by profit.`,
    },
    {
      key: "tail",
      label: "Long tail",
      action: "Small earners and free tools: act on them when they carry an action.",
      rule: () => "Has runs or users but is not a core earner. Sorted by revenue.",
    },
    {
      key: "idle",
      label: "Idle",
      action: "Promote, merge, or retire: no one used it in this range.",
      rule: () => "No runs and no users in this range.",
    },
  ];

  // What needs doing, most urgent first. An Actor can have several.
  const ACTIONS = [
    {
      key: "fix",
      label: "Fix reliability",
      tone: "bad",
      action: "Fix first: paying users are hitting failed runs.",
      rule: (t) => `At least ${MIN_FAILURES} failed or timed-out runs and a ${pct(FAILURE_RATE)}+ failure rate (aborts excluded, since users often abort runs themselves), on an Actor with 2+ paying users or ${usd(t.materiality / 2)}+ revenue. The tag stays until the rate is under ${pct(FAILURE_RATE_KEEP)}. Sorted by revenue at risk.`,
    },
    {
      key: "declining",
      label: "Declining",
      tone: "bad",
      action: "Investigate: revenue pace dropped. Check for churned users, competitors, or a broken input.",
      rule: (t) => `Revenue per day in the latest month is down ${pct(PACE_CHANGE)}+ on the month before, losing at least ${usd(t.materiality)}/month, or the Actor stopped earning. The tag stays until the drop is under ${pct(PACE_CHANGE_KEEP)}. Needs ${MIN_PACE_DAYS}+ days of the month. Sorted by monthly revenue lost.`,
    },
    {
      key: "reprice",
      label: "Reprice",
      tone: "warning",
      action: "Reprice or cut cost per run: platform costs eat the earnings.",
      rule: (t) => `Loses at least ${usd(t.lossFloor)} in this range, or earns ${usd(t.materiality)}+ at under ${pct(THIN_MARGIN)} margin. The tag stays until the margin is ${pct(THIN_MARGIN_KEEP)}+. Sorted by money lost to cost.`,
    },
    {
      key: "growing",
      label: "Growing",
      tone: "good",
      action: "Double down: promote, add features, or raise prices while demand rises.",
      rule: (t) => `Revenue per day is up ${pct(PACE_CHANGE)}+ on the month before, adding at least ${usd(t.materiality)}/month (or first revenue at that level). The tag stays until the rise is under ${pct(PACE_CHANGE_KEEP)}. Needs ${MIN_PACE_DAYS}+ days of the month. Sorted by monthly revenue added.`,
    },
    {
      key: "untapped",
      label: "Untapped demand",
      tone: "warning",
      action: "Convert: many people use it for free, so test paid value, limits, or messaging.",
      rule: (t) => `${t.untappedFreeUsers}+ free users (the top quarter of your Actors) with under ${pct(UNTAPPED_MAX_PAYING_SHARE)} paying. Sorted by free users.`,
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
    const byId = new Map();
    for (const item of items) {
      const actor = item?.actor || {};
      if (!actor._id) continue;
      const runs = item.runsStats || {};
      const earnings = item.earningsStats || {};
      const users = item.usersStats || {};
      const row = {
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
      };
      // Some backend versions repeat an Actor within one month. Summing the
      // copies would double it; keep the larger value of each field instead.
      const existing = byId.get(row.id);
      if (existing) {
        for (const key of ["revenue", "cost", "profit", "payingUsers", "freeUsers", "runs", "succeeded", "failed", "timedOut", "aborted", "results"]) {
          existing[key] = Math.max(existing[key], row[key]);
        }
        continue;
      }
      byId.set(row.id, row);
      rows.push(row);
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

  // The smallest profit-ranked set of Actors covering `share` of profit.
  function profitLeaders(rows, positiveProfit, share) {
    const leaders = new Set();
    let covered = 0;
    for (const row of rows.filter((item) => item.profit > 0).sort((left, right) => right.profit - left.profit)) {
      if (covered >= share * positiveProfit) break;
      covered += row.profit;
      leaders.add(row.id);
    }
    return leaders;
  }

  /**
   * @param {object} input
   * @param {Object<string, Array>} input.rowsByMonth normalized rows keyed by month start (YYYY-MM-01)
   * @param {Array} [input.previousRows] normalized rows for the month before the latest month, when not in range
   * @param {boolean} [input.paceLoading] the comparison month is still loading, so pace is not known yet
   * @param {object} [input.sticky] the last snapshot() of this range; Actors keep what they had until clearly past the line
   * @param {Date|number} [input.now]
   */
  function analyze({ rowsByMonth, previousRows = null, paceLoading = false, sticky = null, now = Date.now() }) {
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
    const comparisonLabel = shortMonth(comparisonMonth);

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
    const thresholds = {
      materiality,
      lossFloor,
      untappedFreeUsers,
      paceReady,
      paceLoading: !!paceLoading && !comparisonRows,
      latestDays,
      minPaceDays: MIN_PACE_DAYS,
    };

    // Core earners: the smallest profit-ranked set covering 80% of profit. A
    // core earner from the last snapshot stays one within the top 85%.
    const core = profitLeaders(rows, positiveProfit, CORE_PROFIT_SHARE);
    const coreKeep = profitLeaders(rows, positiveProfit, CORE_KEEP_SHARE);
    const before = (id) => sticky?.actors?.[id] || null;

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
      const was = before(row.id);
      // Pace tags only count as held when the snapshot knew the pace.
      const had = (key) => !!was?.slice(1).includes(key) && (!PACE_ACTIONS.includes(key) || !!sticky?.pace);
      row.isCore = core.has(row.id) || (was?.[0] === "core" && coreKeep.has(row.id));

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
      const pace = row.pace;

      const failing = (rate) => row.failures >= MIN_FAILURES
        && row.failureRate >= rate
        && (row.payingUsers >= 2 || row.revenue >= materiality / 2);
      const dropping = (change, floor) => !!pace && pace.change != null && pace.change <= -change && -pace.monthlyChange >= floor;
      const rising = (change, floor) => !!pace && pace.monthlyChange >= floor && (pace.change == null || pace.change >= change);
      const thinAt = (margin, floor) => row.revenue >= floor && row.margin != null && row.margin < margin;
      const untappedAt = (freeUsers, share) => row.freeUsers >= freeUsers && (row.payingShare ?? 0) < share;

      const stoppedEarning = !!pace && pace.previousPerDay * 30 >= materiality && pace.latestPerDay === 0;
      const losing = row.profit <= -lossFloor || (had("reprice") && row.profit <= -lossFloor * KEEP_FACTOR);
      const thin = !losing && (thinAt(THIN_MARGIN, materiality) || (had("reprice") && thinAt(THIN_MARGIN_KEEP, materiality * KEEP_FACTOR)));
      const actions = [];
      if (failing(FAILURE_RATE) || (had("fix") && failing(FAILURE_RATE_KEEP))) {
        actions.push({
          key: "fix",
          text: `${row.failures} failed (${pct(row.failureRate, 1)})`,
          detail: row.revenue > 0 ? `≈${usd(row.revenue * row.failureRate)} at risk` : null,
          impact: row.revenue * row.failureRate,
        });
      }
      if (stoppedEarning || dropping(PACE_CHANGE, materiality) || (had("declining") && dropping(PACE_CHANGE_KEEP, materiality * KEEP_FACTOR))) {
        actions.push({
          key: "declining",
          text: stoppedEarning ? "Stopped earning" : `−${pct(pace.change)}/day vs ${comparisonLabel}`,
          detail: `−${usd(-pace.monthlyChange)}/mo`,
          impact: -pace.monthlyChange,
        });
      }
      if (losing || thin) {
        actions.push(losing
          ? { key: "reprice", text: `Losing ${usd(row.profit)}`, detail: null, impact: -row.profit }
          : { key: "reprice", text: `${pct(row.margin)} margin`, detail: null, impact: Math.max(0, row.revenue * (THIN_MARGIN - row.margin)) });
      }
      if (rising(PACE_CHANGE, materiality) || (had("growing") && rising(PACE_CHANGE_KEEP, materiality * KEEP_FACTOR))) {
        actions.push({
          key: "growing",
          text: pace.change == null ? "First revenue" : `+${pct(pace.change)}/day vs ${comparisonLabel}`,
          detail: `+${usd(pace.monthlyChange)}/mo`,
          impact: pace.monthlyChange,
        });
      }
      if (untappedAt(untappedFreeUsers, UNTAPPED_MAX_PAYING_SHARE)
        || (had("untapped") && untappedAt(Math.ceil(untappedFreeUsers * KEEP_FACTOR), UNTAPPED_KEEP_PAYING_SHARE))) {
        actions.push({
          key: "untapped",
          text: `${row.freeUsers.toLocaleString("en-US")} free users`,
          detail: `${pct(row.payingShare ?? 0)} pay`,
          impact: row.freeUsers,
        });
      }
      row.actions = actions;
      row.group = row.isCore ? "core" : row.runs === 0 && row.users === 0 ? "idle" : "tail";
      row.change = null;

      // Context notes, beside the actions.
      const notes = [];
      if (row.isCore) notes.push({ tone: "good", text: `Core · ${pct(row.profitShare)} of profit` });
      if (pace && actions.some((item) => item.key === "growing") && pace.payingDelta > 0) notes.push({ tone: "good", text: `+${pace.payingDelta} paying users` });
      if (pace && actions.some((item) => item.key === "declining") && pace.payingDelta < 0) notes.push({ tone: "bad", text: `${pace.payingDelta} paying users` });
      if (row.payingUsers === 1 && row.profit >= materiality) notes.push({ tone: "warning", text: "1 paying user" });
      if (row.isDeprecated) notes.push({ tone: "neutral", text: "Deprecated" });
      row.notes = notes;
    }

    const groupCounts = Object.fromEntries(GROUPS.map((group) => [group.key, rows.filter((row) => row.group === group.key).length]));
    const actionCounts = Object.fromEntries(ACTIONS.map((action) => [action.key, rows.filter((row) => hasAction(row, action.key)).length]));
    const impactOf = (keys) => rows.reduce((sum, row) => sum + row.actions
      .filter((item) => keys.includes(item.key))
      .reduce((total, item) => total + item.impact, 0), 0);
    const urgent = ["fix", "declining", "reprice"];
    const byProfit = rows.filter((row) => row.profit > 0).sort((left, right) => right.profit - left.profit);
    const topThree = byProfit.slice(0, 3);

    return {
      months,
      latestMonth,
      comparisonMonth: comparisonRows ? comparisonMonth : null,
      thresholds,
      rows,
      counts: { all: rows.length, groups: groupCounts, actions: actionCounts },
      changes: null,
      summary: {
        totalRevenue,
        totalProfit,
        margin: totalRevenue ? totalProfit / totalRevenue : null,
        actorCount: rows.length,
        earningCount: rows.filter((row) => row.revenue > 0).length,
        coreCount: groupCounts.core,
        topThree,
        topThreeShare: positiveProfit ? topThree.reduce((sum, row) => sum + row.profit, 0) / positiveProfit : 0,
        actionCount: rows.filter((row) => row.actions.some((item) => urgent.includes(item.key))).length,
        atRisk: impactOf(urgent),
        growingCount: actionCounts.growing,
        growingGain: impactOf(["growing"]),
      },
    };
  }

  function hasAction(row, key) {
    return row.actions.some((item) => item.key === key);
  }

  // The classification to remember: each Actor's group, then its actions.
  // `pace` records whether growing and declining were known.
  function snapshot(analysis, day) {
    const actors = {};
    for (const row of analysis.rows) actors[row.id] = [row.group, ...row.actions.map((item) => item.key)];
    return { day, pace: !!analysis.thresholds.paceReady, actors };
  }

  // Marks each Actor whose group or actions differ from `baseline` (an older
  // snapshot of the same range) with row.change. Growing and declining are
  // compared only when both sides knew the pace, so the first days of a month
  // or a slow comparison load are not reported as changes. New Actors are not
  // marked.
  function compareSnapshot(analysis, baseline) {
    analysis.changes = null;
    for (const row of analysis.rows) row.change = null;
    if (!baseline?.actors) return analysis;
    const paceKnown = !!baseline.pace && analysis.thresholds.paceReady;
    const compared = (key) => paceKnown || !PACE_ACTIONS.includes(key);
    let count = 0;
    for (const row of analysis.rows) {
      const was = baseline.actors[row.id];
      if (!was) continue;
      const [group, ...wasActions] = was;
      const then = wasActions.filter(compared);
      const now = row.actions.map((item) => item.key).filter(compared);
      const added = now.filter((key) => !then.includes(key));
      const removed = then.filter((key) => !now.includes(key));
      const groupBefore = group !== row.group && GROUPS.some((item) => item.key === group) ? group : null;
      if (!groupBefore && !added.length && !removed.length) continue;
      row.change = { group: groupBefore, added, removed };
      count++;
    }
    analysis.changes = { since: baseline.day, count };
    return analysis;
  }

  // Page buttons for a pager: the first and last page, the current page and
  // its neighbours, and null where pages are skipped. Pages are 0-based.
  function pageButtons(page, pageCount) {
    if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index);
    const start = Math.max(1, Math.min(page - 1, pageCount - 4));
    const end = Math.min(pageCount - 2, Math.max(page + 1, 3));
    const pages = [0];
    if (start > 1) pages.push(null);
    for (let index = start; index <= end; index++) pages.push(index);
    if (end < pageCount - 2) pages.push(null);
    pages.push(pageCount - 1);
    return pages;
  }

  self.AAP_PORTFOLIO_MODEL = {
    GROUPS,
    ACTIONS,
    normalizeRows,
    previousMonthKey,
    monthDays,
    analyze,
    hasAction,
    snapshot,
    compareSnapshot,
    pageButtons,
  };
})();
