/* Shared page-context helpers for cache and request scoping. */
(function () {
  function organizationKey(pathname) {
    const currentPath = pathname ?? (typeof location === "undefined" ? "" : location.pathname);
    const match = String(currentPath || "").match(/^\/organization\/([^/]+)/);
    return match ? `org-${encodeURIComponent(match[1])}` : "personal";
  }

  // The organization and signed-in account, the scope most saved state is
  // kept under.
  function accountScope() {
    return `${organizationKey()}:${self.AAP_API?.authScope?.() || ""}`;
  }

  // The scope decisions the user makes (Today, the quality inbox) are kept
  // under. They name Actors by ID, which is unique across accounts, so unlike
  // cached data they leave out the account: its key is a hash of the login
  // token, which changes between sessions, and decisions must survive that.
  function decisionScope() {
    return organizationKey();
  }

  self.AAP_CONTEXT = { organizationKey, accountScope, decisionScope };
})();
