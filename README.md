# Insights Plus for Apify

A Chrome extension for Apify Actor developers. It adds date ranges, per-Actor breakdowns and account-wide tables to the Apify Console Insights pages, and public run and user stats to Apify Store pages. Apify's own views stay one click away.

Not affiliated with or endorsed by Apify.

[Install from the Chrome Web Store](#install) · [Privacy](PRIVACY.md) · [Report a bug](https://github.com/Devansh-365/apify-insights-plus/issues/new/choose) · [Changelog](CHANGELOG.md)

## What it adds

### In the Apify Console

- **Monetization charts.** Pick any range of months, or use the 1m, 3m, 6m and 1y shortcuts, and group by day, week or month. Click a day to see which Actors earned or ran that day. Sort by revenue, cost, profit, runs or results.
- **Range export.** Download one JSON file for the selected range, in the same shape as the Console's monthly export, with totals recomputed across months.
- **Actor portfolio.** Every Actor ranked by revenue, with month-over-month change.
- **Acquisition triage.** Totals for all Actors in one searchable table, including referrers and countries, with the Actors losing or gaining users called out.
- **Actor quality inbox.** Every Actor's quality score, setup checks and suggested fixes in one list.
- **Today list.** The to-dos from Acquisition and Quality, in one place.
- **Run success overview.** Success rate for every Actor. Select one to see its user runs.
- **Not public filter.** Show only your private Actors on My Actors.

On each Insights page, the **Original / Plus** switch in the tab row brings back Apify's own view.

### On apify.com

- **Actor insights.** Active users and runs for the last 30 days, total runs, created date, last pricing update and last run on each public Actor page.
- **Profile stats and sorting.** Sort a builder's Actors by runs, monthly runs, monthly active users, users, bookmarks or newest, and filter them with thresholds such as "MAUs at least 10".
- **Builder benchmark.** See where a builder ranks on those numbers among public builders. The ranking comes from a daily snapshot built by this project from public profile data (see [How the benchmark is built](#how-the-benchmark-is-built)).

Every feature can be switched off in the extension popup. A switch applies to open tabs right away.

## Install

**Chrome Web Store:** [NEED: listing URL once published]

**From source**, for development or to try an unreleased change:

1. `git clone https://github.com/Devansh-365/apify-insights-plus.git`
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the cloned folder (the one with `manifest.json`).
4. Open [Apify Console Insights](https://console.apify.com/actors/insights/monetization) and pick **Plus**.

After pulling a new version, click **Reload** on the extension card in `chrome://extensions`, then reload your Apify tabs.

Requires Chrome 111 or newer.

## How it works, and what it can see

The extension has one permission, `storage`, and no host permissions.

- **On console.apify.com**, a small script runs in the page and reads the analytics responses the Console already loads. It also makes a fixed list of read-only analytics requests (monetization, runs, users, quality scores, exports) using the session the Console page already has. Your Apify token stays inside that page script. The rest of the extension receives only the response data and a short hash used to keep each account's cache separate. Requests to any other Apify endpoint are refused.
- **On apify.com**, it reads public Actor and Store data from `api.apify.com`, the same data anyone can see without logging in.
- **The benchmark snapshot** is a public JSON file downloaded from `gist.githubusercontent.com`. No account data goes with that request.

Responses are cached in `chrome.storage.local` on your computer so tabs open quickly: 5 minutes for the current month and 15 minutes for earlier months. The cache is capped at 5 MB. **Clear** in the popup empties it.

There are no analytics, no tracking and no servers of our own. The full list is in [PRIVACY.md](PRIVACY.md).

## When something breaks

Apify can change its Console at any time. If a Plus view fails, a notice appears in the bottom corner with a button back to Apify's original view. Apify's page keeps working either way.

To report it, open the popup, go to **Settings → Diagnostics → Save report**, and attach the file to a [bug report](https://github.com/Devansh-365/apify-insights-plus/issues/new/choose). The report holds the extension version, browser version, recent extension errors (with query strings removed) and load timings. It holds no Apify data or token.

## How the benchmark is built

`.github/workflows/refresh-builder-benchmark.yml` runs once a day. It reads Apify's public user sitemap and each builder's public Store catalog, adds up runs, monthly runs, monthly active users and users per builder, and publishes the result to a public Gist. The extension downloads that one file instead of scanning every builder itself. If the snapshot can't be loaded, the extension falls back to a slower local scan.

The ranks are computed by this project. They can differ from other leaderboards that count builders or metrics differently.

To run it on your own fork, add two repository secrets: `BUILDER_BENCHMARK_GIST_ID` (the Gist that receives `builder-rankings.json`) and `BUILDER_BENCHMARK_GIST_TOKEN` (a fine-grained token with Gist write access only).

## Development

No build step and no dependencies: the extension is plain JavaScript loaded straight from `content/` and `lib/`.

```sh
npm test               # unit tests (Node 20+)
npm run check          # syntax check of every script, manifest parse
npm run build          # dist/Insights-Plus-for-Apify-<version>.zip
npm run release:check  # all of the above, then checks the zip's contents
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the code layout, the release steps and the checklist to run when Apify changes the Console.

## Security

Found a way to make the extension leak a token or data? Please report it privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Credits

Built and maintained by **Devansh Tiwari** ([GitHub](https://github.com/Devansh-365)).

Started as a fork of [apify-insights-plus](https://github.com/igolaizola/apify-insights-plus) by Iñigo Garcia Olaizola, used under the MIT license. Inspired by [Apify Analytics Plus](https://addons.mozilla.org/en-US/firefox/addon/apify-analytics-plus/).

"Apify" is a trademark of Apify Technologies s.r.o. This project is independent and is not affiliated with, sponsored by or endorsed by Apify.

## License

[MIT](LICENSE)
