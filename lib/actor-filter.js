/* The Actor filter behind the Plus views' "All Actors" picker: which Actors
   can be chosen, which match a search, and how a selection is labelled. Pure,
   so the picker UI and the tests share one definition. */
(function () {
  // Apify's owned-Actor list, or the range data's Actor catalog, into one
  // shape: { id, title, name, username }. Deduplicated; entries without an id
  // are dropped.
  function normalize(raw) {
    const list = Array.isArray(raw) ? raw : raw?.actors || raw?.items || raw?.data || [];
    const seen = new Set();
    const actors = [];
    for (const actor of list) {
      const id = actor?._id || actor?.id || actor?.actorId || null;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = String(actor?.name || "").trim();
      actors.push({
        id,
        name,
        title: String(actor?.title || actor?.name || id).trim(),
        username: String(actor?.username || "").trim(),
      });
    }
    return actors;
  }

  // The owned list is the source of truth; the catalog only fills in Actors
  // the owned list lacks (one deleted since it earned, say) and missing names.
  function merge(primary, secondary) {
    const byId = new Map(primary.map((actor) => [actor.id, { ...actor }]));
    for (const actor of secondary) {
      const current = byId.get(actor.id);
      if (!current) byId.set(actor.id, { ...actor });
      else {
        if (!current.name && actor.name) current.name = actor.name;
        if ((!current.title || current.title === current.id) && actor.title) current.title = actor.title;
        if (!current.username && actor.username) current.username = actor.username;
      }
    }
    return [...byId.values()];
  }

  // "username/name", the second line of Apify's own picker.
  function slug(actor) {
    if (!actor?.name) return "";
    return actor.username ? `${actor.username}/${actor.name}` : actor.name;
  }

  // Title, name or username/name, any case, every word.
  function matches(actor, query) {
    const words = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const text = `${actor.title} ${slug(actor)} ${actor.id}`.toLowerCase();
    return words.every((word) => text.includes(word));
  }

  // Alphabetical by title, like Apify's picker. Selected Actors move to the
  // top when the list opens, so a long list never hides what is chosen.
  function order(actors, selectedIds = []) {
    const selected = new Set(selectedIds);
    const byTitle = (left, right) => left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
    return [...actors].sort((left, right) => {
      const rank = Number(selected.has(right.id)) - Number(selected.has(left.id));
      return rank || byTitle(left, right);
    });
  }

  function normalizeIds(ids) {
    return [...new Set((ids || []).filter((id) => typeof id === "string" && id))].sort();
  }

  function sameIds(left, right) {
    return normalizeIds(left).join(",") === normalizeIds(right).join(",");
  }

  // The button text: nothing chosen means every Actor.
  function summary(selectedIds, actors = []) {
    const ids = normalizeIds(selectedIds);
    if (!ids.length) return "All Actors";
    if (ids.length === 1) {
      const actor = actors.find((item) => item.id === ids[0]);
      return actor?.title || "1 Actor";
    }
    return `${ids.length} Actors`;
  }

  self.AAP_ACTOR_FILTER = { normalize, merge, slug, matches, order, normalizeIds, sameIds, summary };
})();
