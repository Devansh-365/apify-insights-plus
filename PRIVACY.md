# Privacy Policy: Insights Plus for Apify

**Version 1.0 · Last updated: 9 November 2026**

Insights Plus for Apify ("the extension") is a Chrome extension built and maintained by Devansh Tiwari. It is not affiliated with Apify. This policy describes everything the extension reads, stores and sends.

## The short version

The extension shows your own Apify analytics in more useful ways. It works entirely in your browser. It does not send your data to the developer or to anyone else, does not use analytics or tracking, and does not sell or share data.

## What the extension reads

| Where | What it reads | Why |
|---|---|---|
| console.apify.com | Your Actors' analytics: revenue, costs, runs, users, acquisition, quality scores and monthly exports, read from Apify's own Console API. | To draw the charts and tables you open. |
| console.apify.com | The Console's sign-in token, which the Console attaches to its own API requests. | To make the same read-only analytics requests the Console makes. |
| apify.com | Public Actor and builder data from `api.apify.com` (runs, users, bookmarks, pricing). Anyone can see this without logging in. | For the stats, sorting and benchmark on public pages. |

How the sign-in token is handled:

- It stays inside a script that runs in the Console page. It is never written to storage, never passed to the rest of the extension, and never sent anywhere except `console-backend.apify.com`, where the Console already sends it.
- The extension keeps only a short one-way hash of it, so each account's cached data stays separate.
- The page script makes requests only to a fixed list of read-only analytics endpoints. It refuses every other request.

The extension does not read your browsing history, pages outside apify.com and console.apify.com, form inputs, passwords, payment details or Apify account settings.

## What it stores, and where

Everything is stored in Chrome's local extension storage (`chrome.storage.local`) on your computer. Nothing is synced to your Google account.

- **Cached API responses.** Kept so pages open quickly. The cache is treated as fresh for 5 minutes (current month) or 15 minutes (earlier months), capped at 5 MB, and removed when space is needed or when you click **Clear** in the popup.
- **Your settings.** Which features are on, chosen date ranges, views and sort order.
- **Your decisions.** Items you mark done or snooze in the Today list and Actor quality inbox.
- **A local error log.** The last 20 errors from the extension's own code: message (with URL query strings removed), file and line, page path, extension version and time. It is used for the optional diagnostics report described below.
- **Load timings.** Counters such as cache hit rate and request times, shown in the popup's Performance panel.

Uninstalling the extension deletes all of it.

## What it sends, and to whom

The extension makes network requests only to these hosts:

| Host | What is sent | Purpose |
|---|---|---|
| `console-backend.apify.com` (Apify) | Read-only analytics requests, with your Console session, exactly as the Console sends them. | Your analytics. |
| `api.apify.com` (Apify) | Requests for public Store and Actor data. No account data. | Public page stats. |
| `gist.githubusercontent.com` (GitHub) | A request for one public JSON file, the daily builder benchmark snapshot. No account data. GitHub, like any web server, sees the request's IP address. | Builder rankings. |

Apify's handling of requests to its own services is covered by [Apify's privacy policy](https://apify.com/privacy-policy). GitHub's is covered by the [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

The developer runs no servers that receive data from the extension.

## Diagnostics reports

The popup can save a diagnostics report (**Settings → Diagnostics → Save report**). The report is a file saved on your computer. It contains the extension and browser versions, the local error log, load timings, which features are off, and how many entries are cached. It contains no Apify analytics data and no token. It is shared only if you choose to attach it to a bug report.

## Limited Use

The use of information received from Apify's and Google's services by this extension complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements. Specifically, the extension:

- uses data only to provide the features described in its Chrome Web Store listing and user interface;
- does not transfer data to third parties, except to the hosts listed above as needed for those features;
- does not use or transfer data for advertising, credit-worthiness or lending;
- does not sell data;
- does not allow humans to read user data. The developer never receives it.

## Children

The extension is a tool for Apify developers and is not directed at children.

## Changes to this policy

If the extension's data practices change, this policy will be updated before the new version is published. The version number and date at the top will change, and the change will be listed in the [changelog](CHANGELOG.md) and announced in the extension's popup. Practices that need your permission will not change without asking for it.

## Contact

Questions about this policy: open an issue at [github.com/Devansh-365/apify-insights-plus/issues](https://github.com/Devansh-365/apify-insights-plus/issues), or email [NEED: contact email for privacy questions].
