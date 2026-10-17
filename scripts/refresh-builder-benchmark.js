#!/usr/bin/env node

/* Builds the shared Builder Benchmark snapshot and optionally publishes it to a Gist. */
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");

const PUBLIC_STORE_URL = "https://api.apify.com/v2/store";
const USERS_SITEMAP_URL = "https://apify.com/sitemap/users.xml";
const GITHUB_API_URL = "https://api.github.com";
const PAGE_SIZE = 1000;
const PAGE_INTERVAL_MS = 1_100;
const PROFILE_SCAN_CONCURRENCY = 16;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 60_000;
const DEFAULT_FILENAME = "builder-rankings.json";
const DEFAULT_OUTPUT_PATH = path.join(process.cwd(), DEFAULT_FILENAME);

function loadBrowserModule(relativePath) {
  const filename = path.resolve(__dirname, "..", relativePath);
  const context = { self: {}, console };
  vm.runInNewContext(require("node:fs").readFileSync(filename, "utf8"), context, { filename });
  return context.self;
}

const { AAP_BENCHMARK: benchmark } = loadBrowserModule("lib/benchmark.js");
const { AAP_PROFILE_SORT: profileSort } = loadBrowserModule("lib/profile-sort.js");

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function responseData(response) {
  return profileSort.responseData(response);
}

function responseTotal(response) {
  const value = Number(responseData(response)?.total);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function responsePageAdvance(response) {
  const value = Number(responseData(response)?.count);
  return Number.isFinite(value) && value > 0 && value <= PAGE_SIZE ? Math.floor(value) : PAGE_SIZE;
}

function missingFieldCounts(builders) {
  const counts = {};
  for (const builder of builders) {
    for (const key of Object.keys(builder.missing || {})) counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function retryAfterMilliseconds(response, attempt) {
  const value = response.headers.get("retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(RETRY_MAX_DELAY_MS, seconds * 1000);
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return Math.min(RETRY_MAX_DELAY_MS, Math.max(0, timestamp - Date.now()));
  }
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt);
}

async function fetchWithRetry(url, options, parseResponse) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: {
          Accept: "application/json",
          "User-Agent": "apify-insights-plus-builder-benchmark",
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      if (attempt >= MAX_RETRIES) throw error;
      await wait(Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt));
      continue;
    }

    if (response.ok) return parseResponse(response);

    let data = null;
    try {
      data = await response.json();
    } catch {
      // The status below still produces a useful error for a non-JSON reply.
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      const message = data?.error?.message || data?.message || `HTTP ${response.status}`;
      throw new Error(`Request failed: ${message}`);
    }
    await wait(retryAfterMilliseconds(response, attempt));
  }
}

async function fetchJson(url, options = {}) {
  return fetchWithRetry(url, options, (response) => response.json());
}

async function fetchText(url, options = {}) {
  return fetchWithRetry(url, options, (response) => response.text());
}

function storePageUrl(sortBy, offset) {
  const url = new URL(PUBLIC_STORE_URL);
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("includeUnrunnableActors", "true");
  return url.toString();
}

function profilePageUrl(username, offset = 0) {
  const url = new URL(PUBLIC_STORE_URL);
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("username", username);
  url.searchParams.set("includeUnrunnableActors", "true");
  return url.toString();
}

function parseSitemapUsernames(xml) {
  const usernames = [];
  const seen = new Set();
  const entries = String(xml || "").matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi);
  for (const [, rawUrl] of entries) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      continue;
    }
    if (url.hostname.toLowerCase() !== "apify.com") continue;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) continue;
    let username;
    try {
      username = decodeURIComponent(parts[0]).trim();
    } catch {
      continue;
    }
    if (!username || /[/?#\s]/.test(username)) continue;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    usernames.push(username);
  }
  return usernames;
}

async function mapConcurrent(items, concurrency, worker) {
  const values = Array.isArray(items) ? items : [];
  const results = new Array(values.length);
  let nextIndex = 0;
  async function run() {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => run()));
  return results;
}

async function scanProfile(username, accumulator, onPage = () => {}) {
  let offset = 0;
  let expectedActors = null;
  let pageCount = 0;
  const visitedOffsets = new Set();

  while (true) {
    if (visitedOffsets.has(offset)) throw new Error(`The profile ${username} returned a repeated page offset.`);
    if (pageCount > 0) await wait(PAGE_INTERVAL_MS);
    visitedOffsets.add(offset);

    const response = await fetchJson(profilePageUrl(username, offset));
    const pageTotal = responseTotal(response);
    if (expectedActors == null && pageTotal != null) expectedActors = pageTotal;
    if (expectedActors != null && pageTotal != null && pageTotal !== expectedActors) {
      throw new Error(`The profile ${username} changed its Actor total while it was being scanned.`);
    }

    const actors = profileSort.normalizeStoreResponse(response, offset);
    if (!actors.length) {
      if (expectedActors != null && offset < expectedActors) {
        throw new Error(`The profile ${username} ended pagination before all Actors were returned.`);
      }
      break;
    }

    benchmark.addActors(accumulator, actors);
    pageCount++;
    onPage({ username, pageCount, indexedActors: accumulator.indexedActors });

    const nextOffset = offset + actors.length;
    if (expectedActors != null && nextOffset >= expectedActors) break;
    if (expectedActors == null && actors.length < PAGE_SIZE) break;
    if (nextOffset <= offset) throw new Error(`The profile ${username} returned an invalid page size.`);
    offset = nextOffset;
  }

  return {
    username,
    expectedActors: expectedActors == null ? 0 : expectedActors,
    pageCount,
  };
}

async function scanStore({ onProgress = () => {} } = {}) {
  const capturedAt = new Date().toISOString();
  const accumulator = benchmark.createAccumulator({ firstSeenAt: capturedAt });
  const sitemap = await fetchText(USERS_SITEMAP_URL);
  const usernames = parseSitemapUsernames(sitemap);
  if (!usernames.length) throw new Error("Apify's public user sitemap returned no builder profiles.");

  let expectedActors = 0;
  let pageCount = 0;
  let completedProfiles = 0;
  await mapConcurrent(usernames, PROFILE_SCAN_CONCURRENCY, async (username) => {
    const result = await scanProfile(username, accumulator);
    expectedActors += result.expectedActors;
    pageCount += result.pageCount;
    completedProfiles++;
    onProgress({
      profile: username,
      completedProfiles,
      profileCount: usernames.length,
      pageCount,
      indexedActors: accumulator.indexedActors,
      expectedActors,
    });
    return result;
  });

  if (!accumulator.indexedActors && expectedActors) throw new Error("The public Store returned no observable Actors.");

  const builders = benchmark.finalizeBuilders(accumulator);
  const snapshot = benchmark.buildSnapshot({
    builders,
    actorFirstSeen: {},
    capturedAt,
    scan: {
      expectedActors,
      indexedActors: accumulator.indexedActors,
      pageCount,
      sourceTotal: expectedActors,
      sourceTotalChanged: false,
      sourceWindowEnded: false,
      coverage: accumulator.indexedActors < expectedActors ? "observed" : "complete",
      missingFields: missingFieldCounts(builders),
      definitionVersion: 2,
      baseline: true,
      distribution: "shared",
      sourceScope: "apify-public-profile-sitemap",
      profileCount: usernames.length,
      completedProfiles,
    },
  });
  const compactSnapshot = benchmark.compactSnapshot(snapshot);
  if (!benchmark.validateSnapshot(compactSnapshot)) throw new Error("The benchmark snapshot failed validation.");
  return compactSnapshot;
}

async function publishGist(gistId, token, filename, contents) {
  if (!gistId) throw new Error("BUILDER_BENCHMARK_GIST_ID is required to publish the snapshot.");
  if (!token) throw new Error("BUILDER_BENCHMARK_GIST_TOKEN is required to publish the snapshot.");
  const response = await fetch(`${GITHUB_API_URL}/gists/${encodeURIComponent(gistId)}`, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "Content-Type": "application/json",
      "User-Agent": "apify-insights-plus-builder-benchmark",
    },
    body: JSON.stringify({ files: { [filename]: { content: contents } } }),
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json())?.message || "";
    } catch {
      // Keep the status useful when GitHub returns a non-JSON response.
    }
    throw new Error(`GitHub Gist update failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
}

async function main() {
  const filename = process.env.BUILDER_BENCHMARK_FILENAME || DEFAULT_FILENAME;
  const outputPath = process.env.BUILDER_BENCHMARK_OUTPUT || "";
  const snapshot = await scanStore({
    onProgress: ({ profile, completedProfiles, profileCount, pageCount, indexedActors, expectedActors }) => {
      if (completedProfiles !== 1 && completedProfiles % 100 !== 0 && completedProfiles !== profileCount) return;
      console.log(`[profiles] ${completedProfiles}/${profileCount}; latest ${profile}; pages ${pageCount}; ${indexedActors.toLocaleString()} Actors indexed; source total ${expectedActors.toLocaleString()}`);
    },
  });
  const contents = JSON.stringify(snapshot);
  const targetPath = outputPath || (!process.env.BUILDER_BENCHMARK_GIST_ID ? DEFAULT_OUTPUT_PATH : "");
  if (targetPath) {
    await fs.writeFile(targetPath, `${contents}\n`, "utf8");
    console.log(`Wrote ${Math.round(Buffer.byteLength(contents) / 1024)}KB to ${targetPath}`);
  }
  if (process.env.BUILDER_BENCHMARK_GIST_ID) {
    await publishGist(
      process.env.BUILDER_BENCHMARK_GIST_ID,
      process.env.BUILDER_BENCHMARK_GIST_TOKEN,
      filename,
      contents,
    );
    console.log(`Published ${Math.round(Buffer.byteLength(contents) / 1024)}KB to Gist ${process.env.BUILDER_BENCHMARK_GIST_ID}.`);
  }
  if (!targetPath && !process.env.BUILDER_BENCHMARK_GIST_ID) {
    throw new Error("Set BUILDER_BENCHMARK_OUTPUT for a local snapshot or BUILDER_BENCHMARK_GIST_ID to publish one.");
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildSnapshot: scanStore,
  fetchJson,
  fetchText,
  parseSitemapUsernames,
  profilePageUrl,
  publishGist,
  responsePageAdvance,
  responseTotal,
  storePageUrl,
};
