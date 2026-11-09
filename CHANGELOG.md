# Changelog

All notable changes are listed here, newest first. Versions follow [semantic versioning](https://semver.org): a major version for changes that need new permissions or change how data is handled, a minor version for new features, a patch version for fixes.

## [1.0.0] - 2026-11-09

The first Chrome Web Store release.

### Changed

- Renamed from "Apify Insights Plus" to **Insights Plus for Apify**, to make clear it is an independent tool. The popup footer and README now say it is not affiliated with Apify.
- Pages on apify.com load 14 scripts instead of 31. Console-only code (Monetization, Portfolio, Acquisition, Quality, Today, Debugging, Not public filter) loads only on console.apify.com.
- Requires Chrome 111 or newer.

### Added

- When Plus code fails on a page, for example because Apify changed the Console, a notice offers Apify's original view. Apify's page keeps working.
- After the extension updates under an open tab, its timers stop and a notice asks you to reload the page, instead of errors piling up in the console.
- **Settings → Diagnostics** in the popup saves a report for bug reports: version, recent extension errors with query strings removed, and load timings. It is saved on your computer and contains no Apify data or token.
- The popup footer shows the version and links to the privacy policy. If the privacy policy changes in a future version, the popup says so.

### Security

- The page script refuses analytics responses larger than 5 MB.
- The extension ignores bridge events that don't have the expected shape.

### Documentation

- New [privacy policy](PRIVACY.md), [security policy](SECURITY.md) and [contributing guide](CONTRIBUTING.md).
- README rewritten with the current maintainer and the original project's credit.

## 0.0.1 - development versions

Never published to the Chrome Web Store. Installed from source between September and November 2026, starting from a fork of [igolaizola/apify-insights-plus](https://github.com/igolaizola/apify-insights-plus): ranged Monetization charts, Acquisition and Quality tables, the run success overview, public Actor and profile stats, Actor portfolio, Acquisition triage, Today list, the builder benchmark, range JSON export, profile quick views and feature switches.
