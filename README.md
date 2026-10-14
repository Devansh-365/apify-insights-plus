# 🌪️ Apify Insights Plus

This Chrome extension adds extra views to the [Apify Console Insights](https://console.apify.com/actors/insights/monetization) pages and public Actor detail pages. You can always switch back to Apify's original views.

## What it adds

- **Monetization:** Compare months, use the 1m, 3m, 6m, and 1y shortcuts, and group charts by day, week, or month. Click a day to pin a tooltip with Actors that earned revenue or ran that day; sort the Actor, Revenue, Cost, Profit, Runs, or Results columns. The tooltip shows up to 20 Actors by default, configurable from the extension popup.
- **Acquisition:** See totals and data for all Actors in searchable and sortable tables. This includes percentages, referrers, and countries.
- **Actor quality:** See all your Actors in one table with their scores, setup checks, highlights, and suggestions.
- **Debugging:** See the success rate for all Actors. Select an Actor to see its User runs.
- **Public Actor pages:** See Active Users last 30 days, Runs last 30 days, Total/Lifetime runs, Created At, Pricing Updated, Last Run, and the public run-status chart on each public Actor detail page. If Apify exposes day-wise run data in a future response, the chart can render those daily bars; the current public API only publishes 30-day status totals.
- **Public profiles:** Sort Actor cards by Runs, monthly runs, MAUs, Users, Bookmarks, or newest-created date, and filter them with numeric thresholds such as “MAUs at least 10” or “Runs more than 1,000.” Public profile Actor Stats also show account-wide total runs and monthly runs (last 30 days), loaded in the background from the same cached catalog without delaying the initial profile render.
- **Cache:** Historical API responses are kept for 15 minutes. Current-month API responses are kept for 5 minutes, public Actor snapshots for 15 minutes, and the per-Actor Monetization breakdown for 15 minutes. Use **Clear cache** in the popup to remove it.

## Install manually from GitHub

1. Clone this repository: `git clone https://github.com/igolaizola/apify-insights-plus.git`
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the cloned repository folder, the one containing `manifest.json`.
6. Open an Apify Console Insights page and choose `Original` or `Plus` in the top navigation.

When you install a new version, pull the latest changes, open `chrome://extensions`, click **Reload** for the extension, and refresh your Apify tabs.

## Check the code

```sh
npm test
npm run check
npm run build
```

## Developer

Created by [@igolaizola on Apify](https://apify.com/igolaizola?fpr=ig). You can also find me on [X](https://x.com/igolaizola).

## Inspired by

This project was inspired by [Apify Analytics Plus](https://chromewebstore.google.com/detail/apify-analytics-plus/mcnblibjpmacdmhibkipbaiaicadckbh).
