import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateLanguages,
  calculateStreaks,
  fetchGitHubSnapshot,
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
