const assert = require("node:assert/strict");
const source = require("../scripts/refresh-builder-benchmark.js");

const profileUrl = new URL(source.profilePageUrl("Builder A", 2000));
assert.equal(profileUrl.searchParams.get("username"), "Builder A");
assert.equal(profileUrl.searchParams.get("offset"), "2000");
assert.equal(profileUrl.searchParams.get("limit"), "1000");
assert.equal(source.responseTotal({ data: { total: 123 } }), 123);
assert.equal(source.responsePageAdvance({ data: { count: 7 } }), 7);
assert.deepEqual(source.parseSitemapUsernames(`
  <url><loc>https://apify.com/builder-a</loc></url>
  <url><loc>https://apify.com/Builder-A/</loc></url>
  <url><loc>https://apify.com/builder-b</loc></url>
  <url><loc>https://apify.com/actors/not-a-profile</loc></url>
`), ["builder-a", "builder-b"]);

const originalFetch = global.fetch;
global.fetch = async (requestUrl) => {
  const url = new URL(requestUrl);
  if (url.hostname === "apify.com" && url.pathname === "/sitemap/users.xml") {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async text() {
        return "<url><loc>https://apify.com/builder-a</loc></url><url><loc>https://apify.com/builder-b</loc></url>";
      },
    };
  }

  assert.equal(url.hostname, "api.apify.com");
  const username = url.searchParams.get("username");
  const offset = Number(url.searchParams.get("offset"));
  assert.equal(offset, 0);
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    async json() {
      return {
        data: {
          total: 1,
          count: 1,
          items: [{
            id: `actor-${username}`,
            username,
            name: "example-actor",
            userFullName: username,
            stats: {
              totalUsers: 2,
              totalUsers30Days: 1,
              totalRuns: 10,
              publicActorRunStats30Days: { TOTAL: 3 },
            },
          }],
        },
      };
    },
  };
};

(async () => {
  try {
    const snapshot = await source.buildSnapshot();
    assert.equal(snapshot.scan.distribution, "shared");
    assert.equal(snapshot.scan.sourceScope, "apify-public-profile-sitemap");
    assert.equal(snapshot.scan.profileCount, 2);
    assert.equal(snapshot.scan.completedProfiles, 2);
    assert.equal(snapshot.scan.pageCount, 2);
    assert.equal(snapshot.scan.expectedActors, 2);
    assert.equal(snapshot.scan.indexedActors, 2);
    assert.equal(snapshot.builders.length, 2);
    assert.equal(snapshot.builders[0].metrics.monthlyRuns, 3);
    assert.equal(snapshot.builders[0].metrics.totalRuns, 10);
    console.log("shared benchmark generator tests passed");
  } finally {
    global.fetch = originalFetch;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
