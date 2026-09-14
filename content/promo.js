/* Adds a small X follow link to Apify pages. */
(function () {
  const PROMO_ID = "aap-profile-promo";
  const SOCIAL_URL = "https://x.com/igolaizola";

  function ensurePromo() {
    if (!document.body || document.getElementById(PROMO_ID)) return;

    const link = document.createElement("a");
    link.id = PROMO_ID;
    link.className = "aap-profile-promo";
    link.href = SOCIAL_URL;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = "Follow @igolaizola on X";
    link.setAttribute("aria-label", "Follow @igolaizola on X");

    const author = document.createElement("span");
    author.className = "aap-profile-promo-author";
    author.textContent = "Follow";
    const action = document.createElement("span");
    action.className = "aap-profile-promo-action";
    action.textContent = "@igolaizola ↗";
    link.append(author, action);
    document.body.appendChild(link);
  }

  ensurePromo();
  if (!document.body) {
    new MutationObserver(ensurePromo).observe(document.documentElement, { childList: true });
  }
})();
