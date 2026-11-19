/* Which of the account's own Actors are under maintenance or deprecated, for
   the My Actors page's "Store status" filter. The Console's own list cannot
   filter by these, so the answer comes from the account's Store listing plus
   per-Actor info for the Actors the Store leaves out. */
(function () {
  const ROUTE = /^\/(?:organization\/[^/]+\/)?actors\/development\/?$/;

  function developmentRoute(pathname) {
    return ROUTE.test(String(pathname || ""));
  }

  // "/" or "/organization/<id>/", so Actor links stay in the same account.
  function routePrefix(pathname) {
    return String(pathname || "").replace(/actors\/development\/?$/, "") || "/";
  }

  function ownedActors(raw) {
    const list = Array.isArray(raw) ? raw : raw?.actors || raw?.items || raw?.data || [];
    const seen = new Set();
    return list
      .map((actor) => ({
        id: actor?._id || actor?.id || null,
        name: String(actor?.name || "").trim(),
        title: String(actor?.title || actor?.name || "").trim(),
        username: String(actor?.username || "").trim(),
        pictureUrl: actor?.pictureUrl || "",
        // Kept when the Console's list carries them; basic info fills gaps.
        notice: actor?.notice || null,
        isDeprecated: actor?.isDeprecated === true,
      }))
      .filter((actor) => actor.id && !seen.has(actor.id) && seen.add(actor.id));
  }

  // Actors missing from the Store (deprecated or private ones, or a Store
  // index lag); each needs its own info to tell whether it is deprecated.
  function candidates(owned, publicIds) {
    return owned.filter((actor) => !publicIds.has(actor.id));
  }

  // Same matching as the Console search box: title or name, any case.
  function matchesQuery(actor, query) {
    const text = String(query || "").trim().toLowerCase();
    return !text || `${actor.title} ${actor.name} ${actor.username}/${actor.name}`.toLowerCase().includes(text);
  }

  // ---- Store status filter ---------------------------------------------------
  // The statuses the My Actors "Store status" filter offers, in menu order.
  const STATUSES = [
    { key: "maintenance", label: "Under maintenance", hint: "Flagged under maintenance in Apify Store" },
    { key: "deprecated", label: "Deprecated", hint: "Deprecated, so new users can't find it" },
  ];
  const STATUS_KEYS = STATUSES.map((status) => status.key);

  // The account's Store listing, by Actor id: its maintenance notice.
  function storeEntries(items) {
    const entries = new Map();
    for (const item of items || []) {
      if (!item?.id) continue;
      entries.set(item.id, { notice: item.notice || null });
    }
    return entries;
  }

  // Deprecated Actor ids from an actor-breakdown response.
  function deprecatedIds(breakdown) {
    const rows = Array.isArray(breakdown) ? breakdown : breakdown?.monetizationPerActor || [];
    const ids = new Set();
    for (const row of rows) if (row?.actor?._id && row.actor.isDeprecated === true) ids.add(row.actor._id);
    return ids;
  }

  // Every owned Actor with at least one status, with the statuses it has.
  // `store` comes from storeEntries(); `infos` maps an Actor missing from
  // the Store to its basic info (null when the check failed); `deprecated`
  // is a Set of ids known to be deprecated.
  function statusRows(owned, store, infos, deprecated = new Set()) {
    const rows = [];
    const counts = Object.fromEntries(STATUS_KEYS.map((key) => [key, 0]));
    let unknown = 0;
    for (const actor of owned) {
      const entry = store.get(actor.id) || null;
      const info = entry ? null : infos.get(actor.id);
      const statuses = [];
      // Not in the Store and its check failed: counted, never guessed.
      if (!entry && !info) unknown++;
      const notice = entry?.notice || info?.notice || actor.notice;
      if (notice === "UNDER_MAINTENANCE") statuses.push("maintenance");
      if (actor.isDeprecated || info?.isDeprecated === true || deprecated.has(actor.id)) statuses.push("deprecated");
      if (!statuses.length) continue;
      for (const key of statuses) counts[key]++;
      rows.push({
        ...actor,
        username: actor.username || String(info?.username || "").trim(),
        title: actor.title || String(info?.title || "").trim() || actor.name,
        pictureUrl: actor.pictureUrl || info?.pictureUrl || "",
        statuses,
      });
    }
    rows.sort((left, right) => left.title.localeCompare(right.title));
    return { rows, counts, unknown };
  }

  // Rows with any of the selected statuses.
  function filterRows(rows, selected, query = "") {
    const wanted = new Set(selected);
    return rows.filter((row) => row.statuses.some((key) => wanted.has(key)) && matchesQuery(row, query));
  }

  function normalizeSelection(selected) {
    const keys = new Set(Array.isArray(selected) ? selected : []);
    return STATUS_KEYS.filter((key) => keys.has(key));
  }

  self.AAP_VISIBILITY = {
    developmentRoute, routePrefix, ownedActors, candidates, matchesQuery,
    STATUSES, storeEntries, deprecatedIds, statusRows, filterRows, normalizeSelection,
  };
})();
