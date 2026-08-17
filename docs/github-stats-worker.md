# Dynamic GitHub profile cards

The `mikeebuilds-github-stats` Cloudflare Worker renders live SVG cards for the
MikeeBuilds profile:

- `/stats.svg` — current-year total/private/public contributions and public/
  private repository totals.
- `/languages.svg` — language bytes aggregated across public and private owned
  repositories. Repository names and source code are never returned.
- `/streak.svg` — current-year contribution streaks using the authenticated
  contribution calendar.
- `/health` — static deployment health and version metadata.

Responses are cached for 15 minutes to protect GitHub's API quota. GitHub's own
image proxy can add a further delay before README cards refresh.

## Credential boundary

`GITHUB_TOKEN` is a Cloudflare Worker secret and must never be committed. Use a
fine-grained GitHub token with read-only access to repository metadata for the
MikeeBuilds account. The public SVGs expose aggregate counts and language totals
only.

## Deploy

```bash
npm install
npx wrangler secret put GITHUB_TOKEN
npm run deploy
```
