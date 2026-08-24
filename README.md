# The Hidden Lodge Website

Official guild website for The Hidden Lodge, a semi-hardcore AOTC/Mythic raiding guild on Illidan (US).

## Overview

The site combines public guild information, Blizzard-authenticated member profiles, cached roster and raider analytics views, curated resource links, a lore archive, and a guild officer admin area for day-to-day operations.

## Quick Navigation

- [Quick Start](#quick-start)
- [Tech Stack](#tech-stack)
- [Feature Flags (Guild Hiatus)](#feature-flags-guild-hiatus)
- [Features](#features)
- [Routes & API](#routes)
- [Database](#data-model)
- [Development](#development-details)
- [Deployment](#deployment)

## Feature Flags (Guild Hiatus)

The guild is between raid seasons. Several features are disabled in place — code, data, and DB schema are preserved but pages/routes/nav entries are gated off — via a single flag map at `src/lib/feature-flags.ts` (`FEATURE_FLAGS`). See `AGENTS.md` for the exact gating pattern if you're re-enabling one. Currently `false`:

- `rosterTeams` — `/admin/roster-teams` and its API routes. `/raiders` no longer depends on this; it lists all level-90 guild characters directly instead (see below).
- `raidSignups` — `/signup`, `/admin/raid-signups`, and the "Preferred Role" profile setting.
- `attendance` — `/admin/log-matching`, `/admin/performance-review`, the attendance-refresh cron, and the Attendance/Sim DPS stat cards on raider profiles.
- `applications` — the "How to Apply" section on `/raiding` and `/admin/applications`.
- `feedback` — `/feedback` and `/admin/feedback`.
- `tools` — `/trinkets`, `/professions`, `/loot-history`, `/upgrades`, and the "Tools" nav dropdown.
- `sim` — the interactive Sim Tools panel on raider profiles and the admin "Purge All Sim Data" action.

Separately, `/raiders`, `/signup`, `/trinkets`, `/professions`, `/loot-history`, and `/upgrades` are also redirected to `/hiatus` by `src/middleware.ts` (`HIATUS_PATHS`) — `/raiders` was removed from that set so it stays live, sourced from the level-90 roster.

`/raiders` additionally won't record any new tracking data (gear/ilvl, M+ score, crests, keystones, Great Vault, history snapshots) until Season 2 actually starts — see `SEASON_2_START_TIMESTAMP` in `src/lib/wow-reset.ts`.

## Features

### User-Facing

- Public home page with guild identity, raiding summary, and external guild links
- Leadership page with officer bios, portrait lightbox, and dad jokes
- Raiding page with schedule, expectations, addons, and recruitment info (recruitment currently points to the guild's Raider.IO profile; the application form is disabled — see Feature Flags)
- Lore archive with story picker, reader, and artwork lightbox
- Useful Links page (`/links`) — sourced live from the Tagstash public API (bookmarks tagged `wow`), not admin-managed in this repo; see [Notes](#notes)
- Articles page (`/articles`) — WoW writeups sourced live from a public Orboro.net API (posts tagged World of Warcraft), linking out to the full post there; small credit links to Orboro.net appear on this page and the homepage
- Live roster page with Blizzard data, caching, search, filters, and collection stats
- Raiders analytics table of all level-90 guild characters (iLvl, M+, crests, preparedness, upgrades, raid progress) — Season 2 countdown banner shown until tracking data starts, plus a gear-summary view (`/raiders/gear-summary`)
- Raider detail profile with character render, equipment layout, and raid progress matrix
- Authenticated profile with Battle.net login, character sync, main selection, and timezone preferences
- *Disabled during guild hiatus (code/data preserved, see Feature Flags):* guild-member raid signup calendar, Trinkets/Professions/Loot History/Upgrades tools, guild feedback form, application form, interactive Sim Tools panel and Attendance history on raider profiles

### Admin Features

- Mains & Alts module for member authentication, nickname management, and searchable member list (by nickname, main, or any character name); officer notes per member with author and timestamp, stored by character so notes on un-authenticated roster members automatically merge once they log in
- Settings module with raid-progress configuration (including the Season 2 raid tier) and cache health
- Export module for addon-friendly JSON generation
- **Raiding Content editor** for managing the schedule, raid expectations, and required addons displayed on the public Raiding page
- *Disabled during guild hiatus (code/data preserved, see Feature Flags):* Roster Teams module, Raid Signups module, Log Matching, Performance Review, Applications module, Feedback review, interactive sim tools, "Purge All Sim Data"

## Quick Start

Run the normal dev command to start both the Astro site and the local cron refresher together:

```bash
npm run dev
```

If you need the site without the refresher, use:

```bash
npm run dev:site
```

Default local URL:

```text
http://localhost:4321
```

## Tech Stack

- Astro 6 SSR
- Cloudflare Pages hosting
- Cloudflare D1 for persistent data
- Blizzard Battle.net OAuth2 and WoW APIs
- TypeScript
- astro-icon with Lucide icons

## Routes

### Public Pages

| Route | Auth | Description |
|---|---|---|
| `/` | No | Home page with guild overview and external guild profile links |
| `/leadership` | No | Leadership bios, portraits, and portrait lightbox |
| `/raiding` | No | Raid schedule, expectations, addons, recruitment (Raider.IO link), and recent Warcraft Logs reports. Application form disabled — see Feature Flags |
| `/lore` | No | Lore archive with story picker, story reader, and artwork lightbox |
| `/links` | No | Useful links tagged `wow` on the Tagstash public API, with category filter chips |
| `/articles` | No | WoW articles pulled live from Orboro.net's public posts API; cards link out to the full post on orboro.net |
| `/articles/:slug` | No | 301-redirects to the matching post on orboro.net (rewrites to `/404` if the slug isn't found in the current feed) |
| `/roster` | No | Cached guild roster with filters, sorting, pagination, and collection stats |
| `/hiatus` | No | Guild-hiatus notice page; several routes redirect here (see Feature Flags) |
| `/raiders` | Yes + Guild Member | Raider analytics table for all level-90 guild characters |
| `/raiders/gear-summary` | Yes + Guild Member | Cross-raider equipped-gear summary table (guarded by `middleware.ts`, not an in-page check) |
| `/raiders/:charId` | Yes + Guild Member | Raider detail page with media, stats, and raid progress matrix |
| `/trinkets` | Yes + Guild Member | **Disabled** (redirects to `/hiatus`) — trinket tier comparison tool |
| `/professions` | Yes | **Disabled** (redirects to `/hiatus`) — profession recipe browser |
| `/loot-history` | Yes | **Disabled** (redirects to `/hiatus`) — guild loot history log |
| `/upgrades` | Yes + Guild Member | **Disabled** (redirects to `/hiatus`) — gear upgrade comparison tool |
| `/feedback` | Yes + Guild Member | **Disabled** — anonymous guild feedback form |

### Authenticated / Admin Pages

| Route | Auth | Description |
|---|---|---|
| `/profile` | Yes | Battle.net account profile, main-character selection, timezone; "Preferred Role" hidden while raid signups are disabled |
| `/signup` | Yes + Guild Member | **Disabled** (redirects to `/`) — raid signup calendar with timezone-aware raid times |
| `/admin` | Yes + Admin | Redirects to `/admin/mains` |
| `/admin/raid-signups` | Yes + Admin | **Disabled** — manage primary schedules and ad-hoc raids |
| `/admin/roster-teams` | Yes + Admin | **Disabled** — multi-team raid roster builder and analysis |
| `/admin/mains` | Yes + Admin | Member overview, main/alt visibility, and nickname management |
| `/admin/log-matching` | Yes + Admin/Officer | **Disabled** — match Warcraft Logs reports to raid occurrences |
| `/admin/performance-review` | Yes + Admin | **Disabled** — officer review tables for excessive deaths and other performance metrics |
| `/admin/settings` | Yes + Admin | Raid-progress target settings (including Season 2 tier) and cache health controls |
| `/admin/cache` | Yes + Admin | Backward-compatible redirect to `/admin/settings` |
| `/admin/raiding` | Yes + Admin | Edit schedule, raid expectations, and addon list |
| `/admin/applications` | Yes + Admin | **Disabled** — review, triage, and manage guild applications |
| `/admin/feedback` | Yes + Admin | **Disabled** — review submitted guild feedback |

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
| `/api/profile/update-nickname` | POST | Sets or clears the authenticated user's own nickname (distinct from `/api/admin/update-nickname`) |
| `/api/profile/update-timezone` | POST | Sets the authenticated user's preferred timezone |
| `/api/profile/update-role` | POST | **Disabled** — sets the authenticated user's preferred raid role |
| `/api/signup/create` | POST | **Disabled** — creates or updates a member signup for a raid |
| `/api/signup/cancel` | POST | **Disabled** — cancels a member signup for a raid |
| `/api/signup/update-note` | POST | **Disabled** — updates notes on an existing member signup (before raid start) |
| `/api/apply` | POST | **Disabled** — submit a guild application from the Raiding page |
| `/api/application/status` | GET | **Disabled** — returns current application status for the logged-in user |
| `/api/feedback/create` | POST | **Disabled** — submit anonymous guild feedback |

### Admin API

| Endpoint | Method | Description |
|---|---|---|
| `/api/admin/update-nickname` | POST | Set or clear a guild member display nickname |
| `/api/admin/set-main` | POST | Admin sets any user's main character (distinct from the member-facing `/api/set-main`) |
| `/api/admin/cache/refresh` | POST | Trigger roster and raiders cache refresh from admin |
| `/api/admin/settings/raid-progress-target` | POST | Update the tracked raid-progress tier bundle |
| `/api/admin/raider-notes/create` | POST | Create a raider note for a character |
| `/api/admin/raider-notes/update` | POST | Update the text of an existing raider note |
| `/api/admin/raider-notes/delete` | POST | Delete a raider note; restricted to `isAdmin` plus a single hardcoded battle tag |
| `/api/admin/loot-history/exclude` | POST | Mark a loot history entry excluded with a required admin note |
| `/api/admin/attendance/log-candidates` | GET | **Disabled** — candidate Warcraft Logs reports for matching to an attendance occurrence |
| `/api/admin/attendance/log-matching` | POST, GET | **Disabled** — link/rematch a WCL report to an attendance occurrence |
| `/api/admin/attendance/refresh` | POST | **Disabled** — trigger a full attendance cache refresh |
| `/api/admin/attendance/toggle-bench` | POST, GET | **Disabled** — toggle a member's bench status for a raid occurrence |
| `/api/admin/settings/purge-sim-data` | POST | **Disabled** — permanently delete all stored sim runs/recommendations |
| `/api/admin/raid-signups/create-primary` | POST | **Disabled** — create a recurring primary raid schedule |
| `/api/admin/raid-signups/delete-primary` | POST | **Disabled** — delete a recurring primary raid schedule |
| `/api/admin/raid-signups/create-adhoc` | POST | **Disabled** — create an ad-hoc raid |
| `/api/admin/raid-signups/delete-adhoc` | POST | **Disabled** — delete an ad-hoc raid |
| `/api/admin/raid-signups/update-signup-role` | POST | **Disabled** — override a member signup role |
| `/api/admin/roster-teams/create-team` | POST | **Disabled** — create a raid team |
| `/api/admin/roster-teams/update-team` | POST | **Disabled** — update team name, mode, and sort order |
| `/api/admin/roster-teams/delete-team` | POST | **Disabled** — delete a raid team |
| `/api/admin/roster-teams/add-member` | POST | **Disabled** — add a level 90 member to a team with assigned role |
| `/api/admin/roster-teams/remove-member` | POST | **Disabled** — remove a member from a team |
| `/api/admin/roster-teams/update-member-role` | POST | **Disabled** — update assigned role for an existing team member |
| `/api/admin/raiding/update-content` | POST | Update a raiding page content panel (schedule, expectations, or recruitment) |
| `/api/admin/raiding/create-addon` | POST | Add a required addon |
| `/api/admin/raiding/update-addon` | POST | Update addon name, URL, or sort order |
| `/api/admin/raiding/delete-addon` | POST | Delete a required addon |
| `/api/admin/applications/[id]/set-status` | POST | **Disabled** — update an application's triage status |
| `/api/admin/applications/[id]/add-note` | POST | **Disabled** — add an officer note to an application |
| `/api/admin/applications/[id]/delete-note` | POST | **Disabled** — delete an officer note from an application |
| `/api/admin/applications/[id]/delete` | POST | **Disabled** — permanently delete an application and all associated data |
| `/api/admin/feedback/update-status` | POST | **Disabled** — update a feedback item's reviewed status |

### Sim Runner API

Machine-to-machine endpoints for local/external simulation runners. These endpoints do not rely on session auth and require `X-Sim-Runner-Key`.

| Endpoint | Method | Description |
|---|---|---|
| `/api/sim/targets` | GET | Returns deterministic team/member simulation targets for active roster teams |
| `/api/sim/passive/tasks` | GET | Returns stale passive background sim tasks for runners (single-target prioritized before droptimizer) |
| `/api/sim/results` | POST | Ingests simulation output and persists run/winner data with idempotency by `(run_id, site_team_id)` |
| `/api/sim/runs/start` | POST | Optional lifecycle endpoint to mark a sim run as started |
| `/api/sim/runs/heartbeat` | POST | Optional lifecycle endpoint to mark a sim run as running/healthy |
| `/api/sim/runs/finish` | POST | Optional lifecycle endpoint to mark a sim run as finished or failed |

Required request header for the endpoints above:

```http
X-Sim-Runner-Key: <SIM_RUNNER_KEY>
```

Authentication behavior:

1. Missing key returns `401 Unauthorized`.
2. Invalid key returns `401 Unauthorized`.
3. Session cookies are not used for these machine endpoints.

### Sim UI Read API

| Endpoint | Method | Description |
|---|---|---|
| `/api/sim/latest?team_id=<id>&difficulty=<value>` | GET | Returns latest successful run and normalized winners for UI rendering |
| `/api/sim/latest` | POST | Purges stored sim history for the authenticated raider (ownership or admin required), returning the refreshed latest data |
| `/api/sim/purge` | POST | Older/simpler purge endpoint with the same ownership check; kept alongside `POST /api/sim/latest`, which additionally returns refreshed data |
| `/api/raiders/[charId]/raidbots-reports` | GET, POST, DELETE | CRUD for a raider's linked Raidbots droptimizer report entries |
| `/api/raiders/[charId]/raidbots-table` | GET | Rendered droptimizer/upgrade table data for a raider |

Intended usage: internal website/admin UI reads. These endpoints require an authenticated guild member (or admin) session.

Note: the interactive "launch a sim from the site" flow (and its `WOWSIM_APP_*` config) has been removed from the UI — passive droptimizer scheduling runs automatically instead. No `/api/sim/launch*` endpoints exist in the current codebase.

### API Payload Schema

See type definitions in `src/lib/sim-api.ts` and endpoint implementations in `src/pages/api/sim/` for complete request/response schemas.

### Sim Runner Local Testing

Targets pull:

```bash
curl -sS \
	-H "X-Sim-Runner-Key: $SIM_RUNNER_KEY" \
	http://localhost:4321/api/sim/targets
```

Results push:

```bash
curl -sS \
	-X POST \
	-H "Content-Type: application/json" \
	-H "X-Sim-Runner-Key: $SIM_RUNNER_KEY" \
	-d @sim-results.json \
	http://localhost:4321/api/sim/results
```

### Scheduled / Maintenance API

| Endpoint | Method | Description |
|---|---|---|
| `/api/cron/refresh` | GET | Refreshes roster, raiders, attendance, professions, and warms trinket cache in small class batches; requires `X-Cron-Secret` (formerly `/api/cron/refresh-roster`, which still works as an alias). Accepts `?skipRaiders=1` to pair with `/api/cron/refresh-raiders` below |
| `/api/cron/refresh-raiders` | GET | Raiders-only refresh split out of `/api/cron/refresh` so it gets the full request timeout; requires `X-Cron-Secret` |
| `/api/cron/refresh-attendance` | GET | Refreshes Warcraft Logs attendance report cache and participant scoring data; requires `X-Cron-Secret` |
| `/api/cron/backfill-gear` | GET | One-shot gear backfill for raiders missing cached gear, safe to call repeatedly; requires `X-Cron-Secret`; `?limit=` (default 25, max 100) |

`/api/cron/refresh` optional query params:

- `detailBatchSize`: override roster detail batch size for this run.
- `backfillBatchSize`: override roster quest/death/critter backfill batch size for this run.
- `professionBatchSize`: override professions sync batch size for this run.
- `trinketBatchSize`: number of classes to pre-warm in trinkets cache for this run (defaults to `1`, rotates classes between runs).

You can also set `TRINKET_CACHE_WARM_BATCH_SIZE`, `ROSTER_DETAIL_BATCH_SIZE`, or `ROSTER_BACKFILL_BATCH_SIZE` in runtime env as defaults for the query params above.

### Desktop App API

Machine endpoints for the `HiddenLodgeDesktop` companion app (separate repo). Require `X-Desktop-Key` matching `DESKTOP_API_KEY`, not session auth.

| Endpoint | Method | Description |
|---|---|---|
| `/api/desktop/raid-signups-today` | GET | Today's raid signup/attendance status per roster member |
| `/api/desktop/alt-notes` | GET | Per-character preferred-note data (nickname, falling back to main character) |
| `/api/desktop/droptimizer-upgrades` | GET | Droptimizer upgrade entries formatted for the desktop app |
| `/api/desktop/loot-history` | POST | Ingests loot-history entries from the desktop app (dedupes Midnight S1 raids) |
| `/api/desktop/preparedness` | GET | Gem/enchant preparedness and vault data |

### Debug API

| Endpoint | Method | Description |
|---|---|---|
| `/api/debug/trinkets-cache-version` | GET | Admin-only. Returns the trinket cache key prefix, schema version, and paging constants for debugging |

### Local Dev Cron Refresher

Use the built-in local refresher script when running dev locally (for cases where cron-job.org cannot reach localhost).

1. Ensure your local dev env has `CRON_SECRET` set (for Astro/Cloudflare runtime auth).
2. Optionally set `LOCAL_CRON_SECRET` for the refresher process (if omitted, the script falls back to `CRON_SECRET` from process env, then `.dev.vars`).
3. Start local development with `npm run dev`.

Example `.dev.vars` values (used by local dev runtime):

```env
CRON_SECRET=replace-with-a-local-secret
```

Example shell env values for the refresher process:

```bash
# optional: defaults shown
LOCAL_CRON_URL=http://localhost:4321/api/cron/refresh
LOCAL_CRON_INTERVAL_SECONDS=300
LOCAL_CRON_RUN_ON_START=true
LOCAL_CRON_STARTUP_WAIT_SECONDS=30
LOCAL_CRON_SECRET=replace-with-a-local-secret
```

Notes:

1. `npm run dev` starts both the site and the refresher.
2. The refresher waits briefly for the local site to be reachable before attempting its first refresh.
3. Use `npm run dev:site` if you want Astro without the refresher.

Run only the local refresher:

```bash
npm run cron:local
```

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
| `roster_members_cache` | Cached Blizzard guild roster data plus collection stats. Source of truth for `/raiders` (all level-90 rows) |
| `raider_metrics_cache` | Cached per-raider metrics including iLvl, M+, tier, gems/enchants, crest totals, missing upgrades, and raid progress. Cleared of Season 1 data by `migrations/0065_season1_data_purge.sql`; repopulates after Season 2 starts (`SEASON_2_START_TIMESTAMP` in `src/lib/wow-reset.ts`) |
| `raider_progression_history` | Rolling history of equipped item level, M+ score, crest totals, and missing upgrades for each raider |
| `raider_preparedness_history` | Rolling history of gem/enchant socket coverage per raider (backs the 30-day averages on `raider_metrics_cache`) |
| `raider_vault_history` | Weekly Great Vault snapshots per raider per reset week |
| `raider_keystones` | Every observed Mythic+ keystone completion per character; backs weekly/season run counts and vault key levels |
| `raider_gear_cache` | Cached equipped-gear snapshots backing `/raiders/gear-summary` and the desktop droptimizer-upgrades endpoint |
| `raid_log_reports_seen` / `raider_log_activity` | Warcraft Logs report cursor and recent-raider activity synced independently of the (disabled) attendance pipeline — see `AGENTS.md` |
| `loot_history` | Guild loot history entries synced from the desktop app, with admin exclude/note support *(feature disabled — see Feature Flags)* |
| `raider_notes` | Officer notes per raider character, shown on `/admin/mains` |
| `sim_item_scores` | Per-item sim scoring data |
| `sim_raidbots_reports` / `sim_raidbots_item_scores` | Linked Raidbots droptimizer reports and their item scores, backing `/api/raiders/[charId]/raidbots-*` |
| `profession_recipe_owners_cache` / `profession_character_sync_cache` | Cached profession recipe/character sync data *(feature disabled)* |
| `item_icon_cache` | Cached Wowhead item icon lookups |
| `primary_raid_schedules` | Recurring primary raid schedule definitions *(feature disabled — see Feature Flags)* |
| `ad_hoc_raids` | One-off officer-created raids *(feature disabled)* |
| `raid_signups` | Member signups mapped to primary occurrences and ad-hoc raids *(feature disabled)* |
| `raid_teams` | Saved raid team definitions with mode and ordering *(feature disabled)* |
| `raid_team_members` | Team membership assignments and role ownership *(feature disabled)* |
| `site_settings` | Small key-value settings store (e.g., tracked raid-progress target) |
| `raiding_content` | Key-value store for admin-editable raiding page sections (schedule, expectations, recruitment) |
| `raiding_addons` | Ordered list of required addons displayed on the Raiding page |
| `recruitment_needs` | Open recruitment class/role/priority entries. Admin UI and public display removed; table retained unused in case it's reintroduced |
| `applications` | Guild applications submitted from the Raiding page *(feature disabled)* |
| `application_characters` | Characters attached to each application *(feature disabled)* |
| `application_notes` | Officer notes attached to each application *(feature disabled)* |
| `guild_feedback` | Anonymous/named guild feedback submissions *(feature disabled)* |
| `sim_runs` / `sim_raider_summaries` / `sim_item_winners` | Stored sim (droptimizer/single-target) run results *(interactive Sim Tools UI disabled; data left in place)* |
| `raid_attendance_reports` and related attendance tables (from `migrations/0045`–`0048`, `0064`) | Cached Warcraft Logs attendance/kill-presence data and scoring *(feature disabled)* |

`links` and `link_categories` were dropped by `migrations/0072_drop_links_tables.sql` — `/links` now reads from Tagstash instead (see [Notes](#notes)). Articles similarly have no local table; `/articles` reads from a public Orboro.net API.

### Roster Cache Behavior

- Roster summary data uses a short TTL for quick refreshes
- Character detail data uses a longer TTL and refreshes in batches to avoid Blizzard and platform limits
- Character detail sync includes quest-completion and death totals (when available from Blizzard character statistics)
- The roster page can render from cached data while the cache warms additional members in the background
- New cache columns that default to `0` use companion backfill flags so existing rows continue warming until each member has been revalidated
- Raiders cache separates summary sync and detail sync to avoid heavy Blizzard fan-out on every request
- Raiders detail/media calls use app-level client-credentials access so details are not blocked on per-user Battle.net login
- Raiders detail sync stores crest totals and total missing upgrades for every level-90 guild character
- Raid progress is stored as structured JSON labels for reliable table/profile rendering
- No new raiders detail/history data is recorded before Season 2 starts (`SEASON_2_START_TIMESTAMP` in `src/lib/wow-reset.ts`), even if refresh cron or the admin "Refresh Now" button runs earlier

## Project Structure

### Key Folders

- **`migrations/`** — D1 SQL migrations ordered by creation date
- **`db-seeds/`** — Local development seed SQL files (never run in production)
- **`public/`** — Static assets: images for leadership and lore pages, Cloudflare routing config
- **`scripts/`** — Build and deployment helper scripts
- **`src/components/`** — Reusable Astro components (cards, layouts, sections)
- **`src/data/`** — Static data files (jokes, external links, raid progress targets)
- **`src/layouts/`** — Layout templates for page rendering
- **`src/lib/`** — Core modules for auth, Blizzard API integration, roster caching, WoW data
- **`src/pages/`** — Route definitions (public pages, admin section, API endpoints, auth flow)

See the repository structure for complete file listings.

## Development Details

Install dependencies and start local development:

```sh
npm install
npm run dev
```

To run only the Astro site without the local refresher:

```sh
npm run dev:site
```

Build and preview locally:

```sh
npm run build
npm run preview
```

## Database Setup

Available helper scripts:

```sh
npm run db:bootstrap:local
npm run db:migrate:local -- migrations/0061_preserve_raider_notes.sql
npm run db:migrate:prod -- migrations/0061_preserve_raider_notes.sql
```

Bootstrap and live migrations are intentionally separate now.

- `db:bootstrap:local` is for building a fresh local schema from the full historical migration chain.
- `db:bootstrap:prod:empty` exists only for an intentionally empty remote database and refuses to run if user tables already exist.
- `db:migrate:local` and `db:migrate:prod` apply a single named migration file.
- `db:migrate:prod` creates protected-table backups before applying a migration that touches protected data and blocks destructive SQL by default.
- `db:setup:prod` was removed to avoid replaying historical destructive migrations against live production data.

For existing production databases, apply only newly introduced migrations instead of replaying the full chain.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BLIZZARD_CLIENT_ID` | Yes | Blizzard OAuth client ID |
| `BLIZZARD_CLIENT_SECRET` | Yes | Blizzard OAuth client secret |
| `BLIZZARD_REDIRECT_URI` | Yes | OAuth callback URL |
| `WCL_CLIENT_ID` | No | Warcraft Logs OAuth client ID (enables Recent Logs uploader and publish time metadata) |
| `WCL_CLIENT_SECRET` | No | Warcraft Logs OAuth client secret (enables Recent Logs uploader and publish time metadata) |
| `CRON_SECRET` | Yes | Shared secret for roster refresh requests |
| `SIM_RUNNER_KEY` | Yes (for sim APIs) | Shared secret used by `/api/sim/*` machine endpoints via `X-Sim-Runner-Key` |
| `DESKTOP_API_KEY` | Yes (for desktop API) | Shared secret used by `/api/desktop/*` endpoints via `X-Desktop-Key` |
| `SESSION_SECRET` | Yes | Session signing and validation secret |
| `RAIDER_IO_ACCESS_KEY` | No | Optional Raider.IO API access key |
| `ROSTER_DETAIL_BATCH_SIZE` | No | Default roster detail sync batch size (overridable per-run via `detailBatchSize` on `/api/cron/refresh`) |
| `ROSTER_BACKFILL_BATCH_SIZE` | No | Default roster backfill batch size (overridable per-run via `backfillBatchSize` on `/api/cron/refresh`) |
| `TRINKET_CACHE_WARM_BATCH_SIZE` | No | Default trinket cache warm class count per cron run (overridable via `trinketBatchSize` on `/api/cron/refresh`) |

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

## Migration Safety

- Historical migrations can contain destructive SQL for one-time schema repairs. They are preserved for bootstrap reproducibility, not for replay against live production.
- New production migrations should be forward-only and data-preserving whenever possible.
- The migration safety checker blocks destructive SQL in new migrations unless the file is explicitly annotated or part of the legacy allowlist.
- Protected tables are backed up automatically before a production migration touches them. Backup artifacts are written to `.migration-backups/`.

## Notes

- `/admin/*` routes are protected by middleware and require an officer-level guild rank or higher.
- `/api/cron/refresh` should be called by an external scheduler such as Cloudflare Cron Triggers (or a third-party pinger); there is no `[triggers] crons` entry in `wrangler.toml`. The build also bakes a `scheduled()` handler into the Worker (`scripts/patch-wrangler-config.mjs`) that calls this endpoint internally.
- External guild links (Raider.IO, Warcraft Logs, WoWProgress, YouTube) are defined in `src/data/externalLinks.ts` and render as favicon icon links in the main nav.
- `/links` is sourced live from the Tagstash public API (bookmarks tagged `wow` under profile `JD`, `src/lib/bookmarks.ts`), cached 10 minutes at the edge. There is no admin CRUD or D1 table for it in this repo — links are curated in Tagstash itself.
- `/articles` and the homepage's "Latest Articles" feed are sourced live from a public Orboro.net API (`src/lib/orboro-posts.ts`, posts tagged World of Warcraft), cached 10 minutes at the edge, with a small credit link back to orboro.net on both pages. `/articles/:slug` 301-redirects to the matching post on orboro.net rather than rendering content locally.
- Lore content is currently authored directly in `src/pages/lore.astro`.
- Google Analytics (`gtag.js`) is loaded site-wide from `src/layouts/Layout.astro`; disclosed in the Privacy Policy (`/privacy`).
- `src/pages/auth/blizzard-callback.astro` appears to be an unused/orphaned duplicate of `src/pages/auth/callback.ts` (the actual OAuth flow uses `/auth/callback`) — worth confirming and removing rather than documenting as a live route.
- `PROTECTED_TABLES` in `scripts/d1-migration-helpers.mjs` (`users`, `characters`, `raider_notes`, `raid_signups`, `loot_history`, `applications`, `application_notes`) is the only set that gets an automatic pre-migration backup. Anything else — take a manual `wrangler d1 export` before running a destructive migration against production.
