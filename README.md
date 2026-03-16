# The Hidden Lodge Website

Official guild website for **The Hidden Lodge** (WoW, Illidan).

This is a static Astro site with no database. Content is managed directly in code and data files.

## Tech Stack

- Astro 6
- TypeScript (where needed)
- Static build output (`dist/`)

## Current Pages

- `/` Home
- `/roster` WoWAudit-powered guild roster
- `/raiding` Raid schedule, expectations, and required addons
- `/recruitment` Recruitment details
- `/leadership` Guild leadership bios
- `/links` Curated WoW resource links

## Project Structure

```text
/
├── public/
├── src/
│   ├── components/
│   │   └── SectionCard.astro
│   ├── data/
│   │   └── externalLinks.ts
│   ├── layouts/
│   │   └── Layout.astro
│   └── pages/
│       ├── index.astro
│       ├── raiding.astro
│       ├── recruitment.astro
│       ├── leadership.astro
│       └── links.astro
├── astro.config.mjs
└── package.json
```

## Local Development

Run from repository root:

```sh
npm install
npm run dev
```

Build and preview production output:

```sh
npm run build
npm run preview
```

## Environment Variables

- `WOWAUDIT_API_KEY` Required for the `/roster` page. Uses `Authorization: Bearer <key>` against WoWAudit.
- `WOWAUDIT_API_BASE` Optional. Defaults to `https://wowaudit.com`.

## Deployment (Cloudflare Pages, GitHub-connected)

Use a **Pages** project (not a Worker service).

- Build command: `npm run build`
- Build output directory: `dist`
- Deploy command: leave blank
- Non-production deploy command: leave blank
- Environment variable: `NODE_VERSION=22.12.0`

## Notes

- External guild profile links (Raider.IO, Warcraft Logs, WoWProgress) are defined in `src/data/externalLinks.ts`.
- Useful WoW resources are managed in `src/pages/links.astro`.
