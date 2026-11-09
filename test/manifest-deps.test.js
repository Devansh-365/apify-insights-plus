const assert = require("node:assert/strict");
const fs = require("node:fs");

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));

// Store limits and launch requirements.
assert.ok(manifest.description.length <= 132, "the Chrome Web Store allows 132 description characters");
assert.equal(manifest.minimum_chrome_version, "111", "world: MAIN content scripts need Chrome 111");
assert.match(manifest.homepage_url, /^https:\/\/github\.com\//);
assert.equal(manifest.author, "Devansh Tiwari");
assert.ok(manifest.short_name && manifest.short_name.length <= 12, "short_name fits under an icon");
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.deepEqual(manifest.permissions, ["storage"], "no permission beyond storage");
assert.equal(manifest.host_permissions, undefined, "no host permissions");

const entries = manifest.content_scripts;
const mainWorld = entries.filter((entry) => entry.world === "MAIN");
assert.equal(mainWorld.length, 1, "one MAIN-world script");
assert.deepEqual(mainWorld[0].matches, ["https://console.apify.com/*"], "the page bridge runs on the Console only");
assert.deepEqual(mainWorld[0].js, ["content/token-sniffer.js"]);

const isolated = entries.filter((entry) => entry.world !== "MAIN");
const consoleEntry = isolated.find((entry) => entry.matches.includes("https://console.apify.com/*"));
const publicEntry = isolated.find((entry) => entry.matches.includes("https://apify.com/*"));
assert.ok(consoleEntry && publicEntry, "Console and public pages have their own entries");
assert.equal(publicEntry.matches.includes("https://console.apify.com/*"), false);

// The public site gets only what its features need.
for (const consoleOnly of ["content/app.js", "content/range.js", "content/visibility.js", "lib/visibility.js", "lib/portfolio.js", "lib/insights-nav.js"]) {
  assert.equal(publicEntry.js.includes(consoleOnly), false, `${consoleOnly} is Console-only`);
}

const source = (file) => fs.readFileSync(file, "utf8");
const definedBy = (file) => [...source(file).matchAll(/(?:self|window)\.(AAP[A-Z_]*)\s*=(?!=)/g)].map((match) => match[1]);

// Every file in an entry must find, already defined, each global it reads
// without a guard. Guarded reads (`self.X?.`, `if (self.X)`, `self.X &&`,
// `typeof X`) tolerate a missing global and are skipped.
function unguardedUses(file) {
  const text = source(file);
  const uses = new Set();
  // A global the file checks for (`if (self.X)`, `&& self.X`) is optional
  // throughout that file, including inside the guarded block.
  const guarded = new Set([...text.matchAll(/(?:if\s*\(\s*|&&\s*)(?:self|window)\.(AAP[A-Z_]*)\b(?!\s*\.)/g)].map((match) => match[1]));
  for (const match of text.matchAll(/((?:self|window)\.)?\b(AAP[A-Z_]*)\b(\?\.)?/g)) {
    const [, viaSelf, name, optional] = match;
    if (optional || guarded.has(name)) continue;
    const before = text.slice(Math.max(0, match.index - 12), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 4);
    if (/typeof\s+$/.test(before) || /^\s*=(?!=)/.test(after)) continue;
    if (viaSelf && (/if\s*\(\s*$|!\s*$/.test(before) || /^\s*(&&|\?\?|\))/.test(after))) continue;
    uses.add(name);
  }
  return uses;
}

// Reads that are known to run only on the Console, so the public entry may
// leave their global out. Keep this list short and give each a reason.
const PUBLIC_EXCEPTIONS = {
  // rangeData() and rangeDate() serve the Console's ranged analytics only;
  // public pages call publicActorStore/publicActorDetails/publicStorePage.
  "lib/api.js": ["AAPR"],
};

for (const entry of [consoleEntry, publicEntry]) {
  assert.equal(entry.js[0], "lib/error-boundary.js", "the error boundary loads first");
  const all = new Set(entry.js.flatMap(definedBy));
  for (const file of entry.js) {
    const allowed = entry === publicEntry ? PUBLIC_EXCEPTIONS[file] || [] : [];
    for (const name of unguardedUses(file)) {
      if (allowed.includes(name)) continue;
      assert.ok(all.has(name), `${file} reads ${name}, which no script in the ${entry.matches[0]} entry defines`);
    }
  }
  for (const file of entry.js) assert.ok(fs.existsSync(file), `${file} exists`);
  for (const file of entry.css || []) assert.ok(fs.existsSync(file), `${file} exists`);
}

console.log("Manifest dependency tests passed");
