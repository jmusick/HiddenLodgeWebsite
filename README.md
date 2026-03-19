# The Hidden Lodge Website

Official guild website for The Hidden Lodge, a semi-hardcore AOTC/Mythic raiding guild on Illidan (US).

## Overview

The site combines public guild information, Blizzard-authenticated member profiles, a cached guild roster, curated resource links, a lore archive, and a small admin area for guild management tasks.

## Tech Stack

- Astro 6 SSR
- Cloudflare Pages hosting
- Cloudflare D1 for persistent data
- Blizzard Battle.net OAuth2 and WoW APIs
- TypeScript
- astro-icon with Lucide icons

## User-Facing Features

- Public home page with guild identity, raiding summary, and external guild links
- Leadership page with officer bios, portrait lightbox, and rotating dad-joke flavor text
- Raiding page with schedule, expectations, loot notes, addons, and recruitment guidance
- Lore archive with:
	- story preview cards and thumbnails
	- story-first navigation via URL query selection
	- per-story dropdown switcher and back-to-list navigation
	- full-size image lightbox on story artwork
	- custom story layouts, including inset and aside artwork treatment
- Useful Links page backed by D1-managed categories and links
- Live roster page backed by Blizzard data plus D1 caching, including:
	- search and class/rank/level filters
	- sortable columns
	- pagination controls
	- collection stat spotlights for achievements, mounts, pets, and toys
	- Raider.IO shortcuts per character
- Authenticated profile page where users can:
	- log in with Battle.net
	- view their synced WoW characters
	- choose their guild main character
	- see their current main summary

## Admin Features

Admin access is granted by guild rank via middleware. Officer or higher can access the admin area.

- Admin shell with module navigation
- Mains & Alts module:
	- see authenticated guild members
	- view guild characters and non-guild characters tied to an account
	- identify member mains
	- set or clear display nicknames
	- review guild roster members who have not authenticated yet
- Links Management module:
	- create, edit, delete, and reorder link categories
	- browse available Lucide icons for categories
	- create, edit, delete, and reorder links within categories
- Export module:
	- generate character-to-label export JSON for guild addon workflows
	- copy JSON to clipboard
	- download export as a file

## Routes

### Public Pages

| Route | Auth | Description |
|---|---|---|
| `/` | No | Home page with guild overview and external guild profile links |
| `/leadership` | No | Leadership bios, portraits, and portrait lightbox |
| `/raiding` | No | Raid schedule, expectations, loot, addons, and recruitment info |
| `/lore` | No | Lore archive with story picker, story reader, and artwork lightbox |
| `/links` | No | Curated useful links grouped by configurable categories |
| `/roster` | No | Cached guild roster with filters, sorting, pagination, and collection stats |

### Authenticated / Admin Pages

| Route | Auth | Description |
|---|---|---|
| `/profile` | Yes | Battle.net account profile and main-character selection |
| `/admin` | Yes + Admin | Redirects to the default admin module |
| `/admin/mains` | Yes + Admin | Member overview, main/alt visibility, and nickname management |
| `/admin/links` | Yes + Admin | Public links category/link management |
| `/admin/export` | Yes + Admin | Export JSON for guild labels and addon workflows |

### Auth Routes

| Route | Method | Description |
|---|---|---|
| `/auth/login` | GET | Starts Blizzard OAuth2 flow and sets CSRF state |
| `/auth/callback` | GET | Completes login, syncs characters, and creates a session |
| `/auth/logout` | GET | Clears session and returns the user to the site |

## API Endpoints

### Member API

| Endpoint | Method | Description |
|---|---|---|
| `/api/set-main` | POST | Sets the authenticated user's main character |

### Admin API

| Endpoint | Method | Description |
|---|---|---|
| `/api/admin/update-nickname` | POST | Set or clear a guild member display nickname |
| `/api/admin/links/create-category` | POST | Create a public link category |
| `/api/admin/links/update-category` | POST | Update category title, icon, or sort order |
| `/api/admin/links/delete-category` | POST | Delete a link category and its links |
| `/api/admin/links/create-link` | POST | Create a link inside a category |
| `/api/admin/links/update-link` | POST | Update link name, URL, or sort order |
| `/api/admin/links/delete-link` | POST | Delete a link |

### Scheduled / Maintenance API

| Endpoint | Method | Description |
|---|---|---|
| `/api/cron/refresh-roster` | GET | Refreshes the guild roster and character-detail cache; requires `X-Cron-Secret` |

### Retired API Endpoints

These handlers remain in the codebase as retired stubs and currently return HTTP 410:

- `/api/admin/create-profile`
- `/api/admin/assign-character`
- `/api/admin/unassign-character`
- `/api/admin/update-profile`

## Authentication and Session Flow

1. User visits `/auth/login`.
2. The site creates a CSRF state token and redirects to Blizzard OAuth2.
3. Blizzard redirects back to `/auth/callback` after login approval.
4. The callback exchanges the code for an access token and syncs the user's WoW characters into D1.
5. The site creates a 7-day session and stores it in D1 plus an HTTP-only session cookie.
6. Middleware loads the user on each request and determines admin access from guild rank.

## Data Model

### Core Tables

| Table | Purpose |
|---|---|
| `users` | Battle.net account info, battle tag, optional nickname, and auth metadata |
| `sessions` | Session IDs and expiration timestamps |
| `characters` | User-owned WoW characters and selected main tracking |
| `roster_members_cache` | Cached Blizzard guild roster data plus collection stats |
| `link_categories` | Public Useful Links page categories |
| `links` | Public Useful Links entries |

### Roster Cache Behavior

- Roster summary data uses a short TTL for quick refreshes
- Character detail data uses a longer TTL and refreshes in batches to avoid Blizzard and platform limits
- The roster page can render from cached data while the cache warms additional members in the background

## Project Structure

```text
/
├── migrations/
│   ├── 0001_initial.sql
│   ├── 0002_roster_cache.sql
│   ├── 0003_admin.sql
│   ├── 0004_nickname.sql
│   └── 0005_links.sql
├── public/
│   ├── _routes.json
│   └── images/
│       ├── leadership/
│       └── lore/
├── scripts/
│   └── patch-wrangler-config.mjs
├── src/
│   ├── assets/
│   ├── components/
│   │   ├── SectionCard.astro
│   │   └── Welcome.astro
│   ├── data/
│   │   ├── dadJokes.ts
│   │   └── externalLinks.ts
│   ├── layouts/
│   │   ├── AdminLayout.astro
│   │   └── Layout.astro
│   ├── lib/
│   │   ├── auth.ts
│   │   ├── blizzard.ts
│   │   ├── debug-shim.ts
│   │   ├── roster-cache.ts
│   │   ├── runtime-env.ts
│   │   └── wow.ts
│   ├── pages/
│   │   ├── index.astro
│   │   ├── leadership.astro
│   │   ├── links.astro
│   │   ├── lore.astro
│   │   ├── profile.astro
│   │   ├── raiding.astro
│   │   ├── roster.astro
│   │   ├── admin/
│   │   │   ├── export.astro
│   │   │   ├── index.astro
│   │   │   ├── links.astro
│   │   │   └── mains.astro
│   │   ├── api/
│   │   │   ├── set-main.ts
│   │   │   ├── admin/
│   │   │   │   ├── assign-character.ts
│   │   │   │   ├── create-profile.ts
│   │   │   │   ├── unassign-character.ts
│   │   │   │   ├── update-nickname.ts
│   │   │   │   ├── update-profile.ts
│   │   │   │   └── links/
│   │   │   │       ├── create-category.ts
│   │   │   │       ├── create-link.ts
│   │   │   │       ├── delete-category.ts
│   │   │   │       ├── delete-link.ts
│   │   │   │       ├── update-category.ts
│   │   │   │       └── update-link.ts
│   │   │   └── cron/
│   │   │       └── refresh-roster.ts
│   │   └── auth/
│   │       ├── callback.ts
│   │       ├── login.ts
│   │       └── logout.ts
│   ├── env.d.ts
│   └── middleware.ts
├── astro.config.mjs
├── package.json
├── README.md
├── tsconfig.json
└── wrangler.toml
```

## Local Development

Install dependencies and start the dev server:

```sh
npm install
npm run dev
```

Default local URL:

```text
http://localhost:4321
```

Build and preview locally:

```sh
npm run build
npm run preview
```

## Database Setup

Available helper scripts:

```sh
npm run db:setup
npm run db:setup:prod
```

Migrations are stored in `migrations/` and should be applied in order.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BLIZZARD_CLIENT_ID` | Yes | Blizzard OAuth client ID |
| `BLIZZARD_CLIENT_SECRET` | Yes | Blizzard OAuth client secret |
| `BLIZZARD_REDIRECT_URI` | Yes | OAuth callback URL |
| `CRON_SECRET` | Yes | Shared secret for roster refresh requests |
| `SESSION_SECRET` | Yes | Session signing and validation secret |

## Deployment

Deploy as a Cloudflare Pages project.

- Build command: `npm run build`
- Output directory: `dist`
- Node version: `22.12.0` or newer per `package.json`
- D1 binding name: `DB`

## Versioning Workflow

This repo now supports a simple GitHub-friendly version flow based on the version in `package.json` and Git tags.

### Bump the version

Use one of these scripts depending on the release size:

```sh
npm run version:patch
npm run version:minor
npm run version:major
```

These commands use `npm version`, which will:

- update `package.json`
- update `package-lock.json`
- create a version commit
- create a Git tag like `v0.0.2`

### Push the release

After bumping the version, push commits and tags:

```sh
git push --follow-tags
```

### GitHub release automation

A GitHub Actions workflow lives at `.github/workflows/release.yml`.

When a tag matching `v*` is pushed:

- GitHub Actions creates a GitHub Release automatically
- release notes are generated from commits by GitHub

### Suggested release rules

- Patch: small fixes, copy changes, layout tweaks, minor feature polish
- Minor: new site features, new admin capabilities, new public pages or major sections
- Major: breaking workflow, data model, or deployment changes

## Notes

- `/admin/*` routes are protected by middleware and require an officer-level guild rank or higher.
- The roster refresh endpoint should be called by an external scheduler such as Cloudflare Cron Triggers.
- External guild header links are defined in `src/data/externalLinks.ts`.
- Useful Links content is stored in D1 and managed from `/admin/links`.
- Lore content is currently authored directly in `src/pages/lore.astro`.
