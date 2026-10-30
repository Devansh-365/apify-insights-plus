(function () {
  const CACHE_CLEAR_KEY = "aap.cacheClearedAt";
  const CACHE_PREFIXES = ["aap.breakdown.", "aap.api.", "aap.view."];

  // ---- Views: main <-> settings ----
  const mainView = document.getElementById("view-main");
  const settingsView = document.getElementById("view-settings");
  document.getElementById("open-settings").addEventListener("click", () => {
    mainView.hidden = true;
    settingsView.hidden = false;
  });
  document.getElementById("back-to-main").addEventListener("click", () => {
    settingsView.hidden = true;
    mainView.hidden = false;
  });

  // ---- Features: one switch per page feature ------------------------------
  const FEATURES = self.AAP_FEATURES;
  const SITES = [
    { key: "console", label: "Apify Console" },
    { key: "store", label: "Apify Store" },
  ];
  const featuresRoot = document.getElementById("features");
  const status = document.getElementById("status");
  const titleOf = (id) => FEATURES.FEATURES.find((feature) => feature.id === id)?.title || id;

  // Stroke icons on a 24px grid (Lucide shapes), the style of the header's gear.
  const ICONS = {
    monetization: ["M3 3v16a2 2 0 0 0 2 2h16", "m19 9-5 5-4-4-3 3"],
    portfolio: ["M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M3 9h18", "M3 15h18", "M9 9v12"],
    acquisition: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
    quality: ["m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"],
    today: ["m3 17 2 2 4-4", "m3 7 2 2 4-4", "M13 6h8", "M13 12h8", "M13 18h8"],
    debugging: ["M22 12h-4l-3 9L9 3l-3 9H2"],
    visibility: ["M9.88 9.88a3 3 0 1 0 4.24 4.24", "M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68", "M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61", "m2 2 20 20"],
    actorActivity: ["M22 7 13.5 15.5l-5-5L2 17", "M16 7h6v6"],
    profileSort: ["m3 16 4 4 4-4", "M7 20V4", "M11 4h10", "M11 8h7", "M11 12h4"],
    benchmark: ["M6 8a6 6 0 1 0 12 0a6 6 0 1 0-12 0", "M15.48 12.89 17 22l-5-3-5 3 1.52-9.11"],
    cache: ["M3 5a9 3 0 1 0 18 0a9 3 0 1 0-18 0", "M3 5v14a9 3 0 0 0 18 0V5", "M3 12a9 3 0 0 0 18 0"],
  };

  function iconTile(name) {
    const tile = createElement("span", "row-icon");
    tile.setAttribute("aria-hidden", "true");
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    for (const d of ICONS[name] || []) {
      const path = document.createElementNS(namespace, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    tile.appendChild(svg);
    return tile;
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function featureRow(feature, off, index) {
    const blocked = feature.requires && feature.requires.every((id) => off.has(id));
    const row = createElement("label", `toggle-row${blocked ? " is-blocked" : ""}`);
    row.style.setProperty("--i", index);
    const input = createElement("input", "switch");
    input.type = "checkbox";
    input.id = `feature-${feature.id}`;
    input.setAttribute("role", "switch");
    input.checked = FEATURES.isOn(feature.id, off);
    input.disabled = !!blocked;
    row.htmlFor = input.id;
    const sub = blocked
      ? `Needs ${feature.requires.map(titleOf).join(" or ")}`
      : feature.description;
    const text = createElement("span", "row-text");
    text.append(createElement("span", "row-title", feature.title), createElement("span", "row-sub", sub));
    input.addEventListener("change", () => {
      status.textContent = `${feature.title} ${input.checked ? "on" : "off"}`;
      row.classList.toggle("is-on", input.checked);
      FEATURES.set(feature.id, input.checked).catch(() => renderFeatures());
    });
    row.classList.toggle("is-on", input.checked);
    row.append(iconTile(feature.id), text, input);
    return row;
  }

  function renderFeatures(saved) {
    const off = FEATURES.switchedOff(saved);
    const focusedId = document.activeElement?.id;
    let index = 0;
    featuresRoot.replaceChildren(...SITES.map((site) => {
      const features = FEATURES.FEATURES.filter((feature) => feature.site === site.key);
      const onCount = features.filter((feature) => FEATURES.isOn(feature.id, off)).length;
      const section = createElement("section", "panel");
      const head = createElement("div", "panel-head");
      const heading = createElement("h2", "panel-heading", site.label);
      heading.id = `features-${site.key}`;
      section.setAttribute("aria-labelledby", heading.id);
      head.append(heading, createElement("span", "chip", `${onCount} of ${features.length} on`));
      section.append(head, ...features.map((feature) => featureRow(feature, off, index++)));
      return section;
    }));
    // A re-render after a change keeps keyboard focus on the same switch.
    if (focusedId) document.getElementById(focusedId)?.focus();
  }

  // Rows fade in once when the popup opens, not on every re-render.
  chrome.storage.local.get(FEATURES.STORAGE_KEY).then((result) => {
    featuresRoot.classList.add("is-entering");
    renderFeatures(result[FEATURES.STORAGE_KEY]);
    setTimeout(() => featuresRoot.classList.remove("is-entering"), 600);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[FEATURES.STORAGE_KEY]) renderFeatures(changes[FEATURES.STORAGE_KEY].newValue);
  });

  // ---- Cached data ----------------------------------------------------------
  async function loadCacheSummary() {
    const keys = Object.keys(await chrome.storage.local.get(null));
    const countOf = (prefix) => keys.filter((key) => key.startsWith(prefix)).length;
    const plural = (count, one, many) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
    const months = countOf("aap.breakdown.");
    const responses = countOf("aap.api.");
    const views = countOf("aap.view.");
    const parts = [
      responses ? plural(responses, "response", "responses") : "",
      views ? plural(views, "view", "views") : "",
      months ? plural(months, "month breakdown", "month breakdowns") : "",
    ].filter(Boolean);
    document.getElementById("cache-body").textContent = parts.length ? parts.join(" · ") : "Nothing cached yet";
    document.getElementById("clear-cache").disabled = !parts.length;
  }

  document.getElementById("clear-cache").addEventListener("click", async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((key) => CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)));
    if (keys.length) await chrome.storage.local.remove(keys);
    await chrome.storage.local.set({ [CACHE_CLEAR_KEY]: Date.now() });
    await loadCacheSummary();
    const button = document.getElementById("clear-cache");
    button.textContent = "Cleared";
    status.textContent = "Cache cleared";
    setTimeout(() => { button.textContent = "Clear"; }, 1600);
  });

  document.getElementById("cache-icon").replaceWith(iconTile("cache"));

  // ---- Settings: monetization tooltip actor limit -----------------------
  const TOOLTIP_ACTOR_COUNT_KEY = "aap.tooltipActorCount";
  const TOOLTIP_ACTOR_COUNT_DEFAULT = 20;
  const TOOLTIP_ACTOR_COUNT_MAX = 100;
  const countInput = document.getElementById("tooltip-actor-count");
  document.getElementById("tooltip-actor-count-default").textContent = TOOLTIP_ACTOR_COUNT_DEFAULT;

  chrome.storage.local.get(TOOLTIP_ACTOR_COUNT_KEY).then((result) => {
    const stored = Math.round(Number(result[TOOLTIP_ACTOR_COUNT_KEY]));
    countInput.value = stored > 0 ? Math.min(TOOLTIP_ACTOR_COUNT_MAX, stored) : TOOLTIP_ACTOR_COUNT_DEFAULT;
  });

  countInput.addEventListener("change", () => {
    const value = Math.round(Number(countInput.value));
    if (!(value > 0)) {
      countInput.value = TOOLTIP_ACTOR_COUNT_DEFAULT;
      chrome.storage.local.remove(TOOLTIP_ACTOR_COUNT_KEY);
      return;
    }
    const next = Math.min(TOOLTIP_ACTOR_COUNT_MAX, value);
    countInput.value = next;
    chrome.storage.local.set({ [TOOLTIP_ACTOR_COUNT_KEY]: next });
  });

  document.getElementById("tooltip-actor-count-reset").addEventListener("click", () => {
    countInput.value = TOOLTIP_ACTOR_COUNT_DEFAULT;
    chrome.storage.local.remove(TOOLTIP_ACTOR_COUNT_KEY);
  });

  // ---- Performance panel (debug) ------------------------------------------
  // Each Apify tab writes a throttled snapshot of its data-layer counters to
  // "aap.perf" (lib/perf.js); show the latest one.
  const PERF_KEY = "aap.perf";
  const perfBody = document.getElementById("perf-body");

  function perfRow(label, value, title = "") {
    const row = document.createElement("div");
    row.className = "perf-row";
    if (title) row.title = title;
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    row.append(term, detail);
    return row;
  }

  function renderPerf(snapshot) {
    if (!snapshot?.counters) return;
    const counters = snapshot.counters;
    const timings = snapshot.timings || {};
    const hits = (counters["cache.hit"] || 0) + (counters["cache.staleHit"] || 0);
    const reads = hits + (counters["cache.miss"] || 0);
    const firstPaint = snapshot.marks?.["range.firstPaint"];
    const probe = snapshot.headerProbe || {};
    const etag = probe.checked ? (probe.etag ? "yes" : "no") : "unknown";
    const avg = (name) => (timings[name] ? `${timings[name].avg} ms` : "–");
    perfBody.replaceChildren(
      perfRow("Page", snapshot.page || "–"),
      perfRow("Network requests", String(counters["request.network"] || 0)),
      perfRow("Cache hit rate", reads ? `${Math.round((hits / reads) * 100)}% of ${reads}` : "–", "Hits include stale entries shown while refreshing."),
      perfRow("Shown stale, refreshed", String(counters["request.revalidated"] || 0)),
      perfRow("Reused Apify responses", String(counters["tee.cached"] || 0)),
      perfRow("Shared across tabs", String(counters["request.sharedAcrossTabs"] || 0)),
      perfRow("Cancelled on range switch", String(counters["request.cancelled"] || 0)),
      perfRow("Avg queue wait", avg("request.queueWaitMs")),
      perfRow("Avg cache write", avg("cache.writeMs")),
      perfRow("Evicted before expiry", `${counters["cache.evictedBeforeExpiry"] || 0} of ${counters["cache.evicted"] || 0}`, "Entries removed for space while still valid. Rising numbers mean the cache budget is too small."),
      perfRow("Monetization first chart", firstPaint != null ? `${firstPaint} ms after load` : "–"),
      perfRow("Apify sends ETag", etag, probe.cacheControl ? `Cache-Control: ${probe.cacheControl}` : ""),
    );
  }

  chrome.storage.local.get(PERF_KEY).then((result) => renderPerf(result[PERF_KEY]));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[PERF_KEY]) renderPerf(changes[PERF_KEY].newValue);
  });

  loadCacheSummary();
})();
