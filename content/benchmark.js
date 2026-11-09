/* Adds automatic local Builder Benchmark ranks to Apify profile metrics. */
(function () {
  const TAG_SLOT_SELECTOR = "[data-aap-profile-benchmark-tag]";
  const TARGET_NAME = "builder-benchmark-target";
  // Ranks compare the builder's live numbers against the daily cohort file.
  // A profile visit reuses live numbers up to this old; an open profile page
  // refetches them, and rechecks the cohort file, this often while visible.
  const TARGET_TTL_MS = 15 * 60 * 1000;
  const ROUTE_REFRESH_MS = TARGET_TTL_MS;
  const SNAPSHOT_TTL_MS = AAP_BENCHMARK.SNAPSHOT_TTL_MS || 24 * 60 * 60 * 1000;
  const SHARED_SNAPSHOT_URL = "https://gist.githubusercontent.com/Devansh-365/5cffdc0292be6bf8f8223eaa33ae1d74/raw";
  const PAGE_SIZE = 1000;
  const SCAN_PAGE_INTERVAL_MS = 1_100;
  const MAX_SNAPSHOT_AGE_MS = 48 * 60 * 60 * 1000;
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
    // Whether targetBuilder holds the live profile numbers rather than the
    // daily file's copy.
    targetLive: false,
    // The last live fetch failed while the daily file's copy is shown.
    liveFailed: false,
    refreshedAt: 0,
    scanStatus: "idle",
    scanError: null,
    slots: new Map(),
  };

  let activeScan = null;
  let sharedSnapshotMemory = null;
  let sharedSnapshotFetchedAt = 0;
  let sharedSnapshotPromise = null;
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
    if (!(self.AAP_FEATURES?.enabled("benchmark") ?? true)) return null;
    return AAP_CONTEXT.isPublicSite() ? AAP_PROFILE_SORT.profileRoute(location.pathname) : null;
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
        stale: state.snapshotStale || state.scanStatus === "incomplete" || (state.liveFailed && !state.targetLive),
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

  function setSnapshotTarget(routeKey, snapshot = state.snapshot) {
    return setTargetBuilder(routeKey, AAP_BENCHMARK.findBuilder(snapshot?.builders, routeKey));
  }

  async function fetchSharedSnapshot() {
    const url = new URL(SHARED_SNAPSHOT_URL);
    // One URL per day, revalidated with no-cache: an unchanged file costs a
    // conditional request, and a new day's key gets past any CDN copy.
    url.searchParams.set("v", Math.floor(Date.now() / SNAPSHOT_TTL_MS));
    const response = await fetch(url.toString(), {
      cache: "no-cache",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Shared Builder Benchmark request failed: HTTP ${response.status}`);
    const snapshot = await response.json();
    if (!AAP_BENCHMARK.validateSnapshot(snapshot)) throw new Error("The shared Builder Benchmark snapshot is invalid.");
    return snapshot;
  }

  // A visit reuses the tab's copy for one refresh window; a periodic
  // refresh rechecks the file so a newly published day shows up.
  function loadSharedSnapshot(recheck = false) {
    if (!recheck && sharedSnapshotMemory && Date.now() - sharedSnapshotFetchedAt < ROUTE_REFRESH_MS) {
      return Promise.resolve(sharedSnapshotMemory);
    }
    if (sharedSnapshotPromise) return sharedSnapshotPromise;

    const operation = fetchSharedSnapshot()
      .then((snapshot) => {
        sharedSnapshotMemory = snapshot;
        sharedSnapshotFetchedAt = Date.now();
        return snapshot;
      })
      .finally(() => {
        if (sharedSnapshotPromise === operation) sharedSnapshotPromise = null;
      });
    sharedSnapshotPromise = operation;
    return operation;
  }

  // Every page of the builder's public Actors, fetched past the API cache
  // and aggregated exactly as the daily publisher does (all Actors,
  // including unrunnable ones), so the two are comparable.
  async function fetchLiveBuilder(routeKey, username) {
    const actors = [];
    let offset = 0;
    let total = null;
    do {
      const response = await AAP_API.publicActorStore(username, {
        limit: PAGE_SIZE,
        offset,
        sortBy: "relevance",
        includeUnrunnableActors: true,
        priority: "foreground",
        cacheMode: "no-store",
      });
      const page = AAP_PROFILE_SORT.normalizeStoreResponse(response, offset);
      total = AAP_PROFILE_SORT.storeTotal(response);
      actors.push(...page);
      if (!page.length) break;
      offset += page.length;
    } while (offset < total);
    return AAP_BENCHMARK.findBuilder(AAP_BENCHMARK.aggregateActors(actors).builders, routeKey);
  }

  // The daily file's copy of the builder shows a rank right away; the live
  // profile numbers then replace it, so the rank follows today's numbers
  // instead of yesterday's.
  async function loadTargetBuilder(routeKey, username, snapshotPromise, fresh = false) {
    if (state.targetBuilderPromise) return state.targetBuilderPromise;
    if (!state.targetBuilder) state.targetBuilderStatus = "loading";
    const operation = (async () => {
      try {
        if (snapshotPromise) await snapshotPromise;
        if (state.routeKey !== routeKey) return;
        if (!state.targetLive && setSnapshotTarget(routeKey)) render();

        const cached = fresh ? null : await AAP_CACHE.getView(TARGET_NAME, TARGET_TTL_MS, targetCacheScope(routeKey));
        if (state.routeKey !== routeKey) return;
        let target = cached?.hit && !cached.stale ? findTargetBuilder(cached.data, routeKey) : null;
        if (!target) {
          target = await fetchLiveBuilder(routeKey, username);
          if (state.routeKey !== routeKey) return;
          if (!target) throw new Error("The profile Actor data did not include this builder.");
          // Do not block the visible rank tag on this small persistence write.
          AAP_CACHE.setView(TARGET_NAME, target, targetCacheScope(routeKey)).catch(() => {});
        }
        if (setTargetBuilder(routeKey, target)) {
          state.targetLive = true;
          state.liveFailed = false;
        }
      } catch (error) {
        if (state.routeKey !== routeKey) return;
        // With an earlier copy in hand the rank stays up; the daily file's
        // copy is marked stale, and only a page with nothing to rank says it
        // is unavailable.
        state.liveFailed = true;
        if (!state.targetBuilder) {
          state.targetBuilderStatus = "unavailable";
          state.scanError = AAPF.errorText(error, "The profile Actor data could not be loaded.");
        }
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

  function snapshotTooOld(snapshot) {
    const capturedAt = Date.parse(snapshot?.capturedAt);
    return Number.isFinite(capturedAt) && Date.now() - capturedAt > MAX_SNAPSHOT_AGE_MS;
  }

  // A periodic recheck never starts a Store scan: that runs once per visit,
  // only when no cohort file could be loaded.
  async function loadSnapshot(routeKey, recheck = false) {
    if (state.snapshotPromise) return state.snapshotPromise;
    const operation = (async () => {
      const previousSnapshot = sharedSnapshotMemory;
      try {
        const sharedSnapshot = await loadSharedSnapshot(recheck);
        if (state.routeKey !== routeKey) return;
        state.snapshot = sharedSnapshot;
        // The daily refresh can fail; label ranks from an old snapshot as
        // stale instead of presenting them as current.
        state.snapshotStale = snapshotTooOld(sharedSnapshot);
        state.scanError = null;
      } catch (error) {
        if (state.routeKey !== routeKey) return;
        if (previousSnapshot && AAP_BENCHMARK.validateSnapshot(previousSnapshot)) {
          state.snapshot = previousSnapshot;
          // A failed recheck keeps a copy that is still within its day.
          state.snapshotStale = recheck ? snapshotTooOld(previousSnapshot) : true;
        }
        state.scanError = AAPF.errorText(error, "The shared benchmark snapshot could not be loaded.");
      }

      if (state.routeKey !== routeKey) return;
      if (state.snapshotPromise === operation) state.snapshotPromise = null;
      const shouldAutoScan = !recheck && !activeScan && !state.snapshot;
      if (shouldAutoScan) {
        state.scanStatus = "scanning";
        state.scanError = null;
      } else if (activeScan) {
        state.scanStatus = "scanning";
      } else if (state.snapshotStale) {
        state.scanStatus = "incomplete";
      } else {
        state.scanStatus = "complete";
      }
      render();
      if (shouldAutoScan) startScan();
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
        const sharedSnapshotLoaded = state.snapshot?.scan?.distribution === "shared";
        if ((!sharedSnapshotLoaded && state.snapshot === previousSnapshot) || !state.snapshot) {
          state.snapshot = snapshot;
          state.snapshotStale = false;
        }
        // A scan's copy of the builder never replaces its live numbers.
        if (state.routeKey && state.snapshot === snapshot && !state.targetLive) setSnapshotTarget(state.routeKey, snapshot);
        state.scanStatus = "complete";
        state.scanError = null;
        render();
        return snapshot;
      })
      .catch((error) => {
        if (activeScan === operation) activeScan = null;
        state.scanStatus = "incomplete";
        state.scanError = AAPF.errorText(error, "Scan incomplete — no rank published");
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
    state.targetLive = false;
    state.liveFailed = false;
    state.scanStatus = activeScan ? "scanning" : "idle";
    state.scanError = null;
    state.slots = new Map();
    render();
    refreshRoute(route, false);
  }

  // Loads the cohort file and the live numbers without clearing what is on
  // screen, so a refresh never blanks the tags. A periodic refresh skips
  // the caches, so it always brings this window's numbers.
  function refreshRoute(route, periodic) {
    state.refreshedAt = Date.now();
    const snapshotPromise = loadSnapshot(route.key, periodic);
    loadTargetBuilder(route.key, route.username, snapshotPromise, periodic);
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
    state.targetLive = false;
    state.liveFailed = false;
    state.refreshedAt = 0;
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
    // A profile left open keeps its ranks current while someone looks at it.
    if (document.visibilityState !== "hidden" && Date.now() - state.refreshedAt > ROUTE_REFRESH_MS) refreshRoute(route, true);
    if (activeScan && state.scanStatus !== "scanning") {
      state.scanStatus = "scanning";
      render();
    }
  }

  sync();
  self.AAP_FEATURES?.onChange(sync);
  const poll = AAP_LIFECYCLE.every(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      sync();
      return;
    }
    sync();
  }, 500);
  window.addEventListener("beforeunload", () => clearInterval(poll));
})();
