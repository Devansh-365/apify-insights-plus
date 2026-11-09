# Contributing

Thanks for helping. Bug reports, fixes and new views for Apify developers are all welcome.

## Before you start

- **Bugs:** open an issue with the diagnostics report from the popup (**Settings → Diagnostics → Save report**).
- **Features:** open an issue first so we can agree on the shape before you build it.
- **Security problems:** don't open an issue. Follow [SECURITY.md](SECURITY.md).

## Setup

You need Chrome 111+ and Node 20+. Nothing to install: there are no dependencies and no build step.

```sh
git clone https://github.com/Devansh-365/apify-insights-plus.git
cd apify-insights-plus
npm test
```

Load the folder with **Load unpacked** in `chrome://extensions`. After editing, click **Reload** on the extension card and reload the Apify tab.

## How the code is laid out

| Path | What it holds |
|---|---|
| `manifest.json` | Three script entries: the page script for console.apify.com, the Console scripts, and a smaller set for apify.com. |
| `content/token-sniffer.js` | The only script that runs in the page itself. It reads the Console's token, makes allowlisted analytics requests, and passes back response data. |
| `lib/*.js` | Data, models and helpers with no page UI. Each file is an IIFE that sets one `self.AAP_*` global. |
| `content/*.js` | One file per view. They find Apify's page elements and mount the Plus UI next to them. |
| `content/app.css` | Every injected style, built on `--aap-*` tokens that follow Apify's light and dark themes. |
| `popup/` | Feature switches, cache, settings and diagnostics. |
| `scripts/` | The daily benchmark job and the package check. |
| `test/` | Node tests, one file per module. |

## Rules that keep the extension safe

1. **The token never leaves `content/token-sniffer.js`.** It must not appear in an event, in storage, in an error or in a log. `test/token-sniffer.test.js` checks this. Keep that check passing.
2. **New Apify endpoints go in the allowlist,** `allowedApiUrl()` in `content/token-sniffer.js`, with exact query keys, plus a test. Read-only GET requests only.
3. **No HTML built from data.** Use `createElement` and `textContent`. If you must use a template, escape every value that comes from Apify or a user.
4. **No new permissions or hosts** without an issue first. Each one needs a justification for Chrome Web Store review and an update to [PRIVACY.md](PRIVACY.md).
5. **Timers go through `AAP_LIFECYCLE.every()`** instead of `setInterval`, so they stop when the extension updates under an open tab.
6. **Never break Apify's page.** Mount next to Apify's elements, keep the **Original** view working, and let errors fail inside the Plus UI.

## Adding a file

- Add it to the right entry in `manifest.json`, after the files it depends on. Public-page features go in the apify.com entry too, and only those.
- New test files must be appended to the `test` script in `package.json`. There is no automatic test discovery.
- `test/manifest-deps.test.js` fails if a script reads a global that its manifest entry never loads.

## Pull requests

- One change per pull request, with a sentence on why.
- Run `npm run check && npm test` before opening it.
- For UI changes, add a screenshot in light and dark theme.
- Don't commit the `dist/` folder.

## Releasing (maintainer)

1. Update `version` in `manifest.json`. It is the only place the version lives.
2. Add the version's section to [CHANGELOG.md](CHANGELOG.md).
3. If data handling changed: update [PRIVACY.md](PRIVACY.md) (version and date at the top) and bump `PRIVACY_VERSION` in `popup/popup.js`, so existing users see the notice.
4. Run `npm run release:check`. It runs the checks and tests, builds `dist/Insights-Plus-for-Apify-<version>.zip`, and confirms the zip holds only extension files.
5. Load the built zip's folder unpacked and run the checklist below.
6. Tag the release: `git tag v<version> && git push origin v<version>`.
7. Upload the zip in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole). If the permissions or data use changed, update the Privacy practices tab to match. Answers to paste are in `store-assets/cws-privacy-answers.md`.

## When Apify changes the Console

Run this checklist before every release, and whenever a user reports a broken view. It takes about ten minutes with a signed-in account that has at least one paid Actor.

1. **Monetization:** the Plus chart appears, the 3m shortcut loads, clicking a day pins the Actor tooltip, and **Download JSON** saves a file.
2. **Acquisition, Quality, Debugging:** each Plus view loads its table, and the **Original / Plus** switch goes back and forth.
3. **Today and Portfolio:** both load without an error notice.
4. **My Actors:** the Not public filter shows only private Actors.
5. **apify.com:** an Actor page shows the Actor insights panel, and a builder profile sorts by Runs.
6. **Update under an open tab:** reload the extension in `chrome://extensions` with a Console tab open. The tab shows the "reload this page" notice and DevTools shows no new errors.
7. **Popup:** Diagnostics shows "No extension errors recorded" after steps 1–5.

If a step fails, the popup's error log usually names the file and line. Apify response shapes change silently, so compare a fresh response in DevTools → Network with what the model in `lib/` expects.
