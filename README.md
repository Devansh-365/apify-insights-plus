<p align="center">
  <img src="docs/assets/cover.png" alt="Insights Plus: every Actor's revenue, users and runs on one screen, across any date range, plus builder rankings and competitor stats. Shows six months of weekly revenue across all Actors with one week highlighted, and a builder ranking with your account at number 38." width="100%">
</p>

<h3 align="center">See which of your Apify Actors earn, lose users or fail, without opening them one by one.</h3>

<p align="center">
  A Chrome extension that adds the missing views to Apify Console Insights:<br>
  any date range, every Actor in one table, and how you rank against other builders.<br>
  <sub>Apify's own views stay one click away.</sub>
</p>

<p align="center">
  <img alt="Chrome extension, Manifest V3" src="https://img.shields.io/badge/Chrome-MV3-246dff?style=flat-square">
  <img alt="One permission: storage" src="https://img.shields.io/badge/permissions-storage%20only-1f9a4b?style=flat-square">
  <img alt="No tracking" src="https://img.shields.io/badge/tracking-none-e85d04?style=flat-square">
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-1a1714?style=flat-square">
</p>

<p align="center">
  <a href="#install"><strong>Install</strong></a> ·
  <a href="PRIVACY.md"><strong>Privacy</strong></a> ·
  <a href="CHANGELOG.md"><strong>Changelog</strong></a> ·
  <a href="https://github.com/Devansh-365/apify-insights-plus/issues/new/choose"><strong>Report a bug</strong></a>
</p>

## What you get

| Where | You get |
|---|---|
| **Monetization** | Any range of months (or 1m, 3m, 6m, 1y), grouped by day, week or month. Click a day to see which Actors earned it. Export the range as one JSON file. |
| **Actor portfolio** | Every Actor ranked by revenue, with month-over-month change. |
| **Acquisition** | Users, referrers and countries for all Actors in one table, with the ones losing or gaining users called out. |
| **Quality and runs** | Every Actor's quality score and suggested fixes, and the success rate of every Actor's runs. |
| **Today** | The to-dos from Acquisition and Quality in one list. |
| **Public Actor pages** | Active users and runs for the last 30 days, total runs and last run, on any Actor, yours or a competitor's. |
| **Builder profiles** | Sort anyone's Actors by runs, monthly users or bookmarks, and see where that builder ranks among all public builders. |

Every Insights page has an **Original / Plus** switch, and every feature can be turned off in the popup.

## Install

**Chrome Web Store:** [NEED: listing URL once published]

**From source:** clone the repo, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the folder. Then open [Console Insights](https://console.apify.com/actors/insights/monetization) and choose **Plus**. Needs Chrome 111+.

## Good to know

- **Your token stays in the Console page.** A small page script makes a fixed list of read-only analytics requests with the session the Console already has. The rest of the extension never sees the token.
- **Nothing leaves your browser** except requests to Apify and one public benchmark file. No analytics, no servers of our own. Details in [PRIVACY.md](PRIVACY.md).
- **If Apify changes the Console**, a failing view falls back to Apify's original page. **Settings → Diagnostics → Save report** in the popup gives you a file to attach to a bug report.
- **Rankings** come from a daily snapshot of public profile data, built by [a scheduled job](.github/workflows/refresh-builder-benchmark.yml) in this repo.

## Development

No dependencies, no build step. Plain JavaScript in `content/` and `lib/`.

```sh
npm test               # unit tests (Node 20+)
npm run release:check  # checks, tests, builds the zip and verifies its contents
```

Code layout, release steps and the Console-change checklist are in [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE), by Devansh Tiwari. Started as a fork of [apify-insights-plus](https://github.com/igolaizola/apify-insights-plus) by Iñigo Garcia Olaizola.

<sub>"Apify" is a trademark of Apify Technologies s.r.o. This project is independent and not affiliated with or endorsed by Apify.</sub>
