/* Pure aggregation, ranking, snapshot, and compact-tag helpers for the local Builder Benchmark. */
(function () {
  // Bump when the normalized metric contract changes so older snapshots are
  // rebuilt instead of publishing incomplete ranks from a previous scan.
  const SCHEMA_VERSION = 5;
  const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
  const SOURCE = "public-store-local-scan";
  const METRIC_DEFINITIONS = [
    {
      key: "totalActors",
      label: "Total Actors",
      shortLabel: "Actors",
      sourceLabel: "public Actors",
    },
    {
      key: "monthlyUsers",
      label: "Monthly users",
      shortLabel: "Monthly users",
      sourceLabel: "summed Actor instances",
    },
    {
      key: "totalUsers",
      label: "Total users",
      shortLabel: "Total users",
      sourceLabel: "summed Actor instances",
    },
    {
      key: "monthlyRuns",
      label: "Monthly runs",
      shortLabel: "Monthly runs",
      sourceLabel: "public 30-day field",
    },
    {
      key: "totalRuns",
      label: "Total runs",
      shortLabel: "Total runs",
      sourceLabel: "owner-inclusive source scope",
    },
    {
      key: "newlyIndexedActors",
      label: "Newly indexed Actors",
      shortLabel: "New Actors",
      sourceLabel: "local history",
    },
  ];
  const METRIC_KEYS = new Set(METRIC_DEFINITIONS.map((metric) => metric.key));
  const ACTOR_METRICS = ["monthlyUsers", "totalUsers", "monthlyRuns", "totalRuns"];

  function metricDefinition(key) {
    return METRIC_DEFINITIONS.find((metric) => metric.key === key) || METRIC_DEFINITIONS[3];
  }

  function finiteNonNegative(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  function normalizeBuilderKey(value) {
    const key = String(value || "").trim().replace(/^@+/, "").toLowerCase();
    return key && !/[/?#\s]/.test(key) ? key : "";
  }

  function actorIdentity(actor) {
    const id = String(actor?.id || "").trim();
    if (id) return id;
    const username = normalizeBuilderKey(actor?.username);
    const name = String(actor?.name || actor?.title || "").trim().toLowerCase();
    return username && name ? `${username}/${name}` : "";
  }

  function actorSignature(actor) {
    return [
      actor?.id,
      actor?.username,
      actor?.name,
      ...ACTOR_METRICS.map((key) => actor?.[key] == null ? "" : actor[key]),
    ].map((value) => String(value ?? "")).join("\u001f");
  }

  function createAccumulator(options = {}) {
    return {
      builders: new Map(),
      actors: new Map(),
      previousFirstSeen: options.previousFirstSeen && typeof options.previousFirstSeen === "object"
        ? options.previousFirstSeen
        : null,
      firstSeenAt: options.firstSeenAt || new Date().toISOString(),
      indexedActors: 0,
      duplicateActors: 0,
      conflictingActors: 0,
      missingBuilderKeys: 0,
      newlyIndexedActors: 0,
    };
  }

  function ensureBuilder(accumulator, actor, builderKey) {
    let builder = accumulator.builders.get(builderKey);
    if (builder) return builder;
    builder = {
      key: builderKey,
      displayName: String(actor?.userFullName || actor?.username || builderKey).trim() || builderKey,
      actorCount: 0,
      metrics: {
        totalActors: 0,
        monthlyUsers: 0,
        totalUsers: 0,
        monthlyRuns: 0,
        totalRuns: 0,
        newlyIndexedActors: 0,
      },
      missing: Object.create(null),
    };
    accumulator.builders.set(builderKey, builder);
    return builder;
  }

  function addActor(accumulator, actor) {
    if (!accumulator || !actor || typeof actor !== "object") return false;
    const id = actorIdentity(actor);
    if (!id) return false;
    const signature = actorSignature(actor);
    const existing = accumulator.actors.get(id);
    if (existing) {
      accumulator.duplicateActors++;
      if (existing !== signature) accumulator.conflictingActors++;
      return false;
    }
    accumulator.actors.set(id, signature);
    accumulator.indexedActors++;

    const builderKey = normalizeBuilderKey(actor.username);
    if (!builderKey) {
      accumulator.missingBuilderKeys++;
      return true;
    }
    const builder = ensureBuilder(accumulator, actor, builderKey);
    builder.actorCount++;
    builder.metrics.totalActors = builder.actorCount;

    const isNewActor = accumulator.previousFirstSeen
      && !Object.prototype.hasOwnProperty.call(accumulator.previousFirstSeen, id);
    if (accumulator.previousFirstSeen) {
      if (isNewActor) {
        builder.metrics.newlyIndexedActors++;
        accumulator.newlyIndexedActors++;
      }
    } else {
      builder.missing.newlyIndexedActors = builder.actorCount;
    }

    for (const key of ACTOR_METRICS) {
      const value = finiteNonNegative(actor[key]);
      if (value == null) {
        builder.missing[key] = (builder.missing[key] || 0) + 1;
      } else {
        builder.metrics[key] += value;
      }
    }
    return true;
  }

  function addActors(accumulator, actors) {
    for (const actor of Array.isArray(actors) ? actors : []) addActor(accumulator, actor);
    return accumulator;
  }

  function finalizeBuilders(accumulator) {
    return [...(accumulator?.builders?.values() || [])]
      .map((builder) => ({
        key: builder.key,
        displayName: builder.displayName,
        actorCount: builder.actorCount,
        metrics: { ...builder.metrics },
        missing: { ...builder.missing },
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  function aggregateActors(actors, options = {}) {
    const accumulator = createAccumulator(options);
    addActors(accumulator, actors);
    return {
      builders: finalizeBuilders(accumulator),
      indexedActors: accumulator.indexedActors,
      duplicateActors: accumulator.duplicateActors,
      conflictingActors: accumulator.conflictingActors,
      missingBuilderKeys: accumulator.missingBuilderKeys,
      newlyIndexedActors: accumulator.newlyIndexedActors,
    };
  }

  function metricValue(builder, metricKey) {
    if (!METRIC_KEYS.has(metricKey) || !builder) return null;
    if (builder.missing?.[metricKey]) return null;
    const value = finiteNonNegative(builder.metrics?.[metricKey]);
    return value == null ? null : value;
  }

  function compareBuilderKeys(left, right) {
    return String(left?.key || "").localeCompare(String(right?.key || ""), undefined, { sensitivity: "base" });
  }

  function rankBuilders(builders, metricKey = "monthlyRuns") {
    const source = Array.isArray(builders) ? builders : [];
    const eligible = source
      .map((builder) => ({ builder, value: metricValue(builder, metricKey) }))
      .filter((entry) => entry.value != null)
      .sort((left, right) => right.value - left.value || compareBuilderKeys(left.builder, right.builder));
    const cohortSize = eligible.length;
    let previousValue = null;
    let previousRank = 0;
    const rows = eligible.map((entry, index) => {
      const rank = previousValue === entry.value ? previousRank : index + 1;
      previousValue = entry.value;
      previousRank = rank;
      const percentile = cohortSize >= 2 ? (100 * (cohortSize - rank)) / (cohortSize - 1) : null;
      return {
        builder: entry.builder,
        value: entry.value,
        rank,
        percentile,
      };
    });
    return {
      metricKey,
      metric: metricDefinition(metricKey),
      rows,
      cohortSize,
      indexedBuilderCount: source.length,
      missingBuilderCount: source.length - cohortSize,
    };
  }

  function findBuilder(builders, builderKey) {
    const normalized = normalizeBuilderKey(builderKey);
    return (Array.isArray(builders) ? builders : []).find((builder) => builder.key === normalized) || null;
  }

  function mergeBuilder(builders, override) {
    const source = Array.isArray(builders) ? builders : [];
    const key = normalizeBuilderKey(override?.key);
    if (!key) return [...source];
    const replacement = {
      ...override,
      key,
      metrics: { ...(override.metrics || {}) },
      missing: { ...(override.missing || {}) },
    };
    let replaced = false;
    const result = source.map((builder) => {
      if (builder.key !== key) return builder;
      replaced = true;
      return replacement;
    });
    if (!replaced) result.push(replacement);
    return result;
  }

  function rankForBuilder(builders, builderKey, metricKey = "monthlyRuns") {
    const result = rankBuilders(builders, metricKey);
    const key = normalizeBuilderKey(builderKey);
    return { ...result, row: result.rows.find((entry) => entry.builder.key === key) || null };
  }

  function sameCohort(left, right, metricKey = "monthlyRuns") {
    const leftResult = rankBuilders(left?.builders || left, metricKey);
    const rightResult = rankBuilders(right?.builders || right, metricKey);
    if (leftResult.cohortSize !== rightResult.cohortSize) return false;
    const rightKeys = new Set(rightResult.rows.map((entry) => entry.builder.key));
    return leftResult.rows.every((entry) => rightKeys.has(entry.builder.key));
  }

  function rankMovement(snapshot, previousSnapshot, builderKey, metricKey = "monthlyRuns") {
    if (!snapshot || !previousSnapshot || snapshot.scan?.definitionVersion !== previousSnapshot.scan?.definitionVersion) {
      return null;
    }
    if (!sameCohort(snapshot, previousSnapshot, metricKey)) return null;
    const current = rankForBuilder(snapshot.builders, builderKey, metricKey).row;
    const previous = rankForBuilder(previousSnapshot.builders, builderKey, metricKey).row;
    if (!current || !previous) return null;
    return previous.rank - current.rank;
  }

  function buildSnapshot(options = {}) {
    const builders = Array.isArray(options.builders) ? options.builders : [];
    const actorFirstSeen = options.actorFirstSeen && typeof options.actorFirstSeen === "object"
      ? { ...options.actorFirstSeen }
      : {};
    const scan = options.scan && typeof options.scan === "object" ? { ...options.scan } : {};
    return {
      schemaVersion: SCHEMA_VERSION,
      state: "complete",
      source: SOURCE,
      capturedAt: options.capturedAt || new Date().toISOString(),
      scan: {
        expectedActors: Number.isFinite(Number(scan.expectedActors)) ? Number(scan.expectedActors) : builders.reduce((sum, builder) => sum + builder.actorCount, 0),
        indexedActors: Number.isFinite(Number(scan.indexedActors)) ? Number(scan.indexedActors) : builders.reduce((sum, builder) => sum + builder.actorCount, 0),
        sourceTotal: finiteNonNegative(scan.sourceTotal),
        sourceTotalChanged: Boolean(scan.sourceTotalChanged),
        sourceWindowEnded: Boolean(scan.sourceWindowEnded),
        coverage: scan.coverage === "observed" ? "observed" : "complete",
        builderCount: builders.length,
        pageCount: Number.isFinite(Number(scan.pageCount)) ? Number(scan.pageCount) : 0,
        missingFields: scan.missingFields && typeof scan.missingFields === "object" ? { ...scan.missingFields } : {},
        definitionVersion: Number.isFinite(Number(scan.definitionVersion)) ? Number(scan.definitionVersion) : 1,
        baseline: Boolean(scan.baseline),
        distribution: scan.distribution === "shared" ? "shared" : "local",
      },
      builders: builders.map((builder) => ({
        key: normalizeBuilderKey(builder.key),
        displayName: String(builder.displayName || builder.key || "Builder").trim(),
        actorCount: finiteNonNegative(builder.actorCount) || 0,
        metrics: { ...(builder.metrics || {}) },
        missing: { ...(builder.missing || {}) },
      })).filter((builder) => builder.key),
      actorFirstSeen,
    };
  }

  // A complete scan keeps actorFirstSeen in memory so the current page can
  // calculate history-based metrics. That map is not needed to rank the four
  // profile tags, however, and can make a global snapshot exceed Chrome's
  // per-entry storage limit. Keep a durable compact form for reloads.
  function compactSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return snapshot;
    return {
      ...snapshot,
      builders: (Array.isArray(snapshot.builders) ? snapshot.builders : []).map((builder) => ({
        key: builder.key,
        displayName: builder.displayName,
        actorCount: builder.actorCount,
        metrics: { ...(builder.metrics || {}) },
        missing: { ...(builder.missing || {}) },
      })),
      actorFirstSeen: {},
    };
  }

  // The rank-only fallback retains only data needed by the profile tags. It
  // is used only if a large compact snapshot still exceeds the view limit.
  function minimalSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return snapshot;
    return {
      ...snapshot,
      builders: (Array.isArray(snapshot.builders) ? snapshot.builders : []).map((builder) => ({
        key: builder.key,
        actorCount: finiteNonNegative(builder.actorCount) || 0,
        metrics: Object.fromEntries(ACTOR_METRICS
          .filter((key) => builder.metrics?.[key] != null)
          .map((key) => [key, builder.metrics[key]])),
        missing: Object.fromEntries(ACTOR_METRICS
          .filter((key) => builder.missing?.[key])
          .map((key) => [key, builder.missing[key]])),
      })),
      actorFirstSeen: {},
    };
  }

  function validateSnapshot(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== SCHEMA_VERSION || snapshot.state !== "complete" || snapshot.source !== SOURCE) return false;
    if (!Number.isFinite(Date.parse(snapshot.capturedAt))) return false;
    if (!Array.isArray(snapshot.builders) || !snapshot.scan || typeof snapshot.scan !== "object") return false;
    if (!Number.isFinite(Number(snapshot.scan.expectedActors)) || Number(snapshot.scan.expectedActors) < 0) return false;
    if (!Number.isFinite(Number(snapshot.scan.indexedActors)) || Number(snapshot.scan.indexedActors) < 0) return false;
    const keys = new Set();
    for (const builder of snapshot.builders) {
      if (!builder || !normalizeBuilderKey(builder.key) || keys.has(builder.key)) return false;
      keys.add(builder.key);
      if (!builder.metrics || typeof builder.metrics !== "object" || !builder.missing || typeof builder.missing !== "object") return false;
      if (!Number.isFinite(Number(builder.actorCount)) || Number(builder.actorCount) < 0) return false;
      for (const key of METRIC_DEFINITIONS.map((metric) => metric.key)) {
        if (builder.metrics[key] != null && !Number.isFinite(Number(builder.metrics[key]))) return false;
        if (builder.missing[key] != null && (!Number.isFinite(Number(builder.missing[key])) || Number(builder.missing[key]) < 0)) return false;
      }
    }
    return true;
  }

  function buildTagModel(options = {}) {
    const metric = metricDefinition(options.metricKey);
    const status = options.status || "idle";
    const result = options.result;
    const compact = Boolean(options.compact);
    if (status === "scanning") {
      return { state: "scanning", label: compact ? "…" : "Scanning…", ariaLabel: "Builder benchmark scan in progress", metric };
    }
    if (!options.snapshot) {
      if (status === "incomplete") {
        return {
          state: "incomplete",
          label: compact ? "—" : "Scan incomplete",
          ariaLabel: "Builder benchmark scan incomplete; no rank published",
          metric,
        };
      }
      if (status === "unavailable") {
        return {
          state: "unavailable",
          label: compact ? "—" : "Unavailable",
          ariaLabel: `${metric.label} benchmark is unavailable`,
          metric,
        };
      }
      return {
        state: "preparing",
        label: compact ? "…" : "Preparing…",
        ariaLabel: "Builder Benchmark is being prepared automatically",
        metric,
      };
    }
    if (!result?.row) {
      return {
        state: options.stale ? "stale" : "not-observed",
        label: compact ? "—" : options.stale ? "Not ranked · stale" : "Not observed",
        ariaLabel: options.stale ? `The visited builder is not ranked in the latest ${metric.label} snapshot` : "The visited builder is not in this local scan",
        metric,
      };
    }
    const label = compact ? `#${result.row.rank}` : `#${result.row.rank} · ${metric.shortLabel}${options.stale ? " · stale" : ""}`;
    const scan = options.snapshot.scan || {};
    const localOnly = scan.coverage === "observed" || scan.sourceWindowEnded || Number(scan.indexedActors) < Number(scan.expectedActors);
    const cohortText = scan.distribution === "shared"
      ? "shared public Store cohort"
      : localOnly
        ? "local observed cohort"
        : "local public Store cohort";
    const rankText = scan.distribution === "shared" ? "shared rank" : "local rank";
    const coverageText = localOnly && Number.isFinite(Number(scan.indexedActors)) && Number.isFinite(Number(scan.expectedActors))
      ? `; ${Number(scan.indexedActors).toLocaleString()} of ${Number(scan.expectedActors).toLocaleString()} Actors observed`
      : "";
    return {
      state: options.stale ? "stale" : "complete",
      label,
      ariaLabel: `${metric.label} ${rankText} ${result.row.rank} of ${result.cohortSize} ${cohortText}${coverageText}${options.stale ? " from a stale snapshot" : ""}`,
      metric,
      rank: result.row.rank,
      value: result.row.value,
      percentile: result.row.percentile,
      cohortSize: result.cohortSize,
    };
  }

  self.AAP_BENCHMARK = {
    ACTOR_METRICS,
    METRIC_DEFINITIONS,
    SCHEMA_VERSION,
    SNAPSHOT_TTL_MS,
    SOURCE,
    addActor,
    addActors,
    aggregateActors,
    buildSnapshot,
    buildTagModel,
    compactSnapshot,
    createAccumulator,
    finalizeBuilders,
    findBuilder,
    metricDefinition,
    metricValue,
    minimalSnapshot,
    mergeBuilder,
    normalizeBuilderKey,
    rankBuilders,
    rankForBuilder,
    rankMovement,
    sameCohort,
    validateSnapshot,
  };
})();
