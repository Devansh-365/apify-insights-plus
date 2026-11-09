# Chrome Web Store: Privacy practices answers

Paste these into the Developer Dashboard **Privacy practices** tab. Keep them in step with [PRIVACY.md](../PRIVACY.md) and `manifest.json`. Reviewers compare all three.

## Single purpose

> Adds analytics views to the Apify Console and to public Apify Store pages, so Actor developers can see their Actors' revenue, runs, users and quality across any date range and across all their Actors at once.

## Permission justification

**storage**

> Caches the Apify analytics responses the user opens, for 5 to 15 minutes, so revisiting a page or switching date ranges does not refetch the same data. Also stores the user's feature switches, view settings, and an optional local error log. Everything is kept in chrome.storage.local on the user's computer and removed on uninstall.

The extension requests no host permissions. Its content scripts run only on `https://console.apify.com/*`, `https://apify.com/*` and `https://www.apify.com/*`, the pages it adds views to.

## Why a script runs in the page (world: MAIN) on console.apify.com

The dashboard has no field for this, but reviewers ask about it. Put it at the end of the single-purpose answer or in the reviewer notes if asked:

> The Apify Console authenticates its own API requests with a token that only the page's JavaScript holds. There is no cookie the extension could use instead. A small script (content/token-sniffer.js) runs in the page to do two things: read the analytics responses the Console has already loaded, so the extension does not request them twice, and make a fixed list of read-only GET requests to Apify's analytics endpoints with the page's existing authorization. The token never leaves that script: it is not stored, not passed to the extension's other scripts, and not sent anywhere except Apify's own API, where the Console already sends it. Requests to any endpoint outside the allowlist are refused. The source code is public at https://github.com/Devansh-365/apify-insights-plus.

## Remote code

**No, I am not using remote code.**

> All JavaScript ships in the package. The only data downloaded at run time is JSON: Apify API responses and a public benchmark snapshot (gist.githubusercontent.com). Neither is executed.

## Data usage

What the extension collects, as the dashboard defines it. "Collect" means the extension reads or handles the data, even though none of it leaves the user's browser except to Apify.

| Category | Tick? | Why |
|---|---|---|
| Personally identifiable information | No | |
| Health information | No | |
| Financial and payment information | **Yes** | The user's own Actor revenue, costs and profit from Apify analytics, shown in charts and cached locally. Not payment card or bank details. |
| Authentication information | **Yes** | The Apify Console's sign-in token is read inside the page to make the Console's own read-only analytics requests. It is never stored or sent anywhere except Apify. |
| Personal communications | No | |
| Location | No | |
| Web history | No | |
| User activity | No | |
| Website content | **Yes** | Apify Console analytics and public Apify Store data, displayed in the extension's views. |

Certifications (tick all three):

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

## Privacy policy URL

https://github.com/Devansh-365/apify-insights-plus/blob/main/PRIVACY.md

If GitHub Pages is turned on for the repository (Settings → Pages → Deploy from branch `main`, folder `/`), the policy is also served at https://devansh-365.github.io/apify-insights-plus/PRIVACY.html. Either URL works. Pages is the cleaner one for reviewers.
