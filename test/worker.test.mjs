import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateLanguages,
  calculateStreaks,
  createWorker,
  fetchGitHubSnapshot,
  renderActivity,
  renderLanguages,
  renderStats,
} from "../src/worker.mjs";

test("aggregates public and private repository languages", () => {
  const languages = aggregateLanguages([
    {
      isPrivate: false,
      languages: {
        edges: [{ size: 100, node: { name: "TypeScript", color: "#3178C6" } }],
      },
    },
    {
      isPrivate: true,
      languages: {
        edges: [
          { size: 900, node: { name: "Swift", color: "#F05138" } },
          { size: 100, node: { name: "TypeScript", color: "#3178C6" } },
        ],
      },
    },
  ]);

  assert.equal(languages[0].name, "Swift");
  assert.equal(languages[0].percentage, 81.81818181818183);
  assert.equal(languages[1].size, 200);
});

test("calculates current and longest contribution streaks", () => {
  const days = [0, 2, 1, 0, 3, 4, 1, 0].map((count, index) => ({
    date: `2026-08-${String(index + 1).padStart(2, "0")}`,
    count,
  }));

  assert.deepEqual(calculateStreaks(days), { current: 3, longest: 3 });
  assert.deepEqual(calculateStreaks([...days, { date: "2026-08-09", count: 2 }]), {
    current: 1,
    longest: 3,
  });
});

test("paginates repositories without exposing repository names", async () => {
  const responses = [
    graphqlPage({ hasNextPage: true, endCursor: "next", totalCount: 2, language: "Swift" }),
    graphqlPage({ hasNextPage: false, endCursor: null, totalCount: 2, language: "TypeScript" }),
  ];
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const snapshot = await fetchGitHubSnapshot(
    "test-token",
    new Date("2026-08-17T04:00:00.000Z"),
    fetchImpl,
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[1].variables.after, "next");
  assert.equal(snapshot.repositoryTotal, 2);
  assert.equal(snapshot.privateRepositoryTotal, 2);
  assert.deepEqual(
    snapshot.languages.map((language) => language.name),
    ["Swift", "TypeScript"],
  );

  const rendered = `${renderStats(snapshot)}${renderLanguages(snapshot)}`;
  assert.match(rendered, /Swift/);
  assert.doesNotMatch(rendered, /private-repository-name/);
});

test("an unseeded image request returns valid SVG without awaiting GitHub", async () => {
  let finishFetch;
  const blocked = new Promise((resolve) => { finishFetch = resolve; });
  const storage = memoryKV();
  const context = waitContext();
  let fetches = 0;
  const worker = createWorker({
    now: () => new Date("2026-10-13T20:00:00Z"), getCache: () => null,
    fetchImpl: async () => { fetches += 1; return blocked; },
  });
  const response = await worker.fetch(new Request("https://cards.test/languages.svg"), {
    GITHUB_TOKEN: "never-expose-this-token", PROFILE_CARDS: storage,
  }, context);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /image\/svg\+xml/);
  assert.match(await response.text(), /Activity cards are refreshing/);
  assert.equal(storage.writes, 0);
  assert.equal(fetches, 1);
  // A second cold request shares the refresh rather than adding another API call.
  await worker.fetch(new Request("https://cards.test/activity.svg"), {
    GITHUB_TOKEN: "never-expose-this-token", PROFILE_CARDS: storage,
  }, context);
  assert.equal(fetches, 1);
  finishFetch(githubResponse());
  await Promise.all(context.pending);
  assert.equal(storage.writes, 1);
  assert.doesNotMatch(storage.value, /never-expose-this-token|private-repository-name|Authorization/);
});

test("scheduled refresh seeds all four cards and a cold isolate serves them without GitHub", async () => {
  const storage = memoryKV();
  const env = { GITHUB_TOKEN: "secret", PROFILE_CARDS: storage };
  const producer = createWorker({
    now: () => new Date("2026-10-13T20:00:00Z"), getCache: () => null,
    fetchImpl: async () => githubResponse(),
  });
  const scheduledContext = waitContext();
  await producer.scheduled({}, env, scheduledContext);
  await Promise.all(scheduledContext.pending);

  const worker = createWorker({
    now: () => new Date("2026-10-13T20:05:00Z"), getCache: () => null,
    fetchImpl: async () => { assert.fail("image requests must not fetch GitHub"); },
  });
  for (const path of ["stats", "languages", "streak", "activity"]) {
    const context = waitContext();
    // Existing last-good cards remain available even if a secret is absent.
    const response = await worker.fetch(new Request(`https://cards.test/${path}.svg`), {
      PROFILE_CARDS: storage,
    }, context);
    assert.equal(response.status, 200);
    const svg = await response.text();
    assert.match(svg, /<svg/);
    assert.doesNotMatch(svg, /refreshing|private-repository-name|secret/);
    assert.equal(context.pending.length, 0);
  }
});

test("stale cards survive an upstream failure and visibly keep their generation date", async () => {
  const storage = await seededKV();
  const previous = storage.value;
  const context = waitContext();
  const worker = createWorker({
    now: () => new Date("2026-10-14T20:00:00Z"), getCache: () => null,
    fetchImpl: async () => new Response("private error details", { status: 503 }),
  });
  const response = await worker.fetch(new Request("https://cards.test/languages.svg"), {
    GITHUB_TOKEN: "secret", PROFILE_CARDS: storage,
  }, context);
  assert.match(await response.text(), /updated 2026-10-13 20:00 UTC/);
  await Promise.all(context.pending);
  assert.equal(storage.value, previous);
});

test("a storage timeout still produces an image within the bounded cold-read budget", async () => {
  const worker = createWorker({ getCache: () => null, readTimeoutMs: 20 });
  const started = performance.now();
  const response = await worker.fetch(new Request("https://cards.test/languages.svg"), {
    PROFILE_CARDS: { get: () => new Promise(() => {}) },
  }, waitContext());
  assert.ok(performance.now() - started < 500);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /refreshing/);
});

test("stale edge cards survive a KV timeout and HEAD uses the same GET cache key", async () => {
  const storage = await seededKV();
  const worker = createWorker({
    now: () => new Date("2026-10-14T20:00:00Z"), readTimeoutMs: 20,
    getCache: () => ({ match: async (key) => {
      assert.equal(key.method, "GET");
      return new Response(storage.value);
    } }),
  });
  const env = { PROFILE_CARDS: { get: () => new Promise(() => {}) } };
  const response = await worker.fetch(new Request("https://cards.test/stats.svg", { method: "HEAD" }), env, waitContext());
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.match(response.headers.get("Content-Type"), /image\/svg/);
  const get = await worker.fetch(new Request("https://cards.test/stats.svg"), env, waitContext());
  assert.match(await get.text(), /updated 2026-10-13 20:00 UTC/);
});

test("fresh cron data replaces an old edge bundle rather than remaining stale for its retention TTL", async () => {
  const storage = await seededKV();
  const old = storage.value;
  const fresh = JSON.parse(old);
  fresh.generatedAt = "2026-10-13T21:00:00.000Z";
  fresh.cards["/languages.svg"] = "<svg>fresh languages</svg>";
  storage.value = JSON.stringify(fresh);
  const worker = createWorker({
    now: () => new Date("2026-10-13T21:02:00Z"),
    getCache: () => ({ match: async () => new Response(old) }),
  });
  const response = await worker.fetch(new Request("https://cards.test/languages.svg?cache-buster=anything"), {
    PROFILE_CARDS: storage,
  }, waitContext());
  assert.equal(await response.text(), "<svg>fresh languages</svg>");
});

test("malformed durable data returns a safe SVG and does not leak its contents", async () => {
  const worker = createWorker({ getCache: () => null });
  const response = await worker.fetch(new Request("https://cards.test/languages.svg"), {
    PROFILE_CARDS: { get: async () => ({ schema: 1, secret: "private-data" }) },
  }, waitContext());
  assert.equal(response.status, 200);
  const svg = await response.text();
  assert.match(svg, /refreshing/);
  assert.doesNotMatch(svg, /private-data/);
});

test("edge cache failures neither block KV reads nor fail successful durable publication", async () => {
  const storage = await seededKV();
  const brokenCache = {
    match: async () => { throw new Error("edge read failure"); },
    put: async () => { throw new Error("edge write failure"); },
  };
  const worker = createWorker({
    getCache: () => brokenCache, now: () => new Date("2026-10-13T20:05:00Z"),
    fetchImpl: async () => githubResponse(),
  });
  const env = { GITHUB_TOKEN: "secret", PROFILE_CARDS: storage };
  const response = await worker.fetch(new Request("https://cards.test/languages.svg"), env, waitContext());
  assert.match(await response.text(), /Swift/);
  const context = waitContext();
  await worker.scheduled({}, env, context);
  await Promise.all(context.pending);
  assert.equal(JSON.parse(storage.value).generatedAt, "2026-10-13T20:05:00.000Z");
});

test("scheduled failures reject without replacing last-good data", async () => {
  const storage = await seededKV();
  const previous = storage.value;
  const worker = createWorker({ getCache: () => null,
    fetchImpl: async () => new Response("denied", { status: 401 }),
  });
  const context = waitContext();
  await worker.scheduled({}, { GITHUB_TOKEN: "expired", PROFILE_CARDS: storage }, context);
  await assert.rejects(Promise.all(context.pending), /HTTP 401/);
  assert.equal(storage.value, previous);
});

test("owned activity graph handles empty and zero-count calendars without invalid coordinates", () => {
  const snapshot = { username: "MikeeBuilds", generatedAt: "2026-10-13T20:00:00Z",
    contributions: { days: [] } };
  assert.match(renderActivity(snapshot), /No contribution data/);
  snapshot.contributions.days = [
    { date: "2026-10-12", count: 0 }, { date: "2026-10-13", count: 3 },
    { date: "2026-10-14", count: 9 },
  ];
  const svg = renderActivity(snapshot);
  assert.match(svg, /2026-10-13: 3 contributions/);
  assert.doesNotMatch(svg, /NaN|Infinity|2026-10-14/);
  assert.match(svg, /2 reported days/);
});

function memoryKV() {
  return { value: null, writes: 0,
    async get() { return this.value ? JSON.parse(this.value) : null; },
    async put(_key, value) { this.value = value; this.writes += 1; },
  };
}

function waitContext() {
  return { pending: [], waitUntil(promise) { this.pending.push(promise); } };
}

function githubResponse() {
  return Response.json(graphqlPage({ hasNextPage: false, endCursor: null, totalCount: 1, language: "Swift" }));
}

async function seededKV() {
  const storage = memoryKV();
  const worker = createWorker({
    now: () => new Date("2026-10-13T20:00:00Z"), getCache: () => null,
    fetchImpl: async () => githubResponse(),
  });
  const context = waitContext();
  await worker.scheduled({}, { GITHUB_TOKEN: "secret", PROFILE_CARDS: storage }, context);
  await Promise.all(context.pending);
  return storage;
}

function graphqlPage({ hasNextPage, endCursor, totalCount, language }) {
  return {
    data: {
      user: {
        repositories: {
          totalCount,
          pageInfo: { hasNextPage, endCursor },
          nodes: [
            {
              name: "private-repository-name",
              isPrivate: true,
              stargazerCount: 1,
              languages: {
                edges: [{ size: 100, node: { name: language, color: "#F05138" } }],
              },
            },
          ],
        },
        contributionsCollection: {
          restrictedContributionsCount: 8,
          contributionCalendar: {
            totalContributions: 10,
            weeks: [
              {
                contributionDays: [
                  { contributionCount: 1, date: "2026-08-15" },
                  { contributionCount: 1, date: "2026-08-16" },
                  { contributionCount: 0, date: "2026-08-17" },
                ],
              },
            ],
          },
        },
      },
      rateLimit: { remaining: 4999, resetAt: "2026-08-17T05:00:00Z" },
    },
  };
}
