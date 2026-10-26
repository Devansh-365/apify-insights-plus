/* Which of the account's own Actors are not public, for the My Actors page.
   The Console's own list filters on the server and ignores visibility, so the
   answer comes from the Store (public Actors) plus basic info for the rest. */
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
      }))
      .filter((actor) => actor.id && !seen.has(actor.id) && seen.add(actor.id));
  }

  // Actors missing from the Store; each one needs its basic info to tell
  // private from public-but-unlisted (a Store index lag, say).
  function candidates(owned, publicIds) {
    return owned.filter((actor) => !publicIds.has(actor.id));
  }

  function publishedAt(basicInfo) {
    const time = Date.parse(basicInfo?.firstPublishedAt || "");
    return Number.isFinite(time) ? time : null;
  }

  // Owned Actors confirmed private, with whether they were ever published.
  // `infos` maps an Actor id to its basic info, or null when it failed.
  function classify(owned, publicIds, infos) {
    const hidden = [];
    let unknown = 0;
    for (const actor of candidates(owned, publicIds)) {
      const info = infos.get(actor.id);
      if (!info) {
        unknown++;
        continue;
      }
      if (info.isPublic === true) continue;
      // A response without a visibility flag cannot say either way.
      if (info.isPublic !== false) {
        unknown++;
        continue;
      }
      hidden.push({
        ...actor,
        username: actor.username || String(info.username || "").trim(),
        title: actor.title || String(info.title || "").trim() || actor.name,
        pictureUrl: actor.pictureUrl || info.pictureUrl || "",
        firstPublishedAt: publishedAt(info),
      });
    }
    hidden.sort((left, right) => left.title.localeCompare(right.title));
    return { hidden, unknown };
  }

  // Same matching as the Console search box: title or name, any case.
  function matchesQuery(actor, query) {
    const text = String(query || "").trim().toLowerCase();
    return !text || `${actor.title} ${actor.name} ${actor.username}/${actor.name}`.toLowerCase().includes(text);
  }

  self.AAP_VISIBILITY = { developmentRoute, routePrefix, ownedActors, candidates, classify, matchesQuery };
})();
