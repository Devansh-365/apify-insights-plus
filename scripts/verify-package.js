#!/usr/bin/env node
/*
 * Checks the built zip before it is uploaded to the Chrome Web Store: it
 * must match the manifest version and hold only the files the extension
 * runs (plus LICENSE, which the MIT license asks copies to keep).
 * Run with `npm run release:check`.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const version = JSON.parse(fs.readFileSync("manifest.json", "utf8")).version;
const zip = `dist/Insights-Plus-for-Apify-${version}.zip`;
if (!fs.existsSync(zip)) {
  console.error(`${zip} is missing. Run npm run build first.`);
  process.exit(1);
}

const files = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean);
const allowed = /^(manifest\.json|LICENSE|(content|lib|popup|icons)\/.*)$/;
const unexpected = files.filter((file) => !allowed.test(file));
const missing = ["manifest.json", "LICENSE", "content/token-sniffer.js", "lib/error-boundary.js", "popup/popup.html"].filter((file) => !files.includes(file));

if (unexpected.length || missing.length) {
  if (unexpected.length) console.error(`Unexpected files in ${zip}:\n  ${unexpected.join("\n  ")}`);
  if (missing.length) console.error(`Missing from ${zip}:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

const bytes = fs.statSync(zip).size;
console.log(`${zip}: ${files.length} files, ${(bytes / 1024).toFixed(0)} KB, ready to upload`);
