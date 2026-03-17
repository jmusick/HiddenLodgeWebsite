# The Hidden Lodge Website

Official guild website for **The Hidden Lodge** — a semi-hardcore AOTC/Mythic raiding guild on the **Illidan (US)** realm.

## Tech Stack

- **[Astro 6](https://astro.build/)** — full SSR (`output: 'server'`)
- **[Cloudflare Pages](https://pages.cloudflare.com/)** — hosting & deployment
- **[Cloudflare D1](https://developers.cloudflare.com/d1/)** — serverless SQLite database
- **[Blizzard Battle.net API](https://develop.battle.net/)** — OAuth2 authentication & WoW data
- **TypeScript** throughout
- **[astro-icon](https://www.npmjs.com/package/astro-icon)** (Lucide icons)

## Pages

| Route | Auth | Description |
|-------|------|-------------|
| `/` | No | Home page with guild summary, rules, and external profile links |
| `/leadership` | No | Leadership team bios and portraits |
| `/links` | No | Curated WoW resource links (guides, sims, M+, logs, UI, and more) |
| `/raiding` | No | Raid schedule, expectations, loot system, required addons, and recruitment info |
| `/roster` | No | Live guild roster from Blizzard API with search/filter, class colors, guild ranks, and collection stat spotlights (achievements, mounts, pets, toys) |
| `/profile` | **Yes** | Authenticated user's Battle.net account info, linked WoW characters, and main character selection |
| `/admin/mains` | **Yes + Admin** | Admin view of all authenticated members (with character lists and nickname editing) alongside unauthenticated roster members |

## API Endpoints

### Authentication

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/login` | `GET` | Starts Blizzard OAuth2 flow; sets CSRF state cookie |
| `/api/auth/callback` | `GET` | Receives OAuth code; syncs characters to DB; creates 7-day session |
| `/api/auth/logout` | `GET` | Deletes session from DB; clears cookie; redirects to `/` |

### User

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/set-main` | `POST` | Authenticated user sets their main character by `character_id` |

### Admin (admin role required)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/update-nickname` | `POST` | Set or clear a member's display nickname |

### Cron

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/cron/refresh-roster` | `GET` | Refreshes guild roster and character detail cache from Blizzard API; authorized via `X-Cron-Secret` header |

## Authentication & Session Flow

1. User clicks **Log In** → `/api/auth/login` generates a CSRF `state` token and redirects to Blizzard OAuth2.
2. After Battle.net login, Blizzard redirects back to `/api/auth/callback`.
3. The callback validates the CSRF state, exchanges the code for an access token, fetches the user's WoW characters, and upserts everything into the database.
4. A session UUID is stored in D1 with a 7-day TTL; the ID is set as an HTTP-only `hl_session` cookie.
5. Middleware loads the session on every request and checks guild rank to determine admin access (rank 0, 1, or 2 = GM / Admin / Officer).

## Database Schema (Cloudflare D1)

| Table | Purpose |
|-------|---------|
| `users` | Blizzard account info, battle tag, optional nickname, and OAuth token |
| `sessions` | Session UUIDs with expiration timestamps |
| `characters` | User-owned WoW characters synced from Blizzard Profile API; tracks which is `is_main` |
| `roster_members_cache` | Guild roster data from Blizzard Guild Roster API; includes collection stats (achievements, mounts, pets, toys) with independent 15-minute / 24-hour cache TTLs |

Migrations live in `migrations/` and are applied with `npm run db:setup` (local) or `npm run db:setup:prod` (remote).

## Roster Cache

The roster is stored in `roster_members_cache` and refreshed by the cron job:

- **Roster summary** (names, ranks, classes): 15-minute TTL
- **Character details** (collection stats): 24-hour TTL, refreshed in batches of 8 to respect Blizzard rate limits

## Project Structure

```text
/
├── migrations/          # D1 SQL migrations (run in order)
├── public/
│   └── images/
│       └── leadership/  # Leadership portrait images
├── scripts/
│   └── patch-wrangler-config.mjs  # Post-build wrangler config patch
├── src/
│   ├── components/
│   │   ├── SectionCard.astro
│   │   └── Welcome.astro
│   ├── data/
│   │   ├── dadJokes.ts        # Random dad jokes for the leadership page
│   │   └── externalLinks.ts   # Guild profile links (Raider.io, WCL, WoWProgress)
│   ├── layouts/
│   │   ├── AdminLayout.astro
│   │   └── Layout.astro
│   ├── lib/
│   │   ├── auth.ts            # Session management & admin detection
│   │   ├── blizzard.ts        # Blizzard OAuth2 & API helpers
│   │   ├── roster-cache.ts    # Guild roster caching logic
│   │   ├── runtime-env.ts     # Cloudflare runtime env helpers
│   │   └── wow.ts             # WoW class/faction color constants
│   ├── middleware.ts           # Session loading & route protection
│   └── pages/
│       ├── index.astro
│       ├── leadership.astro
│       ├── links.astro
│       ├── profile.astro
│       ├── raiding.astro
│       ├── roster.astro
│       ├── admin/
│       │   ├── index.astro    # Redirects to /admin/mains
│       │   └── mains.astro
│       ├── api/
│       │   ├── set-main.ts
│       │   ├── admin/
│       │   │   └── update-nickname.ts
│       │   └── cron/
│       │       └── refresh-roster.ts
│       └── auth/
│           ├── callback.ts
│           ├── login.ts
│           └── logout.ts
├── astro.config.mjs
├── package.json
└── wrangler.toml
```

## Local Development

```sh
npm install
npm run dev       # Dev server at http://localhost:4321
```

Build and preview:

```sh
npm run build
npm run preview
```

Apply D1 migrations locally:

```sh
npm run db:setup
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BLIZZARD_CLIENT_ID` | Yes | Blizzard OAuth2 client ID |
| `BLIZZARD_CLIENT_SECRET` | Yes | Blizzard OAuth2 client secret |
| `BLIZZARD_REDIRECT_URI` | Yes | OAuth2 callback URL |
| `CRON_SECRET` | Yes | Secret for authorizing cron requests via `X-Cron-Secret` |
| `SESSION_SECRET` | Yes | Used for session signing/validation |

## Deployment (Cloudflare Pages)

Use a **Pages** project (not a Worker service).

- **Build command:** `npm run build`
- **Build output directory:** `dist`
- **Node version:** `NODE_VERSION=22.12.0`

The Cloudflare D1 database binding is named `DB` (see `wrangler.toml`).

Apply migrations to production:

```sh
npm run db:setup:prod
```

## Notes

- The `/admin/*` routes are protected by middleware and require a guild rank of Officer or higher.
- The roster cron job must be called by an external scheduler (e.g., Cloudflare Cron Triggers) with the correct `X-Cron-Secret` header.
- External guild profile links (Raider.io, Warcraft Logs, WoWProgress) are defined in `src/data/externalLinks.ts`.
