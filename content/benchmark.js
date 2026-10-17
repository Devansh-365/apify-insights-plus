/* Adds automatic local Builder Benchmark ranks to Apify profile metrics. */
(function () {
  const TAG_SLOT_SELECTOR = "[data-aap-profile-benchmark-tag]";
  const SNAPSHOT_NAME = "builder-benchmark";
  const SNAPSHOT_SCOPE = "local";
  const TARGET_NAME = "builder-benchmark-target";
  const TARGET_TTL_MS = 15 * 60 * 1000;
  const SNAPSHOT_TTL_MS = AAP_BENCHMARK.SNAPSHOT_TTL_MS || 24 * 60 * 60 * 1000;
  const PAGE_SIZE = 1000;
  const SCAN_PAGE_INTERVAL_MS = 1_100;
  const SCAN_SORTS = ["relevance", "popularity", "newest", "lastUpdate"];
  const RANK_METRIC_KEYS = AAP_PROFILE_SORT.RANK_METRIC_KEYS || [
    "totalUsers",
    "monthlyUsers",
    "totalRuns",
    "monthlyRuns",
  ];
  const state = {
    routeKey: null,
    username: null,
    snapshot: null,
    snapshotStale: false,
    snapshotPromise: null,
    targetBuilder: null,
    targetBuilderPromise: null,
    targetBuilderStatus: "idle",
    scanStatus: "idle",
    scanError: null,
    slots: new Map(),
  };

  let activeScan = null;
  let scanProgress = { expectedActors: null, indexedActors: 0, pageCount: 0 };
  let lastPath = location.pathname;

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function profileRoute() {
    return AAP_PROFILE_SORT.profileRoute(location.pathname);
  }

  function responseTotal(response) {
    const value = Number(AAP_PROFILE_SORT.responseData(response)?.total);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  }

  function responsePageAdvance(response) {
    const value = Number(AAP_PROFILE_SORT.responseData(response)?.count);
    return Number.isFinite(value) && value > 0 && value <= PAGE_SIZE ? Math.floor(value) : PAGE_SIZE;
  }

  function missingFieldCounts(builders) {
    const counts = {};
    for (const builder of builders) {
      for (const key of AAP_BENCHMARK.ACTOR_METRICS) {
        if (builder.missing?.[key]) counts[key] = (counts[key] || 0) + 1;
      }
    }
    return counts;
  }

  function slotsMatch(left, right) {
    if (left.size !== right.size) return false;
    for (const [metricKey, slot] of left) {
      if (right.get(metricKey) !== slot) return false;
    }
    return true;
  }

  function collectSlots() {
    const mount = document.querySelector('[data-test="developer-metrics"]');
    const slots = new Map();
    for (const slot of mount?.querySelectorAll(TAG_SLOT_SELECTOR) || []) {
      const metricKey = slot.dataset.aapProfileBenchmarkTag;
      if (RANK_METRIC_KEYS.includes(metricKey)) slots.set(metricKey, slot);
    }
    return slots;
  }

  function currentResult(metricKey) {
    if (!state.snapshot || !state.routeKey || !state.targetBuilder) return null;
    const builders = AAP_BENCHMARK.mergeBuilder(state.snapshot.builders, state.targetBuilder);
    return AAP_BENCHMARK.rankForBuilder(builders, state.routeKey, metricKey);
  }

  function renderTags() {
    for (const [metricKey, slot] of state.slots) {
      if (!slot.isConnected) continue;
      const targetStatus = state.targetBuilderStatus === "loading"
        ? "scanning"
        : state.targetBuilderStatus === "unavailable"
          ? "unavailable"
          : state.snapshot
            ? "complete"
            : state.scanStatus;
      const model = AAP_BENCHMARK.buildTagModel({
        status: targetStatus,
        metricKey,
        result: currentResult(metricKey),
        snapshot: state.snapshot,
        stale: state.snapshotStale || state.scanStatus === "incomplete",
        compact: true,
      });
      const tag = createElement(
        "span",
        `aap-profile-benchmark-tag aap-profile-benchmark-tag-compact aap-profile-benchmark-tag-${model.state}`,
        model.label,
      );
      tag.setAttribute("aria-label", model.ariaLabel);
      tag.title = model.ariaLabel;
      slot.replaceChildren(tag);
    }
  }

  function targetCacheScope(routeKey) {
    return `profile:${routeKey}`;
  }

  function findTargetBuilder(value, routeKey) {
    if (!value || typeof value !== "object") return null;
    return AAP_BENCHMARK.findBuilder([value], routeKey);
  }

  function setTargetBuilder(routeKey, target) {
    if (state.routeKey !== routeKey || !target) return false;
    state.targetBuilder = target;
    state.targetBuilderStatus = "complete";
    return true;
  }

  async function loadTargetBuilder(routeKey, username, snapshotPromise) {
    if (state.targetBuilderPromise) return state.targetBuilderPromise;
    state.targetBuilderStatus = "loading";
    const operation = (async () => {
      try {
        // A fresh snapshot already contains the builder aggregate needed to
        // calculate every tag. Waiting for the snapshot read avoids fetching
        // the much larger profile Actor catalog on every profile visit.
        if (snapshotPromise) await snapshotPromise;
        if (state.routeKey !== routeKey) return;
        const snapshotTarget = AAP_BENCHMARK.findBuilder(state.snapshot?.builders, routeKey);
        if (setTargetBuilder(routeKey, snapshotTarget)) return;

        // A profile can be visited before the first benchmark scan finishes,
        // or it can be outside the locally observed Store cohort. Keep the
        // small aggregate durable so this fallback is also reusable.
        const cached = await AAP_CACHE.getView(TARGET_NAME, TARGET_TTL_MS, targetCacheScope(routeKey));
        const cachedTarget = cached.hit ? findTargetBuilder(cached.data, routeKey) : null;
        if (setTargetBuilder(routeKey, cachedTarget)) return;
        if (state.routeKey !== routeKey) return;

        const response = await AAP_API.publicActorStore(username, {
          limit: PAGE_SIZE,
          offset: 0,
          sortBy: "relevance",
          includeUnrunnableActors: true,
          priority: "foreground",
        });
        const actors = AAP_PROFILE_SORT.normalizeStoreResponse(response);
        const target = AAP_BENCHMARK.aggregateActors(actors).builders.find((builder) => builder.key === routeKey);
        if (!target) throw new Error("The profile Actor data did not include this builder.");
        setTargetBuilder(routeKey, target);
        // Do not block the visible rank tag on this small persistence write.
        AAP_CACHE.setView(TARGET_NAME, target, targetCacheScope(routeKey)).catch(() => {});
      } catch (error) {
        if (state.routeKey !== routeKey) return;
        state.targetBuilderStatus = "unavailable";
        state.scanError = error?.message || "The profile Actor data could not be loaded.";
      } finally {
        if (state.routeKey === routeKey) {
          if (state.targetBuilderPromise === operation) state.targetBuilderPromise = null;
          render();
        }
      }
    })();
    state.targetBuilderPromise = operation;
    return operation;
  }

  function render() {
    renderTags();
  }

  async function loadSnapshot(routeKey) {
    if (state.snapshotPromise) return state.snapshotPromise;
    const operation = (async () => {
      try {
        const cached = await AAP_CACHE.getView(SNAPSHOT_NAME, SNAPSHOT_TTL_MS, SNAPSHOT_SCOPE);
        if (state.routeKey !== routeKey || !cached.hit || !AAP_BENCHMARK.validateSnapshot(cached.data)) return;
        state.snapshot = cached.data;
        state.snapshotStale = Boolean(cached.stale);
      } catch (error) {
        if (state.routeKey === routeKey) state.scanError = error?.message || "The local benchmark snapshot could not be read.";
      } finally {
        if (state.routeKey !== routeKey) return;
        if (state.snapshotPromise === operation) state.snapshotPromise = null;
        const shouldAutoScan = !activeScan && (!state.snapshot || state.snapshotStale);
        if (shouldAutoScan) {
          state.scanStatus = "scanning";
          state.scanError = null;
        } else if (activeScan) {
          state.scanStatus = "scanning";
        } else {
          state.scanStatus = "complete";
        }
        render();
        if (shouldAutoScan) startScan();
      }
    })();
    state.snapshotPromise = operation;
    return operation;
  }

  async function scanStore(previousSnapshot) {
    const capturedAt = new Date().toISOString();
    const previousFirstSeen = previousSnapshot?.actorFirstSeen
      && Object.keys(previousSnapshot.actorFirstSeen).length
      ? previousSnapshot.actorFirstSeen
      : null;
    const accumulator = AAP_BENCHMARK.createAccumulator({
      previousFirstSeen,
      firstSeenAt: capturedAt,
    });
    let expectedActors = null;
    let pageCount = 0;
    let sourceTotalChanged = false;
    let sourceWindowEnded = false;

    async function scanSort(sortBy) {
      let offset = 0;
      let sortPageCount = 0;
      const visitedOffsets = new Set();
      while (true) {
        if (visitedOffsets.has(offset)) throw new Error(`The public Store returned a repeated ${sortBy} page offset.`);
        if (sortPageCount > 0) await wait(SCAN_PAGE_INTERVAL_MS);
        visitedOffsets.add(offset);
        const response = await AAP_API.publicStorePage({
          limit: PAGE_SIZE,
          offset,
          sortBy,
          includeUnrunnableActors: true,
          priority: "background",
          cacheMode: "no-store",
        });
        const pageTotal = responseTotal(response);
        if (expectedActors == null || (pageTotal != null && pageTotal > expectedActors)) expectedActors = pageTotal;
        if (expectedActors != null && pageTotal != null && pageTotal !== expectedActors) sourceTotalChanged = true;
        const actors = AAP_PROFILE_SORT.normalizeStoreResponse(response, offset);
        if (!actors.length) {
          // Apify's public Store can report a much larger total than the
          // public pagination window. Keep the observed cohort and label it as
          // local coverage instead of pretending it is a global leaderboard.
          if (expectedActors != null && offset < expectedActors) sourceWindowEnded = true;
          break;
        }
        AAP_BENCHMARK.addActors(accumulator, actors);
        sortPageCount++;
        pageCount++;
        scanProgress = { expectedActors, indexedActors: accumulator.indexedActors, pageCount };
        if (state.scanStatus === "scanning") render();

        const nextOffset = offset + responsePageAdvance(response);
        if (pageTotal != null && nextOffset >= pageTotal) break;
        offset = nextOffset;
      }
    }

    await Promise.all(SCAN_SORTS.map((sortBy) => scanSort(sortBy)));

    if (expectedActors == null) expectedActors = accumulator.indexedActors;
    // The Store orderings are scanned in parallel to widen the observable
    // cohort. A live Actor can appear in more than one ordering with slightly
    // different counters, so duplicate conflicts are expected; addActor keeps
    // the first observation and the scan remains usable.
    if (!accumulator.indexedActors && expectedActors) throw new Error("The public Store returned no observable Actors. Retry the scan.");

    const builders = AAP_BENCHMARK.finalizeBuilders(accumulator);
    const actorFirstSeen = { ...(previousSnapshot?.actorFirstSeen || {}) };
    for (const actorId of accumulator.actors.keys()) {
      if (!Object.prototype.hasOwnProperty.call(actorFirstSeen, actorId)) actorFirstSeen[actorId] = capturedAt;
    }
    const snapshot = AAP_BENCHMARK.buildSnapshot({
      builders,
      actorFirstSeen,
      capturedAt,
      scan: {
        expectedActors,
        indexedActors: accumulator.indexedActors,
        pageCount,
        sourceTotal: expectedActors,
        sourceTotalChanged,
        sourceWindowEnded,
        coverage: sourceWindowEnded || accumulator.indexedActors < expectedActors ? "observed" : "complete",
        missingFields: missingFieldCounts(builders),
        definitionVersion: 1,
        baseline: !previousFirstSeen,
      },
    });
    if (!AAP_BENCHMARK.validateSnapshot(snapshot)) throw new Error("The benchmark snapshot failed validation.");
    const saved = await AAP_CACHE.setView(SNAPSHOT_NAME, snapshot, SNAPSHOT_SCOPE);
    if (!saved) {
      const compactSaved = await AAP_CACHE.setView(
        SNAPSHOT_NAME,
        AAP_BENCHMARK.compactSnapshot(snapshot),
        SNAPSHOT_SCOPE,
      );
      if (!compactSaved) {
        await AAP_CACHE.setView(
          SNAPSHOT_NAME,
          AAP_BENCHMARK.minimalSnapshot(snapshot),
          SNAPSHOT_SCOPE,
        );
      }
    }
    return snapshot;
  }

  function startScan() {
    if (activeScan) {
      state.scanStatus = "scanning";
      state.scanError = null;
      render();
      return activeScan;
    }
    state.scanStatus = "scanning";
    state.scanError = null;
    scanProgress = { expectedActors: null, indexedActors: 0, pageCount: 0 };
    render();
    const previousSnapshot = state.snapshot;
    let operation;
    operation = scanStore(previousSnapshot)
      .then((snapshot) => {
        if (activeScan === operation) activeScan = null;
        if (state.snapshot === previousSnapshot || !state.snapshot) {
          state.snapshot = snapshot;
          state.snapshotStale = false;
        }
        state.scanStatus = "complete";
        state.scanError = null;
        render();
        return snapshot;
      })
      .catch((error) => {
        if (activeScan === operation) activeScan = null;
        state.scanStatus = "incomplete";
        state.scanError = error?.message || "Scan incomplete — no rank published";
        state.snapshotStale = Boolean(state.snapshot) || state.snapshotStale;
        render();
        return null;
      });
    activeScan = operation;
    return operation;
  }

  function beginRoute(route) {
    state.routeKey = route.key;
    state.username = route.username;
    state.snapshot = null;
    state.snapshotStale = false;
    state.snapshotPromise = null;
    state.targetBuilder = null;
    state.targetBuilderPromise = null;
    state.targetBuilderStatus = "loading";
    state.scanStatus = activeScan ? "scanning" : "idle";
    state.scanError = null;
    state.slots = new Map();
    render();
    const snapshotPromise = loadSnapshot(route.key);
    loadTargetBuilder(route.key, route.username, snapshotPromise);
  }

  function ensureRoute(route) {
    if (state.routeKey !== route.key) beginRoute(route);
    const slots = collectSlots();
    if (!slotsMatch(slots, state.slots)) {
      state.slots = slots;
      if (activeScan) state.scanStatus = "scanning";
      render();
    }
  }

  function removePage() {
    state.routeKey = null;
    state.username = null;
    state.snapshot = null;
    state.snapshotStale = false;
    state.snapshotPromise = null;
    state.targetBuilder = null;
    state.targetBuilderPromise = null;
    state.targetBuilderStatus = "idle";
    state.scanStatus = "idle";
    state.scanError = null;
    state.slots = new Map();
  }

  function sync() {
    const route = profileRoute();
    if (!route) {
      if (state.routeKey || state.slots.size) removePage();
      return;
    }
    ensureRoute(route);
    if (activeScan && state.scanStatus !== "scanning") {
      state.scanStatus = "scanning";
      render();
    }
  }

  sync();
  const poll = setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      sync();
      return;
    }
    sync();
  }, 500);
  window.addEventListener("beforeunload", () => clearInterval(poll));
})();
