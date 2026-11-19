/* Which Insights Plus features are switched on. The popup saves the features
   switched off under "aap.features" ({ id: false }); every page reads them
   here and re-checks on change, so a switch applies to open tabs right away.
   Until the saved switches are read, every feature counts as off, so one
   switched off never flashes or starts loading. */
(function () {
  const STORAGE_KEY = "aap.features";
  const FEATURES = [
    {
      id: "monetization",
      site: "console",
      title: "Monetization charts",
      description: "Ranges and per-Actor details",
    },
    {
      id: "portfolio",
      site: "console",
      title: "Actor portfolio",
      description: "Revenue-ranked Actor table",
      requires: ["monetization"],
    },
    {
      id: "acquisition",
      site: "console",
      title: "Acquisition triage",
      description: "Leaking and rising Actors",
    },
    {
      id: "quality",
      site: "console",
      title: "Actor quality inbox",
      description: "Scores and fixes per Actor",
    },
    {
      id: "today",
      site: "console",
      title: "Today list",
      description: "To-dos on Acquisition, Quality",
      requires: ["acquisition", "quality"],
    },
    {
      id: "debugging",
      site: "console",
      title: "Run success overview",
      description: "Failed runs for every Actor",
    },
    {
      id: "visibility",
      site: "console",
      title: "Store status filter",
      description: "Under maintenance and deprecated Actors on My Actors",
    },
    {
      id: "actorActivity",
      site: "store",
      title: "Actor insights",
      description: "Activity stats on Actor pages",
    },
    {
      id: "profileSort",
      site: "store",
      title: "Profile stats and sorting",
      description: "Sort and filter profile Actors",
    },
    {
      id: "benchmark",
      site: "store",
      title: "Builder benchmark",
      description: "Rank against other builders",
      requires: ["profileSort"],
    },
  ];
  const KNOWN = new Set(FEATURES.map((feature) => feature.id));

  let off = new Set();
  let loaded = false;
  const listeners = new Set();

  // Only ids this version knows, and only an explicit false turns one off.
  function switchedOff(saved) {
    if (!saved || typeof saved !== "object") return new Set();
    return new Set(Object.keys(saved).filter((id) => KNOWN.has(id) && saved[id] === false));
  }

  // A feature that needs another (`requires`) is off when none of those are on.
  function isOn(id, offSet) {
    if (offSet.has(id)) return false;
    const requires = FEATURES.find((feature) => feature.id === id)?.requires;
    return !requires || requires.some((other) => !offSet.has(other));
  }

  function enabled(id) {
    return loaded && isOn(id, off);
  }

  function apply(saved) {
    off = switchedOff(saved);
    loaded = true;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // One feature's failure must not stop the others from updating.
      }
    }
  }

  // Runs once the saved switches are read, and on every change after.
  function onChange(listener) {
    listeners.add(listener);
    if (loaded) listener();
  }

  // The popup's write: only switched-off features are saved.
  async function set(id, on) {
    const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    const next = { ...(saved && typeof saved === "object" ? saved : {}) };
    if (on) delete next[id];
    else next[id] = false;
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  }

  const storage = typeof chrome !== "undefined" ? chrome.storage : null;
  if (storage?.local) {
    Promise.resolve(storage.local.get(STORAGE_KEY))
      .then((result) => apply(result?.[STORAGE_KEY]))
      .catch(() => apply(null));
    storage.onChanged?.addListener((changes, area) => {
      if (area === "local" && changes[STORAGE_KEY]) apply(changes[STORAGE_KEY].newValue);
    });
  } else {
    apply(null);
  }

  self.AAP_FEATURES = { STORAGE_KEY, FEATURES, enabled, isOn, switchedOff, onChange, set };
})();
