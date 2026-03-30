# The Hidden Lodge Website

Official guild website for The Hidden Lodge, a semi-hardcore AOTC/Mythic raiding guild on Illidan (US).

## Overview

The site combines public guild information, Blizzard-authenticated member profiles, cached roster and raider analytics views, curated resource links, a lore archive, and a guild officer admin area for day-to-day operations.

## Latest Release

### v1.7.1

- Fixed Great Vault world-content weekly objective bootstrapping so current-week delve progress is not zeroed when tracking starts mid-week.
- Restores world-vault slot population for raiders who already completed delves before the new tracking baseline was established.

### v1.7.0

- Added weekly Great Vault history snapshots with migration `0043_vault_history.sql`.
- Added Great Vault score views across raider pages:
	- Live score card on the Raider detail Great Vault panel
	- Score column in Great Vault History (replacing Tier display)
	- New Vault Score column on `/raiders` with sorting support
- Added an expandable Score Formula panel on Raider detail pages with transparent calculation tables and full weighting math.
- Added Vault Score header help text on `/raiders` with profile deep-link guidance for full formula details.

### v1.6.0

- Great Vault rows now use live slot-state sources for Raiders detail pages:
	- Raid slots from weekly per-boss raid encounter timestamps
	- Dungeon slots from Raider.IO weekly key data
	- World unlocks from weekly delve objective tracking
- Fixed Raider.IO parsing to support `mythic_level` responses so Dungeon vault slot ilvls populate correctly.
- Updated raid vault reward mapping to match in-game values (Heroic now displays 266 where applicable).
- Added migration `0042_world_vault_weekly_snapshot.sql` for world vault weekly objective and snapshot columns.

### v1.5.24

- Switched Raiders M+ weekly sourcing to Raider.IO's live character statistics API path used by the stats page.
- Eliminates one-by-one corrections by enabling accurate bulk refresh behavior for all members each cache cycle.

### v1.5.23

- Fixed a week-one undercount path where capped Raider.IO initialization could lock in an overly high snapshot baseline.
- Added snapshot recovery logic so affected rows re-anchor and converge closer to Raider.IO totals during Season 1 week one.

### v1.5.22

- Tightened the Raider.IO-calibrated Week 1 Mythic+ weekly cap to reduce inflated totals for outlier legacy snapshot rows.
- Improves convergence for characters that were still over-reporting weekly/total runs compared to Raider.IO.

### v1.5.21

- Hotfixed Raider M+ weekly totals to use a conservative Raider.IO-calibrated envelope, reducing Blizzard snapshot outliers while preserving high-volume runners.
- Kept all data sources on Raider.IO published API endpoints and avoided undocumented internal endpoints.

### v1.5.20

- Hotfixed Raiders Mythic+ totals so displayed M+ Total now reflects current-season runs instead of the raw lifetime-style Blizzard stat.
- Fixed week-one cache bootstrap behavior so existing raider rows converge on correct this-week totals after the Midnight Season 1 launch.

### v1.5.19

- Expanded Raiders analytics with improved Mythic+ metrics (total/this week/last week) and configurable table display.
- Added new winner spotlight cards (M+ leader, most crests, fewest missing upgrades) and improved tooltip/help text.
- Updated raider detail layout with table-order stat cards, crest total/deep-linking, and relocated Raid Progress under the character model.

## Quick Navigation

- [Quick Start](#quick-start)
- [Tech Stack](#tech-stack)
- [Features](#features)
- [Routes & API](#routes)
- [Database](#data-model)
- [Development](#development-details)
- [Deployment](#deployment)

## Features


### User-Facing

- Public home page with guild identity, raiding summary, and external guild links
- Leadership page with officer bios, portrait lightbox, and dad jokes
- Raiding page with schedule, expectations, loot notes, addons, and recruitment info
- Lore archive with story picker, reader, and artwork lightbox
- Useful Links page (curated, admin-managed, searchable)
- Live roster page with Blizzard data, caching, search, filters, and collection stats
- Raiders analytics table with team-scoped metrics (iLvl, M+, crests, preparedness, upgrades, raid progress)
- Raider detail profile with character render, equipment layout, raid progress matrix, and sim recommendations
- **Progression history:** Item Level, Mythic+ Score, and Crests/Upgrades history panels (4-week rolling window) on each raider profile
- Authenticated profile with Battle.net login, character sync, main selection, and timezone preferences
- Guild-member raid signup calendar with recurring and ad-hoc raid support

### Admin Features

- Mains & Alts module for member authentication, nickname management, and searchable member list (by nickname, main, or any character name); officer notes per member with author and timestamp, stored by character so notes on un-authenticated roster members automatically merge once they log in
- Roster Teams module for multi-team raid setup and role assignment
- Raid Signups module for schedule creation and signup management
- Links Management for useful links curation
- Settings module with raid-progress configuration and cache health
- Export module for addon-friendly JSON generation
- Interactive sim tools for droptimizer and single-target analysis
- **Raiding Content editor** for managing the schedule, raid expectations, required addons, and open recruitment needs displayed on the public Raiding page
- **Applications module** for reviewing guild applications; admins can triage with a status workflow (Received → Reviewed → Contacted → Rejected → Trial), add and delete officer notes, and view all submitted characters with Raider.io and Warcraft Logs profile links

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
| `/raiding` | No | Raid schedule, expectations, loot, addons, recruitment info, and recent Warcraft Logs reports |
| `/lore` | No | Lore archive with story picker, story reader, and artwork lightbox |
| `/links` | No | Curated useful links grouped by configurable categories |
| `/roster` | No | Cached guild roster with filters, sorting, pagination, and collection stats |
| `/raiders` | Yes + Guild Member | Cached raider analytics table for active roster-team characters |
| `/raiders/:charId` | Yes + Guild Member | Raider detail page with media, stats, and raid progress matrix |

### Authenticated / Admin Pages

| Route | Auth | Description |
|---|---|---|
| `/profile` | Yes | Battle.net account profile and main-character selection |
| `/signup` | Yes + Guild Member | Raid signup calendar with timezone-aware raid times |
| `/admin` | Yes + Admin | Redirects to `/admin/mains` |
| `/admin/raid-signups` | Yes + Admin | Manage primary schedules and ad-hoc raids |
| `/admin/roster-teams` | Yes + Admin | Multi-team raid roster builder and analysis |
| `/admin/mains` | Yes + Admin | Member overview, main/alt visibility, and nickname management |
| `/admin/settings` | Yes + Admin | Raid-progress target settings and cache health controls |
| `/admin/cache` | Yes + Admin | Backward-compatible redirect to `/admin/settings` |
| `/admin/links` | Yes + Admin | Public links category/link management |
| `/admin/raiding` | Yes + Admin | Edit schedule, raid expectations, addon list, and recruitment needs |
| `/admin/applications` | Yes + Admin | Review, triage, and manage guild applications |

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
| `/api/profile/update-timezone` | POST | Sets the authenticated user's preferred timezone |
| `/api/signup/create` | POST | Creates or updates a member signup for a raid |
| `/api/signup/cancel` | POST | Cancels a member signup for a raid |
| `/api/apply` | POST | Submit a guild application from the Raiding page |
| `/api/application/status` | GET | Returns current application status for the logged-in user |

### Admin API

| Endpoint | Method | Description |
|---|---|---|
| `/api/admin/update-nickname` | POST | Set or clear a guild member display nickname |
| `/api/admin/cache/refresh` | POST | Trigger roster and raiders cache refresh from admin |
| `/api/admin/settings/raid-progress-target` | POST | Update the tracked raid-progress tier bundle |
| `/api/admin/raid-signups/create-primary` | POST | Create a recurring primary raid schedule |
| `/api/admin/raid-signups/delete-primary` | POST | Delete a recurring primary raid schedule |
| `/api/admin/raid-signups/create-adhoc` | POST | Create an ad-hoc raid |
| `/api/admin/raid-signups/delete-adhoc` | POST | Delete an ad-hoc raid |
| `/api/admin/raid-signups/update-signup-role` | POST | Override a member signup role |
| `/api/admin/roster-teams/create-team` | POST | Create a raid team |
| `/api/admin/roster-teams/update-team` | POST | Update team name, mode, and sort order |
| `/api/admin/roster-teams/delete-team` | POST | Delete a raid team |
| `/api/admin/roster-teams/add-member` | POST | Add a level 90 member to a team with assigned role |
| `/api/admin/roster-teams/remove-member` | POST | Remove a member from a team |
| `/api/admin/roster-teams/update-member-role` | POST | Update assigned role for an existing team member |
| `/api/admin/links/create-category` | POST | Create a public link category |
| `/api/admin/links/update-category` | POST | Update category title, icon, or sort order |
| `/api/admin/links/delete-category` | POST | Delete a link category and its links |
| `/api/admin/links/create-link` | POST | Create a link inside a category |
| `/api/admin/links/update-link` | POST | Update link name, URL, or sort order |
| `/api/admin/links/delete-link` | POST | Delete a link |
| `/api/admin/raiding/update-content` | POST | Update a raiding page content panel (schedule, expectations, or recruitment) |
| `/api/admin/raiding/create-addon` | POST | Add a required addon |
| `/api/admin/raiding/update-addon` | POST | Update addon name, URL, or sort order |
| `/api/admin/raiding/delete-addon` | POST | Delete a required addon |
| `/api/admin/raiding/create-need` | POST | Add an open recruitment need |
| `/api/admin/raiding/update-need` | POST | Update a recruitment need class, role, or priority |
| `/api/admin/raiding/delete-need` | POST | Delete a recruitment need |
| `/api/admin/applications/[id]/set-status` | POST | Update an application's triage status |
| `/api/admin/applications/[id]/add-note` | POST | Add an officer note to an application |
| `/api/admin/applications/[id]/delete-note` | POST | Delete an officer note from an application |
| `/api/admin/applications/[id]/delete` | POST | Permanently delete an application and all associated data |

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
| `/api/sim/latest` | POST | Purges stored sim history for the authenticated raider (ownership or admin required) |

Intended usage: internal website/admin UI reads. These endpoints require an authenticated guild member (or admin) session.

### Sim UI Action API

| Endpoint | Method | Description |
|---|---|---|
| `/api/sim/launch` | POST | Launches a raider sim job through the external WoWSim app using either site data or pasted addon export |
| `/api/sim/launch/status?job_id=<id>&char_id=<id>` | GET | Polls WoWSim app job status and returns merged latest uploaded recommendations for the raider |

These endpoints require an authenticated guild-member (or admin) session.

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
| `/api/cron/refresh-roster` | GET | Refreshes both roster and raiders caches; requires `X-Cron-Secret` |

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
LOCAL_CRON_URL=http://localhost:4321/api/cron/refresh-roster
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
| `roster_members_cache` | Cached Blizzard guild roster data plus collection stats |
| `raider_metrics_cache` | Cached team-scoped raider metrics including iLvl, M+, tier, gems/enchants, crest totals, missing upgrades, and raid progress |
| `raider_progression_history` | 4-week rolling history of equipped item level, M+ score, crest totals, and missing upgrades for each raider |
| `primary_raid_schedules` | Recurring primary raid schedule definitions |
| `ad_hoc_raids` | One-off officer-created raids |
| `raid_signups` | Member signups mapped to primary occurrences and ad-hoc raids |
| `raid_teams` | Saved raid team definitions with mode and ordering |
| `raid_team_members` | Team membership assignments and role ownership |
| `link_categories` | Public Useful Links page categories |
| `links` | Public Useful Links entries |
| `site_settings` | Small key-value settings store (e.g., tracked raid-progress target) |
| `raiding_content` | Key-value store for admin-editable raiding page sections (schedule, expectations, recruitment) |
| `raiding_addons` | Ordered list of required addons displayed on the Raiding page |
| `recruitment_needs` | Open recruitment class/role/priority entries displayed on the Raiding page |
| `applications` | Guild applications submitted from the Raiding page |
| `application_characters` | Characters attached to each application |
| `application_notes` | Officer notes attached to each application |

### Roster Cache Behavior

- Roster summary data uses a short TTL for quick refreshes
- Character detail data uses a longer TTL and refreshes in batches to avoid Blizzard and platform limits
- Character detail sync includes quest-completion and death totals (when available from Blizzard character statistics)
- The roster page can render from cached data while the cache warms additional members in the background
- New cache columns that default to `0` use companion backfill flags so existing rows continue warming until each member has been revalidated
- Raiders cache separates summary sync and detail sync to avoid heavy Blizzard fan-out on every request
- Raiders detail/media calls use app-level client-credentials access so details are not blocked on per-user Battle.net login
- Raiders detail sync now stores crest totals and total missing upgrades for roster-team members
- Raid progress is stored as structured JSON labels for reliable table/profile rendering

## Project Structure

### Key Folders

- **`migrations/`** — D1 SQL migrations ordered by creation date (0001–0040)
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
npm run db:setup
npm run db:setup:prod
```

Migrations are stored in `migrations/` and should be applied in order.

For existing production databases, apply only newly introduced migrations instead of replaying the full chain. Example for this release:

```sh
wrangler d1 execute hidden-lodge-db --remote --file=migrations/0043_vault_history.sql
```

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
| `WOWSIM_APP_BASE_URL` | Yes (for Sim Tools launch) | Base URL for the WoWSim app used by raider profile Sim Tools |
| `WOWSIM_APP_API_KEY` | No | Optional key sent to WoWSim app in `X-WoWSim-Key` |
| `WOWSIM_APP_TRIGGER_PATH` | No | WoWSim launch path template; defaults to `/api/jobs/start` |
| `WOWSIM_APP_STATUS_PATH` | No | WoWSim status path template; defaults to `/api/jobs/{job_id}` |
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
