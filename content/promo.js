/* Adds a small profile link to Apify pages. */
(function () {
  const PROMO_ID = "aap-profile-promo";
  const PROFILE_URL = "https://apify.com/igolaizola?fpr=ig";

  function ensurePromo() {
    if (!document.body || document.getElementById(PROMO_ID)) return;

    const link = document.createElement("a");
    link.id = PROMO_ID;
    link.className = "aap-profile-promo";
    link.href = PROFILE_URL;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = "Visit @igolaizola's Apify profile";
    link.setAttribute("aria-label", "Visit @igolaizola's Apify profile");

    const author = document.createElement("span");
    author.className = "aap-profile-promo-author";
    author.textContent = "Top Actors by";
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
