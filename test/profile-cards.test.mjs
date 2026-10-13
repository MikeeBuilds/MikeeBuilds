import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_NAMES, collectCards, refreshCards, validateSVG } from "../scripts/refresh-profile-cards.mjs";
import { renderActivity, renderLanguages, renderStats, renderStreak } from "../src/worker.mjs";

const NOW = new Date("2026-10-13T20:00:00.000Z");
const SNAPSHOT = {
  username: "MikeeBuilds", year: 2026, generatedAt: NOW.toISOString(),
  repositoryTotal: 2, privateRepositoryTotal: 1,
  languages: [{ name: "Swift", color: "#F05138", percentage: 100 }],
  contributions: { total: 30, restricted: 20, streaks: { current: 3, longest: 5 }, days: [] },
};
const RENDERERS = { stats: renderStats, languages: renderLanguages, streak: renderStreak };

function calendar() {
  return { data: { user: { contributionsCollection: { contributionCalendar: { weeks: [{
    contributionDays: Array.from({ length: 30 }, (_, index) => {
      const day = new Date("2026-09-14T00:00:00Z");
      day.setUTCDate(day.getUTCDate() + index);
      return { date: day.toISOString().slice(0, 10), contributionCount: index };
    }),
  }] } } } } };
}

function fakeFetch(change = () => null) {
  return async (url, options) => {
    const changed = change(url, options);
    if (changed) return changed;
    if (url === "https://api.github.com/graphql") return Response.json(calendar());
    const name = new URL(url).pathname.slice(1, -4);
    return new Response(RENDERERS[name](SNAPSHOT), { headers: { "content-type": "image/svg+xml; charset=utf-8" } });
  };
}

test("collects private-aware SVGs and generates a 30-day graph without sending a token to the Worker", async () => {
  const requests = [];
  const cards = await collectCards({ token: "private-test-token", now: NOW,
    fetchImpl: fakeFetch((url, options) => { requests.push({ url, options }); }),
  });
  assert.deepEqual(Object.keys(cards), CARD_NAMES);
  assert.equal(requests.length, 4);
  for (const { options } of requests.slice(0, 3)) {
    assert.equal(options.headers, undefined);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
  }
  const query = JSON.parse(requests[3].options.body);
  assert.doesNotMatch(query.query, /repositories|restrictedContributions|nameWithOwner/);
  assert.equal(query.variables.from, "2026-09-14T00:00:00.000Z");
  assert.match(cards.languages, /public \+ private/);
  assert.match(cards.languages, /fetched 2026-10-13 20:00 UTC/);
  assert.match(cards.activity, /2026-10-13: 29 contributions/);
  assert.match(cards.activity, /30 reported days/);
  assert.doesNotMatch(JSON.stringify(cards), /private-test-token|15m cache/);
  for (const svg of Object.values(cards)) assert.doesNotMatch(svg, /[ \t]+$/m);
});

test("upstream failures leave every last-good asset untouched", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "profile-cards-test-"));
  try {
    for (const name of CARD_NAMES) await writeFile(join(outputDirectory, `${name}.svg`), `last-good-${name}`);
    for (const failure of [
      new Response("upstream secret", { status: 503 }),
      new Response("<html>upstream secret</html>", { headers: { "content-type": "text/html" } }),
      new Response('<svg xmlns="http://www.w3.org/2000/svg">Activity cards are refreshing</svg>', { headers: { "content-type": "image/svg+xml" } }),
      new Response(renderLanguages(SNAPSHOT).replace('fill="#0B0714"', 'fill="&#117;rl(&#104;ttps://example.com/track)"'), { headers: { "content-type": "image/svg+xml" } }),
    ]) {
      await assert.rejects(refreshCards({ outputDirectory, token: "secret", now: NOW,
        fetchImpl: fakeFetch((url) => url.endsWith("/languages.svg") ? failure : null),
      }), (error) => !/upstream secret/.test(error.message));
      for (const name of CARD_NAMES) assert.equal(await readFile(join(outputDirectory, `${name}.svg`), "utf8"), `last-good-${name}`);
    }
  } finally { await rm(outputDirectory, { recursive: true }); }
});

test("failed, partial, duplicate, and invalid-count calendars cannot publish a replacement set", async () => {
  const malformed = [
    { errors: [{ message: "secret details" }] },
    { data: { user: null } },
  ];
  for (const mutation of [
    (days) => days.pop(),
    (days) => days.push(days[0]),
    (days) => { days[0].contributionCount = -1; },
    (days) => { days[0].contributionCount = 1.5; },
  ]) {
    const payload = calendar();
    mutation(payload.data.user.contributionsCollection.contributionCalendar.weeks[0].contributionDays);
    malformed.push(payload);
  }
  for (const payload of malformed) {
    await assert.rejects(collectCards({ token: "secret", now: NOW,
      fetchImpl: fakeFetch((url) => url.endsWith("/graphql") ? Response.json(payload) : null),
    }), (error) => /Profile calendar/.test(error.message) && !/secret details/.test(error.message));
  }
});

test("SVG validation rejects wrong-card, malformed XML and active/external content", () => {
  const svg = renderLanguages(SNAPSHOT);
  validateSVG(svg, "languages");
  for (const bad of [
    svg.replace("</svg>", ""),
    svg.replace("</svg>", '<script>alert(1)</script></svg>'),
    svg.replace("<svg ", '<svg onload="alert(1)" '),
    svg.replace("</svg>", '<image href="https://example.com/tracker"/></svg>'),
    svg.replace("<style>", '<style>@import "https://example.com/track";'),
    svg.replace("<style>", '<style>.title { fill: url(https://example.com/track); }'),
    svg.replace("<svg ", '<!DOCTYPE svg [<!ENTITY x "secret">]><svg '),
  ]) assert.throws(() => validateSVG(bad, "languages"), /Invalid languages/);
  assert.throws(() => validateSVG(svg, "stats"), /Invalid stats/);
});

test("SVG parser rejects processing instructions before, within, and after the root", () => {
  const svg = renderLanguages(SNAPSHOT);
  const instruction = '<?xml-stylesheet type="text/css" href="https://example.com/track.css"?>';
  for (const bad of [
    svg.replace("?>", "?>" + instruction),
    svg.replace("<style>", instruction + "<style>"),
    svg + instruction,
  ]) assert.throws(() => validateSVG(bad, "languages"), /Invalid languages/);
});

test("SVG validation checks XML-decoded URL attribute values", () => {
  const svg = renderLanguages(SNAPSHOT);
  for (const bad of [
    svg.replace('fill="#0B0714"', 'fill="&#117;rl(&#104;ttps://example.com/track)"'),
    svg.replace('stroke="#3B2D50"', 'stroke="&#x75;rl(&#x68;ttps://example.com/track)"'),
    svg.replace('clip-path="url(#language-bar)"', 'clip-path="&#117;rl(&#104;ttps://example.com/track)"'),
  ]) assert.throws(() => validateSVG(bad, "languages"), /Invalid languages/);
  // Decoding is not itself unsafe: known local clips and literal colors work.
  validateSVG(svg.replace('fill="#0B0714"', 'fill="&#35;0B0714"')
    .replace('clip-path="url(#language-bar)"', 'clip-path="&#117;rl(&#35;language-bar)"'), "languages");
});

test("SVG styles reject escaped imports and CSS URL escapes after XML parsing", () => {
  const svg = renderLanguages(SNAPSHOT);
  for (const directive of [
    '@im\\70 ort "https://example.com/track.css";',
    '\\40 import "https://example.com/track.css";',
    '&#64;import "https://example.com/track.css";',
    '.title { fill: u\\72l(https://example.com/track); }',
    '.title { fill: &#117;rl(https://example.com/track); }',
  ]) assert.throws(() => validateSVG(svg.replace("<style>", "<style>" + directive), "languages"), /Invalid languages/);
});

test("SVG attributes reject xml:base and any unsupported rendering/reference attribute", () => {
  const svg = renderLanguages(SNAPSHOT);
  for (const bad of [
    svg.replace("<svg ", '<svg xml:base="https://example.com/" '),
    svg.replace('<g clip-path=', '<g xml:base="https://example.com/" clip-path='),
    svg.replace("<svg ", '<svg style="fill: red" '),
    svg.replace("<rect ", '<rect filter="&#117;rl(&#104;ttps://example.com/track)" '),
    svg.replace("<rect ", '<rect cursor="https://example.com/track" '),
    svg.replace('id="language-bar"', 'id="unexpected-clip"'),
  ]) assert.throws(() => validateSVG(bad, "languages"), /Invalid languages/);
});

test("successful refresh writes exactly four parseable SVG assets", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "profile-cards-test-"));
  try {
    await refreshCards({ outputDirectory, token: "secret", now: NOW, fetchImpl: fakeFetch() });
    assert.deepEqual((await readdir(outputDirectory)).sort(), CARD_NAMES.map((name) => `${name}.svg`).sort());
    for (const name of CARD_NAMES) validateSVG(await readFile(join(outputDirectory, `${name}.svg`), "utf8"), name);
  } finally { await rm(outputDirectory, { recursive: true }); }
});

test("activity renderer handles empty, zero and future dates without invalid coordinates", () => {
  assert.match(renderActivity(SNAPSHOT), /No contribution data/);
  const svg = renderActivity({ ...SNAPSHOT, contributions: { days: [
    { date: "2026-10-12", count: 0 }, { date: "2026-10-13", count: 3 }, { date: "2026-10-14", count: 9 },
  ] } });
  assert.match(svg, /2026-10-13: 3 contributions/);
  assert.doesNotMatch(svg, /NaN|Infinity|2026-10-14/);
});

test("checked-in snapshots are safe SVGs and README only serves GitHub-local activity assets", async () => {
  for (const name of CARD_NAMES) validateSVG(await readFile(new URL(`../assets/profile/${name}.svg`, import.meta.url), "utf8"), name);
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  for (const name of CARD_NAMES) assert.ok(readme.includes(`src="./assets/profile/${name}.svg"`));
  assert.doesNotMatch(readme, /workers\.dev\/(?:stats|streak|languages|activity)\.svg|github-readme-activity-graph/);
});
