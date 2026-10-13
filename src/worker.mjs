const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const USERNAME = "MikeeBuilds";
const CACHE_SECONDS = 900;
const MAX_REPOSITORY_PAGES = 5;
const VERSION = "2026-08-17.3";

const THEME = {
  background: "#0B0714",
  border: "#3B2D50",
  title: "#C9F227",
  text: "#F7F3FF",
  muted: "#A99DBB",
  track: "#241A33",
};

const FALLBACK_COLORS = [
  "#F05138",
  "#3178C6",
  "#3572A5",
  "#F1E05A",
  "#DEA584",
  "#00ADD8",
  "#A97BFF",
  "#89E051",
];

const PROFILE_QUERY = `
  query ProfileStats($login: String!, $from: DateTime!, $to: DateTime!, $after: String) {
    user(login: $login) {
      repositories(
        first: 100
        after: $after
        ownerAffiliations: OWNER
        isFork: false
        orderBy: { field: PUSHED_AT, direction: DESC }
      ) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          isPrivate
          stargazerCount
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges {
              size
              node {
                name
                color
              }
            }
          }
        }
      }
      contributionsCollection(from: $from, to: $to) {
        restrictedContributionsCount
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              contributionCount
              date
            }
          }
        }
      }
    }
    rateLimit {
      remaining
      resetAt
    }
  }
`;

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, version: VERSION });
    }

    const renderer = {
      "/stats.svg": renderStats,
      "/languages.svg": renderLanguages,
      "/streak.svg": renderStreak,
    }[url.pathname];

    if (!renderer) {
      return new Response("Not found", { status: 404 });
    }

    if (!env.GITHUB_TOKEN) {
      return svgResponse(renderError("Service credential is not configured"), 503);
    }

    const cache = typeof caches === "undefined" ? null : caches.default;
    const cacheKey = new Request(`${url.origin}${url.pathname}?v=${VERSION}`, request);

    if (cache) {
      const cached = await cache.match(cacheKey);
      if (cached) return request.method === "HEAD" ? withoutBody(cached) : cached;
    }

    try {
      const snapshot = await fetchGitHubSnapshot(env.GITHUB_TOKEN, new Date());
      const response = svgResponse(renderer(snapshot));

      if (cache) context.waitUntil(cache.put(cacheKey, response.clone()));
      return request.method === "HEAD" ? withoutBody(response) : response;
    } catch (error) {
      console.error("GitHub profile stats refresh failed", safeError(error));
      return svgResponse(renderError("GitHub stats are temporarily unavailable"), 502);
    }
  },
};

export async function fetchGitHubSnapshot(token, now, fetchImpl = fetch) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();
  const to = now.toISOString();
  const repositories = [];
  let after = null;
  let contributions = null;
  let repositoryTotal = 0;
  let page = 0;

  do {
    const response = await fetchImpl(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "mikeebuilds-github-stats",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        query: PROFILE_QUERY,
        variables: { login: USERNAME, from, to, after },
      }),
    });

    if (!response.ok) {
      throw new Error(`GitHub GraphQL returned HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.errors?.length) {
      throw new Error(payload.errors.map((entry) => entry.message).join("; "));
    }

    const user = payload.data?.user;
    if (!user) throw new Error("GitHub user was not returned");

    const connection = user.repositories;
    repositories.push(...(connection.nodes ?? []));
    repositoryTotal = connection.totalCount;
    contributions ??= user.contributionsCollection;
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    page += 1;
  } while (after && page < MAX_REPOSITORY_PAGES);

  if (after) throw new Error("Repository pagination exceeded the safety limit");

  return {
    username: USERNAME,
    year: now.getUTCFullYear(),
    generatedAt: now.toISOString(),
    repositoryTotal,
    privateRepositoryTotal: repositories.filter((repo) => repo.isPrivate).length,
    stars: repositories.reduce((sum, repo) => sum + (repo.stargazerCount ?? 0), 0),
    languages: aggregateLanguages(repositories),
    contributions: normalizeContributions(contributions),
  };
}

export function aggregateLanguages(repositories) {
  const totals = new Map();

  for (const repository of repositories) {
    for (const edge of repository.languages?.edges ?? []) {
      const name = edge.node?.name;
      const size = Number(edge.size ?? 0);
      if (!name || !Number.isFinite(size) || size <= 0) continue;

      const previous = totals.get(name) ?? {
        name,
        color: edge.node.color,
        size: 0,
      };
      previous.size += size;
      previous.color ||= edge.node.color;
      totals.set(name, previous);
    }
  }

  const sorted = [...totals.values()].sort((left, right) => right.size - left.size);
  const totalBytes = sorted.reduce((sum, language) => sum + language.size, 0);

  return sorted.map((language, index) => ({
    ...language,
    color: language.color || FALLBACK_COLORS[index % FALLBACK_COLORS.length],
    percentage: totalBytes === 0 ? 0 : (language.size / totalBytes) * 100,
  }));
}

export function normalizeContributions(collection) {
  const days = (collection?.contributionCalendar?.weeks ?? [])
    .flatMap((week) => week.contributionDays ?? [])
    .map((day) => ({
      date: day.date,
      count: Number(day.contributionCount ?? 0),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));

  return {
    total: Number(collection?.contributionCalendar?.totalContributions ?? 0),
    restricted: Number(collection?.restrictedContributionsCount ?? 0),
    days,
    streaks: calculateStreaks(days),
  };
}

export function calculateStreaks(days) {
  if (days.length === 0) return { current: 0, longest: 0 };

  let longest = 0;
  let running = 0;

  for (const day of days) {
    if (day.count > 0) {
      running += 1;
      longest = Math.max(longest, running);
    } else {
      running = 0;
    }
  }

  let index = days.length - 1;
  if (days[index]?.count === 0) index -= 1;

  let current = 0;
  while (index >= 0 && days[index].count > 0) {
    current += 1;
    index -= 1;
  }

  return { current, longest };
}

export function renderStats(snapshot) {
  const contribution = snapshot.contributions;
  const privatePercent = contribution.total
    ? (contribution.restricted / contribution.total) * 100
    : 0;
  const publicContributions = Math.max(0, contribution.total - contribution.restricted);
  const metrics = [
    ["Contributions", formatNumber(contribution.total)],
    ["Private contributions", formatNumber(contribution.restricted)],
    ["Public contributions", formatNumber(publicContributions)],
    ["Private activity", `${formatPercent(privatePercent)}%`],
    ["Repositories", formatNumber(snapshot.repositoryTotal)],
    ["Private repositories", formatNumber(snapshot.privateRepositoryTotal)],
  ];

  const cells = metrics
    .map(([label, value], index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = 28 + column * 235;
      const y = 74 + row * 46;
      return `
        <text x="${x}" y="${y}" class="value">${xml(value)}</text>
        <text x="${x}" y="${y + 17}" class="label">${xml(label)}</text>`;
    })
    .join("");

  return card({
    width: 480,
    height: 230,
    title: `${snapshot.username} • ${snapshot.year} activity`,
    body: cells,
    footer: `GitHub calendar + all repositories • updated ${formatTimestamp(snapshot.generatedAt)} • 15m cache`,
  });
}

export function renderLanguages(snapshot) {
  const languages = snapshot.languages.slice(0, 6);
  const barWidth = 424;
  let cursor = 28;

  const bar = languages
    .map((language) => {
      const width = (language.percentage / 100) * barWidth;
      const segment = `<rect x="${cursor.toFixed(2)}" y="57" width="${Math.max(width, 1).toFixed(2)}" height="12" fill="${xml(language.color)}"/>`;
      cursor += width;
      return segment;
    })
    .join("");

  const legend = languages
    .map((language, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = 28 + column * 235;
      const y = 101 + row * 38;
      return `
        <circle cx="${x + 5}" cy="${y - 4}" r="5" fill="${xml(language.color)}"/>
        <text x="${x + 17}" y="${y}" class="language">${xml(language.name)}</text>
        <text x="${x + 202}" y="${y}" text-anchor="end" class="percentage">${formatPercent(language.percentage)}%</text>`;
    })
    .join("");

  return card({
    width: 480,
    height: 230,
    title: "Top languages • public + private",
    body: `
      <rect x="28" y="57" width="${barWidth}" height="12" rx="6" fill="${THEME.track}"/>
      <clipPath id="language-bar"><rect x="28" y="57" width="${barWidth}" height="12" rx="6"/></clipPath>
      <g clip-path="url(#language-bar)">${bar}</g>
      ${legend}`,
    footer: `By repository language bytes • ${snapshot.repositoryTotal} repositories • 15m cache`,
  });
}

export function renderStreak(snapshot) {
  const { current, longest } = snapshot.contributions.streaks;
  const metrics = [
    [formatNumber(current), "Current streak", "days"],
    [formatNumber(longest), `Longest streak in ${snapshot.year}`, "days"],
    [formatNumber(snapshot.contributions.total), `${snapshot.year} contributions`, "private-aware"],
  ];

  const body = metrics
    .map(([value, label, suffix], index) => {
      const x = 160 + index * 320;
      return `
        <text x="${x}" y="100" text-anchor="middle" class="streak-value">${xml(value)}</text>
        <text x="${x}" y="128" text-anchor="middle" class="streak-label">${xml(label)}</text>
        <text x="${x}" y="151" text-anchor="middle" class="streak-suffix">${xml(suffix)}</text>`;
    })
    .join("");

  return card({
    width: 960,
    height: 190,
    title: `${snapshot.username} • contribution streak`,
    body,
    footer: `Public + private activity • updated ${formatTimestamp(snapshot.generatedAt)} • 15m cache`,
  });
}

export function renderActivity(snapshot) {
  const days = snapshot.contributions.days
    .filter((day) => day.date <= snapshot.generatedAt.slice(0, 10)).slice(-30);
  const maximum = Math.max(1, ...days.map((day) => day.count));
  const step = 896 / Math.max(days.length, 1);
  const bars = days.map((day, index) => {
    const height = Math.max(2, (day.count / maximum) * 138);
    const x = 32 + index * step;
    const label = index === 0 || index === days.length - 1 || index % 7 === 0
      ? `<text x="${x + (step - 5) / 2}" y="215" text-anchor="middle" class="label">${xml(day.date.slice(5))}</text>` : "";
    return `<rect x="${x.toFixed(2)}" y="${(195 - height).toFixed(2)}" width="${Math.max(1, step - 5).toFixed(2)}" height="${height.toFixed(2)}" rx="3" fill="${day.count ? THEME.title : THEME.track}"><title>${xml(day.date)}: ${xml(day.count)} contributions</title></rect>${label}`;
  }).join("");

  return card({
    width: 960,
    height: 255,
    title: `${snapshot.username} • recent contribution activity`,
    body: bars || `<text x="32" y="120" class="label">No contribution data available yet.</text>`,
    footer: `Public profile calendar • ${days.length} reported days • updated ${snapshot.generatedAt.slice(0, 16).replace("T", " ") + " UTC"}`,
  });
}

export function renderError(message) {
  return card({
    width: 480,
    height: 150,
    title: "MikeeBuilds • GitHub activity",
    body: `<text x="24" y="84" class="error">${xml(message)}</text>`,
    footer: "Owned dynamic endpoint",
  });
}

function card({ width, height, title, body, footer }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
    <title id="title">${xml(title)}</title>
    <desc id="desc">Dynamic GitHub statistics for ${USERNAME}</desc>
    <style>
      text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
      .title { fill: ${THEME.title}; font-size: 17px; font-weight: 700; }
      .value { fill: ${THEME.text}; font-size: 20px; font-weight: 700; }
      .label, .percentage, .streak-suffix { fill: ${THEME.muted}; font-size: 12px; }
      .language { fill: ${THEME.text}; font-size: 13px; font-weight: 600; }
      .footer { fill: ${THEME.muted}; font-size: 10px; }
      .streak-value { fill: ${THEME.title}; font-size: 34px; font-weight: 800; }
      .streak-label { fill: ${THEME.text}; font-size: 14px; font-weight: 600; }
      .error { fill: ${THEME.text}; font-size: 14px; }
    </style>
    <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${THEME.background}" stroke="${THEME.border}"/>
    <text x="24" y="35" class="title">${xml(title)}</text>
    ${body}
    <text x="24" y="${height - 17}" class="footer">${xml(footer)}</text>
  </svg>`;
}

function svgResponse(svg, status = 200) {
  return new Response(svg, {
    status,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": `public, max-age=300, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=3600`,
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function withoutBody(response) {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value) {
  return value.toFixed(value >= 10 ? 1 : 2).replace(/\.0$/, "");
}

function formatTimestamp(value) {
  const date = new Date(value);
  return `${date.toISOString().slice(5, 16).replace("T", " ")} UTC`;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function safeError(error) {
  return error instanceof Error ? error.message : "Unknown error";
}
