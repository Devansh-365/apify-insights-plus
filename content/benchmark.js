/* Adds the local Builder Benchmark tag and automatic background Store scan to profiles. */
(function () {
  const PROFILE_STATS_HOST_CLASS = "aap-profile-extra-metrics";
  const TAG_SLOT_SELECTOR = "[data-aap-profile-benchmark-tag]";
  const DETAILS_SELECTOR = "[data-aap-profile-benchmark-details]";
  const SNAPSHOT_NAME = "builder-benchmark";
  const SNAPSHOT_SCOPE = "local";
  const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
  const PAGE_SIZE = 1000;
  const SCAN_PAGE_INTERVAL_MS = 1_100;
  const METRIC_PREFERENCE_KEY = "aap.builderBenchmark.metric";
  const state = {
    routeKey: null,
    username: null,
    metricKey: "monthlyRuns",
    snapshot: null,
    snapshotStale: false,
    snapshotLoaded: false,
    snapshotPromise: null,
    scanStatus: "idle",
    scanError: null,
    expanded: false,
    slot: null,
    region: null,
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

  function formatCompact(value) {
    if (value == null || !Number.isFinite(Number(value))) return "–";
    return new Intl.NumberFormat(undefined, {
      notation: "compact",
      maximumFractionDigits: Number(value) >= 1000 ? 1 : 0,
    }).format(Number(value));
  }

  function formatNumber(value) {
    if (value == null || !Number.isFinite(Number(value))) return "–";
    return new Intl.NumberFormat().format(Number(value));
  }

  function formatPercentile(value) {
    return value == null ? "–" : `${Math.round(value)}th percentile`;
  }

  function formatTimestamp(value) {
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return "Unknown";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
  }

  function metricPreference() {
    try {
      const value = localStorage.getItem(METRIC_PREFERENCE_KEY);
      return AAP_BENCHMARK.METRIC_DEFINITIONS.some((metric) => metric.key === value) ? value : "monthlyRuns";
    } catch {
      return "monthlyRuns";
    }
  }

  function saveMetricPreference(value) {
    try {
      localStorage.setItem(METRIC_PREFERENCE_KEY, value);
    } catch {
      // A preference is optional; a storage restriction must not break the UI.
    }
  }

  function responseTotal(response) {
    const value = Number(AAP_PROFILE_SORT.responseData(response)?.total);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
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

  function currentResult() {
    if (!state.snapshot || !state.routeKey) return null;
    return AAP_BENCHMARK.rankForBuilder(state.snapshot.builders, state.routeKey, state.metricKey);
  }

  function scanStatusText() {
    if (state.scanStatus === "scanning") {
      const indexed = formatNumber(scanProgress.indexedActors);
      const expected = scanProgress.expectedActors == null ? "…" : formatNumber(scanProgress.expectedActors);
      return `Scanning public Actors · ${indexed} of ${expected}`;
    }
    if (state.scanStatus === "incomplete") return state.scanError || "Scan incomplete — no rank published";
    if (state.snapshotStale) return "Using the last complete snapshot · refresh to update";
    return "";
  }

  function renderTag() {
    if (!state.slot?.isConnected) return;
    const result = currentResult();
    const model = AAP_BENCHMARK.buildTagModel({
      status: state.scanStatus,
      metricKey: state.metricKey,
      result,
      snapshot: state.snapshot,
      stale: state.snapshotStale || state.scanStatus === "incomplete",
    });
    const button = createElement("button", `aap-profile-benchmark-tag aap-profile-benchmark-tag-${model.state}`, model.label);
    button.type = "button";
    button.setAttribute("aria-label", model.ariaLabel);
    button.setAttribute("aria-expanded", state.expanded ? "true" : "false");
    if (state.region?.id) button.setAttribute("aria-controls", state.region.id);
    button.title = model.ariaLabel;
    button.addEventListener("click", () => {
      state.expanded = !state.expanded;
      render();
    });
    state.slot.replaceChildren(button);
  }

  function appendMetricSelect(panel) {
    const field = createElement("label", "aap-profile-benchmark-field");
    field.appendChild(createElement("span", "aap-profile-benchmark-field-label", "Compare by"));
    const select = createElement("select", "aap-profile-benchmark-select");
    select.setAttribute("aria-label", "Builder Benchmark metric");
    for (const metric of AAP_BENCHMARK.METRIC_DEFINITIONS) {
      const option = createElement("option", null, metric.label);
      option.value = metric.key;
      option.selected = metric.key === state.metricKey;
      select.appendChild(option);
    }
    select.addEventListener("change", () => {
      state.metricKey = select.value;
      saveMetricPreference(state.metricKey);
      render();
    });
    field.appendChild(select);
    panel.appendChild(field);
  }

  function appendBenchmarkSummary(panel, result) {
    const summary = createElement("div", "aap-profile-benchmark-summary");
    const value = result?.row ? formatNumber(result.row.value) : "Not observed";
    const rank = result?.row ? `#${result.row.rank}` : "–";
    const percentile = result?.row ? formatPercentile(result.row.percentile) : "Not ranked";
    const cells = [
      ["Your value", value],
      ["Rank", rank],
      ["Percentile", percentile],
    ];
    for (const [label, text] of cells) {
      const cell = createElement("div", "aap-profile-benchmark-summary-cell");
      cell.append(
        createElement("span", "aap-profile-benchmark-summary-label", label),
        createElement("strong", "aap-profile-benchmark-summary-value", text),
      );
      summary.appendChild(cell);
    }
    panel.appendChild(summary);
  }

  function appendPeerList(panel, result) {
    if (!result?.rows?.length) return;
    const section = createElement("div", "aap-profile-benchmark-peers");
    section.appendChild(createElement("div", "aap-profile-benchmark-section-label", "Top observed builders"));
    const list = createElement("ol", "aap-profile-benchmark-peer-list");
    for (const entry of result.rows.slice(0, 3)) {
      const item = createElement("li", "aap-profile-benchmark-peer");
      const name = createElement("span", "aap-profile-benchmark-peer-name", entry.builder.displayName || entry.builder.key);
      name.title = entry.builder.key;
      item.append(
        createElement("span", "aap-profile-benchmark-peer-rank", `#${entry.rank}`),
        name,
        createElement("strong", "aap-profile-benchmark-peer-value", formatCompact(entry.value)),
      );
      list.appendChild(item);
    }
    section.appendChild(list);
    panel.appendChild(section);
  }

  function appendAction(panel) {
    const actions = createElement("div", "aap-profile-benchmark-actions");
    const actionLabel = state.scanStatus === "incomplete"
      ? "Retry scan"
      : state.snapshot
        ? "Refresh benchmark"
        : "";
    if (!actionLabel) return;
    const action = createElement("button", "aap-profile-benchmark-action", actionLabel);
    action.type = "button";
    action.addEventListener("click", () => startScan());
    actions.appendChild(action);
    panel.appendChild(actions);
  }

  function renderDetails() {
    if (!state.region?.isConnected) return;
    state.region.hidden = !state.expanded;
    if (!state.expanded) {
      state.region.replaceChildren();
      return;
    }
    const panel = createElement("div", "aap-profile-benchmark-panel");
    const heading = createElement("div", "aap-profile-benchmark-panel-heading");
    heading.append(
      createElement("strong", "aap-profile-benchmark-panel-title", "Builder benchmark"),
      createElement("span", "aap-profile-benchmark-scope", "Local observed cohort"),
    );
    panel.appendChild(heading);
    appendMetricSelect(panel);

    const result = currentResult();
    const metric = AAP_BENCHMARK.metricDefinition(state.metricKey);
    panel.appendChild(createElement("div", "aap-profile-benchmark-meta", `${metric.label} · ${metric.sourceLabel}`));
    if (state.snapshot) {
      appendBenchmarkSummary(panel, result);
      const cohort = result?.cohortSize || 0;
      const coverage = `${formatNumber(cohort)} complete builders · ${formatNumber(state.snapshot.scan?.indexedActors || 0)} indexed Actors`;
      panel.appendChild(createElement(
        "div",
        "aap-profile-benchmark-meta",
        result?.row ? `Rank ${result.row.rank} of ${coverage}` : `The visited builder is not in this local scan · ${coverage}`,
      ));
      panel.appendChild(createElement("div", "aap-profile-benchmark-meta", `Snapshot captured ${formatTimestamp(state.snapshot.capturedAt)}`));
      appendPeerList(panel, result);
    } else {
      panel.appendChild(createElement("p", "aap-profile-benchmark-empty", state.scanStatus === "scanning"
        ? "Preparing the local observed cohort…"
        : "The local ranking is prepared automatically from public Actor data."));
    }

    const status = createElement("div", "aap-profile-benchmark-status", scanStatusText());
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    if (state.scanError) status.classList.add("aap-profile-benchmark-status-error");
    panel.appendChild(status);
    appendAction(panel);
    state.region.replaceChildren(panel);
  }

  function render() {
    renderTag();
    renderDetails();
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
        if (state.routeKey === routeKey) {
          state.snapshotLoaded = true;
          if (state.snapshotPromise === operation) state.snapshotPromise = null;
          const shouldAutoScan = !activeScan && (!state.snapshot || state.snapshotStale);
          if (shouldAutoScan) {
            state.scanStatus = "scanning";
            state.scanError = null;
          } else if (!activeScan) {
            state.scanStatus = "idle";
          }
          render();
          if (shouldAutoScan) startScan();
        }
      }
    })();
    state.snapshotPromise = operation;
    return operation;
  }

  async function scanStore(previousSnapshot) {
    const capturedAt = new Date().toISOString();
    const accumulator = AAP_BENCHMARK.createAccumulator({
      previousFirstSeen: previousSnapshot?.actorFirstSeen || null,
      firstSeenAt: capturedAt,
    });
    let expectedActors = null;
    let offset = 0;
    let pageCount = 0;
    const visitedOffsets = new Set();

    while (true) {
      if (visitedOffsets.has(offset)) throw new Error("The public Store returned a repeated page offset.");
      if (pageCount > 0) await wait(SCAN_PAGE_INTERVAL_MS);
      visitedOffsets.add(offset);
      const response = await AAP_API.publicStorePage({
        limit: PAGE_SIZE,
        offset,
        sortBy: "relevance",
        priority: "background",
        cacheMode: "no-store",
      });
      const pageTotal = responseTotal(response);
      if (expectedActors == null && pageTotal != null) expectedActors = pageTotal;
      if (expectedActors != null && pageTotal != null && pageTotal !== expectedActors) {
        throw new Error("The public Store changed while the benchmark was scanning. Retry the scan.");
      }
      const actors = AAP_PROFILE_SORT.normalizeStoreResponse(response, offset);
      if (!actors.length) {
        if (expectedActors != null && offset < expectedActors) throw new Error("The public Store returned an incomplete page.");
        break;
      }
      AAP_BENCHMARK.addActors(accumulator, actors);
      pageCount++;
      scanProgress = { expectedActors, indexedActors: accumulator.indexedActors, pageCount };
      if (state.scanStatus === "scanning") render();

      const nextOffset = offset + PAGE_SIZE;
      if (expectedActors != null && nextOffset >= expectedActors) break;
      if (actors.length < PAGE_SIZE) {
        if (expectedActors == null) break;
        throw new Error("The public Store ended before its reported total. Retry the scan.");
      }
      offset = nextOffset;
    }

    if (expectedActors == null) expectedActors = accumulator.indexedActors;
    if (accumulator.conflictingActors) throw new Error("The public Store returned conflicting data for an Actor. Retry the scan.");
    if (accumulator.indexedActors !== expectedActors) {
      throw new Error(`Scan coverage is incomplete: ${accumulator.indexedActors.toLocaleString()} of ${expectedActors.toLocaleString()} Actors indexed.`);
    }

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
        missingFields: missingFieldCounts(builders),
        definitionVersion: 1,
        baseline: !previousSnapshot,
      },
    });
    if (!AAP_BENCHMARK.validateSnapshot(snapshot)) throw new Error("The benchmark snapshot failed validation.");
    await AAP_CACHE.setView(SNAPSHOT_NAME, snapshot, SNAPSHOT_SCOPE);
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
    const operation = scanStore(previousSnapshot)
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

  function ensureRoute(route) {
    if (state.routeKey !== route.key) {
      state.routeKey = route.key;
      state.username = route.username;
      state.metricKey = metricPreference();
      state.snapshot = null;
      state.snapshotStale = false;
      state.snapshotLoaded = false;
      state.snapshotPromise = null;
      state.scanStatus = "scanning";
      state.scanError = null;
      state.expanded = false;
      state.slot = null;
      state.region = null;
      loadSnapshot(route.key);
    }
    const host = document.querySelector(`.${PROFILE_STATS_HOST_CLASS}`);
    const slot = host?.querySelector(TAG_SLOT_SELECTOR);
    const region = host?.querySelector(DETAILS_SELECTOR);
    if (slot !== state.slot || region !== state.region) {
      state.slot = slot;
      state.region = region;
      if (activeScan) state.scanStatus = "scanning";
      render();
    }
  }

  function removePage() {
    state.routeKey = null;
    state.username = null;
    state.snapshot = null;
    state.snapshotStale = false;
    state.snapshotLoaded = false;
    state.snapshotPromise = null;
    state.scanStatus = "idle";
    state.scanError = null;
    state.expanded = false;
    state.slot = null;
    state.region = null;
  }

  function sync() {
    const route = profileRoute();
    if (!route) {
      if (state.routeKey || state.slot || state.region) removePage();
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
