(function () {
  const CACHE_CLEAR_KEY = "aap.cacheClearedAt";

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

  async function loadCacheSummary() {
    const all = await chrome.storage.local.get(null);
    const entries = Object.entries(all)
      .filter(([k]) => k.startsWith("aap.breakdown."))
      .map(([k, v]) => {
        // key is "aap.breakdown.<month>" or "aap.breakdown.<month>:<actorIds>"
        // when the view was scoped to the native Actor filter
        const [month, scope] = k.replace("aap.breakdown.", "").split(":");
        const scopeParts = (scope || "").split("|");
        const fallbackFiltered = scopeParts.length >= 3
          ? !!scopeParts.slice(2).join("|")
          : scopeParts.length === 2
            ? !!scopeParts[1]
            : !!scope;
        return {
          month,
          ...v,
          filtered: typeof v?.filtered === "boolean" ? v.filtered : fallbackFiltered,
        };
      })
      .sort((a, b) => b.month.localeCompare(a.month));

    const body = document.getElementById("cache-body");
    body.replaceChildren();
    if (!entries.length) {
      body.className = "muted";
      const apiCount = Object.keys(all).filter((key) => key.startsWith("aap.api.")).length;
      body.textContent = apiCount ? `${apiCount} cached API responses.` : "No cached analytics data yet.";
      return;
    }
    body.className = "";
    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "cache-row";
      const label = document.createElement("span");
      label.textContent = e.filtered ? `${e.month} (filtered)` : e.month;
      const meta = document.createElement("span");
      const actors = e.actorCount != null ? `${e.actorCount} actors` : "–";
      const when = e.updatedAt ? new Date(e.updatedAt).toLocaleTimeString() : "";
      meta.textContent = `${actors} · ${when}`;
      row.append(label, meta);
      body.appendChild(row);
    }
    const apiCount = Object.keys(all).filter((key) => key.startsWith("aap.api.")).length;
    if (apiCount) {
      const note = document.createElement("div");
      note.className = "muted";
      note.style.marginTop = "6px";
      note.textContent = `${apiCount} cached API responses`;
      body.appendChild(note);
    }
  }

  document.getElementById("clear-cache").addEventListener("click", async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("aap.breakdown.") || k.startsWith("aap.api."));
    if (keys.length) await chrome.storage.local.remove(keys);
    await chrome.storage.local.set({ [CACHE_CLEAR_KEY]: Date.now() });
    loadCacheSummary();
  });

  // ---- Settings: breakdown tooltip actor count ----
  // Kept opt-in — the content script falls back to this same default when
  // nothing is stored, so a user who never opens this panel sees no change.
  const TOOLTIP_ACTOR_COUNT_KEY = "aap.tooltipActorCount";
  const TOOLTIP_ACTOR_COUNT_DEFAULT = 10;
  const TOOLTIP_ACTOR_COUNT_MAX = 50;

  const countInput = document.getElementById("tooltip-actor-count");
  document.getElementById("tooltip-actor-count-default").textContent = TOOLTIP_ACTOR_COUNT_DEFAULT;

  chrome.storage.local.get(TOOLTIP_ACTOR_COUNT_KEY).then((r) => {
    countInput.value = r[TOOLTIP_ACTOR_COUNT_KEY] > 0 ? r[TOOLTIP_ACTOR_COUNT_KEY] : TOOLTIP_ACTOR_COUNT_DEFAULT;
  });

  countInput.addEventListener("change", () => {
    const raw = Math.round(Number(countInput.value));
    if (!(raw > 0)) {
      countInput.value = TOOLTIP_ACTOR_COUNT_DEFAULT;
      chrome.storage.local.remove(TOOLTIP_ACTOR_COUNT_KEY);
      return;
    }
    const n = Math.min(TOOLTIP_ACTOR_COUNT_MAX, raw);
    countInput.value = n;
    chrome.storage.local.set({ [TOOLTIP_ACTOR_COUNT_KEY]: n });
  });

  document.getElementById("tooltip-actor-count-reset").addEventListener("click", () => {
    countInput.value = TOOLTIP_ACTOR_COUNT_DEFAULT;
    chrome.storage.local.remove(TOOLTIP_ACTOR_COUNT_KEY);
  });

  loadCacheSummary();
})();
