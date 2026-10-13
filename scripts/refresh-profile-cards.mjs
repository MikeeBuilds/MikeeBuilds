import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderActivity } from "../src/worker.mjs";

const WORKER = "https://mikeebuilds-github-stats.pokehunt-webhooks.workers.dev";
export const CARD_NAMES = ["stats", "languages", "streak", "activity"];
const QUERY = `query ProfileCalendar($from: DateTime!, $to: DateTime!) {
  user(login: "MikeeBuilds") {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar { weeks { contributionDays { date contributionCount } } }
    }
  }
}`;

// Parse, then allow only the static SVG elements/attributes our renderer uses.
// ElementTree does not fetch external entities; DTDs and external references are
// additionally rejected. Nothing from upstream is interpolated into a shell.
const VALIDATE_XML = `
import sys, xml.etree.ElementTree as ET
try:
    root = ET.fromstring(sys.stdin.read())
    allowed = {'svg', 'title', 'desc', 'style', 'rect', 'text', 'clipPath', 'g', 'circle'}
    assert root.tag == '{http://www.w3.org/2000/svg}svg'
    for element in root.iter():
        assert element.tag.startswith('{http://www.w3.org/2000/svg}')
        assert element.tag.split('}', 1)[1] in allowed
        for attribute in element.attrib:
            assert not attribute.lower().startswith('on')
            assert attribute not in ('href', '{http://www.w3.org/1999/xlink}href')
except Exception:
    sys.exit(1)
`;

export function validateSVG(svg, name) {
  const expectedTitle = {
    stats: /<title id="title">MikeeBuilds • \d{4} activity<\/title>/,
    languages: /<title id="title">Top languages • public \+ private<\/title>/,
    streak: /<title id="title">MikeeBuilds • contribution streak<\/title>/,
    activity: /<title id="title">MikeeBuilds • recent contribution activity<\/title>/,
  }[name];
  if (typeof svg !== "string" || Buffer.byteLength(svg) > 100_000
      || !expectedTitle?.test(svg) || !svg.includes("Dynamic GitHub statistics for MikeeBuilds")
      || /<!DOCTYPE|<!ENTITY|@import|url\(\s*[^#]|temporarily unavailable|credential is not configured|cards are refreshing/i.test(svg)) {
    throw new Error(`Invalid ${name} card`);
  }
  const result = spawnSync("python3", ["-c", VALIDATE_XML], {
    input: svg, encoding: "utf8", timeout: 5_000, maxBuffer: 1024,
  });
  if (result.status !== 0) throw new Error(`Invalid ${name} SVG XML`);
}

export async function collectCards({ token, fetchImpl = fetch, now = new Date() }) {
  if (!token) throw new Error("GITHUB_TOKEN is required for the public profile calendar");
  const cards = {};
  const fetchedAt = `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  for (const name of ["stats", "languages", "streak"]) {
    // Cold upstream calls may be slow; only the background job waits for them.
    const response = await fetchImpl(`${WORKER}/${name}.svg`, {
      signal: AbortSignal.timeout(60_000), redirect: "error",
    });
    if (response.status !== 200 || !/^image\/svg\+xml(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
      throw new Error(`Upstream ${name} card was not HTTP 200 SVG`);
    }
    let svg = await response.text();
    validateSVG(svg, name);
    // These are fetch timestamps, not invented data-generation timestamps.
    const footer = name === "languages" ? "Public + private language bytes" : "Public + private activity";
    svg = svg.replace(/(<text\b[^>]*class="footer"[^>]*>)[^<]*(<\/text>)/,
      `$1${footer} • fetched ${fetchedAt}$2`);
    cards[name] = svg;
  }

  const from = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 29);
  const response = await fetchImpl("https://api.github.com/graphql", {
    method: "POST", signal: AbortSignal.timeout(30_000), redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "MikeeBuilds-profile-cards" },
    body: JSON.stringify({ query: QUERY, variables: { from: from.toISOString(), to: now.toISOString() } }),
  });
  if (response.status !== 200) throw new Error("Profile calendar request failed");
  const payload = await response.json();
  const weeks = payload.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
  if (payload.errors?.length || !Array.isArray(weeks)) throw new Error("Profile calendar was unavailable");
  const startDate = from.toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);
  const days = weeks.flatMap((week) => week.contributionDays ?? [])
    .filter((day) => day.date >= startDate && day.date <= endDate)
    .map((day) => ({ date: day.date, count: day.contributionCount }))
    .sort((left, right) => left.date.localeCompare(right.date));
  // Reject partial/malformed calendars rather than silently publishing a graph
  // that implies zero activity for missing days.
  for (let index = 0; index < 30; index += 1) {
    const expectedDate = new Date(from);
    expectedDate.setUTCDate(expectedDate.getUTCDate() + index);
    const day = days[index];
    if (day?.date !== expectedDate.toISOString().slice(0, 10) || !Number.isSafeInteger(day.count) || day.count < 0) {
      throw new Error("Profile calendar was incomplete");
    }
  }
  if (days.length !== 30) throw new Error("Profile calendar contained duplicate days");
  cards.activity = renderActivity({ username: "MikeeBuilds", generatedAt: now.toISOString(), contributions: { days } });
  for (const name of CARD_NAMES) {
    cards[name] = cards[name].replace(/[ \t]+$/gm, "");
    validateSVG(cards[name], name);
  }
  return cards;
}

export async function refreshCards({ outputDirectory, ...options }) {
  const cards = await collectCards(options);
  // All network and validation work finishes before touching the last-good set.
  // The workflow publishes the complete set in one atomic Git commit; an I/O
  // failure exits nonzero and prevents that commit, retaining all live assets.
  await mkdir(outputDirectory, { recursive: true });
  for (const name of CARD_NAMES) await writeFile(join(outputDirectory, `${name}.svg`), cards[name]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    await refreshCards({ token: process.env.GITHUB_TOKEN, outputDirectory: join(root, "assets/profile") });
    console.log("Refreshed all four validated profile SVGs.");
  } catch {
    // Do not print raw upstream payloads/errors or credentials to Actions logs.
    console.error("Profile refresh failed; no update will be published. Existing cards remain live.");
    process.exitCode = 1;
  }
}
