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

  self.AAP_CONTEXT = { organizationKey, accountScope };
})();
