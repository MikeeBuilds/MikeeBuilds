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

// Validate decoded XML and a deliberately small CSS grammar, not raw denylist
// matches: entity encoding, CSS escapes and base URLs must not hide references.
// Nothing from upstream is interpolated into a shell.
const VALIDATE_XML = String.raw`
import re, sys, xml.etree.ElementTree as ET

class StaticSVGBuilder(ET.TreeBuilder):
    def pi(self, target, data):
        raise ValueError('Processing instructions are not allowed')
    def doctype(self, name, pubid, system):
        raise ValueError('Document types are not allowed')

classes = {
    'title', 'value', 'label', 'percentage', 'streak-suffix', 'language',
    'footer', 'streak-value', 'streak-label', 'error',
}
attributes = {
    'svg': {'width', 'height', 'viewBox', 'role', 'aria-labelledby'},
    'title': {'id'},
    'desc': {'id'},
    'style': set(),
    'rect': {'x', 'y', 'width', 'height', 'rx', 'fill', 'stroke'},
    'text': {'x', 'y', 'class', 'text-anchor'},
    'clipPath': {'id'},
    'g': {'clip-path'},
    'circle': {'cx', 'cy', 'r', 'fill'},
}
number = r'-?\d+(?:\.\d+)?'
color = r'#[0-9a-fA-F]{6}'

def validate_css(css):
    cursor = 0
    for rule in re.finditer(r'([^{}]+)\{([^{}]*)\}', css):
        assert not css[cursor:rule.start()].strip()
        cursor = rule.end()
        selectors, declarations = rule.groups()
        for selector in selectors.split(','):
            assert selector.strip() in {'text'} | {'.' + name for name in classes}
        for declaration in declarations.split(';'):
            if not declaration.strip():
                continue
            property_name, value = map(str.strip, declaration.split(':', 1))
            if property_name == 'fill':
                assert re.fullmatch(color, value)
            elif property_name == 'font-size':
                assert re.fullmatch(r'\d+px', value)
            elif property_name == 'font-weight':
                assert re.fullmatch(r'[1-9]00', value)
            elif property_name == 'font-family':
                assert value == '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif'
            else:
                raise ValueError('Unsupported style property')
    assert cursor and not css[cursor:].strip()

try:
    parser = ET.XMLParser(target=StaticSVGBuilder())
    root = ET.fromstring(sys.stdin.read(), parser=parser)
    assert root.tag == '{http://www.w3.org/2000/svg}svg'
    ids = set()
    clip_referenced = False
    for element in root.iter():
        assert element.tag.startswith('{http://www.w3.org/2000/svg}')
        tag = element.tag.split('}', 1)[1]
        assert tag in attributes
        assert set(element.attrib) <= attributes[tag]
        for attribute, value in element.attrib.items():
            if attribute in {'x', 'y', 'width', 'height', 'rx', 'cx', 'cy', 'r'}:
                assert re.fullmatch(number, value)
            elif attribute in {'fill', 'stroke'}:
                assert re.fullmatch(color, value)
            elif attribute == 'viewBox':
                assert len(value.split()) == 4
                assert all(re.fullmatch(number, part) for part in value.split())
            elif attribute == 'id':
                assert (tag, value) in {('title', 'title'), ('desc', 'desc'), ('clipPath', 'language-bar')}
                assert value not in ids
                ids.add(value)
            elif attribute == 'class':
                assert value in classes
            elif attribute == 'text-anchor':
                assert value in {'start', 'middle', 'end'}
            elif attribute == 'clip-path':
                assert value == 'url(#language-bar)'
                clip_referenced = True
            elif attribute == 'role':
                assert value == 'img'
            elif attribute == 'aria-labelledby':
                assert value == 'title desc'
            else:
                raise ValueError('Unsupported attribute')
        if tag == 'style':
            assert not len(element)
            validate_css(element.text or '')
    assert {'title', 'desc'} <= ids
    assert not clip_referenced or 'language-bar' in ids
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
  const result = spawnSync("python3", ["-I", "-c", VALIDATE_XML], {
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
