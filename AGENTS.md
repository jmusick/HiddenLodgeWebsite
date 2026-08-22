# AGENTS.md

Guidance for AI coding agents working in this repository.

## Stack

- **Astro 6** (SSR, `output: "server"`) deployed to **Cloudflare Pages/Workers** via `@astrojs/cloudflare`.
- **D1** (Cloudflare's SQLite) as the database, binding name `DB`. Schema lives as sequential SQL files in `migrations/*.sql` — there is no ORM.
- Pages (file-based routing) live in `src/pages/`. API endpoints are Astro endpoints under `src/pages/api/**/*.ts`, each exporting `POST`/`GET`/etc. and `export const prerender = false`.
- Shared server-side logic lives in `src/lib/**` (plain `.ts`, imported by both pages and API routes).
- Layouts: `src/layouts/Layout.astro` (public site chrome + nav) and `src/layouts/AdminLayout.astro` (admin nav/tabs).

## Conventions

- **Auth checks**: pages check `Astro.locals.isAdmin` / `Astro.locals.isGuildMember` / `Astro.locals.user` and `return Astro.redirect(...)` early if unauthorized. API routes check `context.locals.isAdmin` etc. and return `new Response('Forbidden', { status: 403 })` / `401` early in the handler.
- **Feature flags**: `src/lib/feature-flags.ts` exports `FEATURE_FLAGS`, a plain object of booleans (one per major feature: `rosterTeams`, `raidSignups`, `attendance`, `applications`, `feedback`, `tools`, `sim`). A feature that's temporarily disabled but not removed is gated everywhere it surfaces:
  - Nav arrays (`AdminLayout.astro`'s `adminModules`, `Layout.astro`'s `memberNavItems`) conditionally include the entry.
  - Pages add `if (!FEATURE_FLAGS.x) return Astro.redirect('/')` (public) or `return Astro.redirect('/admin')` (admin), placed after the existing auth guard.
  - API routes add `if (!FEATURE_FLAGS.x) return new Response('Not found', { status: 404 })`, placed after the existing auth guard.
  - Flip the flag back to `true` to fully restore a feature — no other code changes needed. Underlying `src/lib/*.ts` business logic and DB schema for disabled features are left intact on purpose.
- **D1 queries**: written as raw SQL via `env.DB.prepare(...).bind(...).all()/.first()/.run()`. `env` is imported from `cloudflare:workers`.
- Migrations are numbered and additive (`NNNN_description.sql`); never edit an already-applied migration — add a new one.
- **Weekly reset / season timestamps**: `src/lib/wow-reset.ts` is the single source of truth for the US weekly reset (Tuesday 11:00 AM America/New_York, DST-aware) and season-start timestamps (e.g. `SEASON_2_START_TIMESTAMP`). This used to be copy-pasted independently in three files with a wrong reset hour — always import from here rather than reimplementing it.

## Commands

- `npm run dev` — Astro dev server + local cron refresher (see `scripts/dev-with-cron.mjs`).
- `npm run build` — `astro build` then patches the Wrangler config. Note: this does **not** run a full typecheck (no `astro check` in the build pipeline) — run `npx astro check` separately if you need one; the repo currently has some pre-existing type errors that build doesn't catch.
- `npm run db:migrate:local` / `db:migrate:prod` — apply migrations. Destructive migrations (DROP/DELETE/TRUNCATE/`ALTER TABLE ... DROP COLUMN`) are blocked unless the file has a `-- allow-destructive` annotation; `npm run db:check:migrations` verifies this plus migration numbering/state without touching a database.
- `npm run db:copy-prod` — copies all production D1 data into your local D1 (schema intersection only; skips `sessions`, system tables, and by default `link_categories`/`links`/`roster_cache_meta`/`site_settings`). Requires `wrangler` to be authenticated (`npx wrangler whoami`) and a bootstrapped local schema (`npm run db:bootstrap:local`). Safe to rerun — it clears local rows (FK-dependency order) before reinserting. Set `COPY_PROD_INCLUDE_SEEDED=1` in the environment to also copy the normally-skipped seeded tables.

## Notes

- There is no `[triggers] crons` entry in `wrangler.toml`. `/api/cron/refresh` (roster/raiders/attendance/professions/trinkets — formerly named `/api/cron/refresh-roster`, kept as a compatibility alias) and `/api/cron/refresh-attendance` are both triggered externally (Cloudflare dashboard Cron Trigger and/or a third-party pinger hitting the URL with an `X-Cron-Secret` header) rather than declared in this repo. The build does bake a `scheduled()` handler into the Worker (`scripts/patch-wrangler-config.mjs`) that internally calls `/api/cron/refresh` — keep that path in sync if the route ever moves again.
- **Recent-raider filter**: `src/lib/raid-log-activity.ts` syncs "who showed up in a Hidden Lodge Warcraft Logs report lately" straight from the guild's WCL report list (guild 781707) and stores it in `raider_log_activity`. It is deliberately independent of `src/lib/attendance.ts` — that pipeline is tied to scheduled raids and stays empty while `FEATURE_FLAGS.attendance` is off — and so it is **not** gated on that flag. `/raiders` and `/raiders/gear-summary` default to the last `RECENT_LOG_WINDOW_DAYS` (30) and offer a "Show all raiders" toggle; with no synced data both pages fail open and show everyone. `raid_log_reports_seen` is the don't-refetch cursor, so a caught-up refresh costs one GraphQL call.
- A separate companion app (`HiddenLodgeDesktop`, different repo) consumes some of these API routes (e.g. `src/pages/api/desktop/raid-signups-today.ts`) — check before removing/gating an endpoint under `api/desktop/`.
