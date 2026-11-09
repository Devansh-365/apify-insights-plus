# Security Policy

Insights Plus for Apify runs inside the Apify Console while you are signed in, so a bug here could expose an Apify account. Security reports get priority over everything else in this project.

## What to report

Anything that lets someone:

- read the Apify Console sign-in token from outside the extension's page script (`content/token-sniffer.js`), or see it in an event, the extension's storage, an error log or a diagnostics report;
- make the extension send a request to an Apify endpoint outside its read-only allowlist, or with a method other than GET;
- inject HTML or script into Apify pages through data the extension renders (Actor names, referrers, public profile data, the benchmark snapshot);
- make the extension send data anywhere other than the hosts listed in [PRIVACY.md](PRIVACY.md);
- break Apify's own pages for users who have the extension installed.

Bugs in Apify's own services should go to Apify, not here.

## How to report

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and click **Report a vulnerability**. Only the maintainer can read the report.

Please include the extension version (shown in the popup footer), Chrome version, and steps to reproduce. A proof of concept is welcome. Please don't test against other people's Apify accounts.

## What happens next

- An acknowledgement within 3 days.
- An assessment and a planned fix date within 7 days.
- A fixed version submitted to the Chrome Web Store as soon as it is ready. Chrome Web Store review usually takes one to a few days.
- Credit in the changelog, if you'd like it.

Please keep the issue private until the fixed version is live in the Chrome Web Store.

## Supported versions

Only the latest version in the Chrome Web Store gets security fixes. Chrome updates extensions automatically.

## How the extension limits risk

For reviewers and anyone auditing the code:

- **One permission:** `storage`. No host permissions, no background script, no remote code.
- **The token stays in the page.** The Console attaches its token to its own requests. `content/token-sniffer.js` reads it there and keeps it in that script's memory. The isolated extension scripts receive only response data and an 8-character hash used to separate accounts' caches. `test/token-sniffer.test.js` checks that the token never appears in an event.
- **Fixed allowlist.** The page script sends only GET requests to listed `console-backend.apify.com` analytics paths, with listed query keys and validated values (`allowedApiUrl` in `content/token-sniffer.js`). Responses over 5 MB are refused.
- **No HTML from data.** Views are built with `textContent`. The one HTML template (the monetization tooltip in `content/app.js`) escapes Actor names.
- **The benchmark snapshot is data only.** The schema is checked before use (`content/benchmark.js`), and the snapshot is never executed.

Pages on console.apify.com can see the events between the page script and the extension, as Chrome's design requires. A script already running on that page can read the Console's token directly, so the bridge gives such a script nothing new. The allowlist keeps the extension from being used to reach any other part of an account.
