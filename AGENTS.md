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
- **Feature flags**: `src/lib/feature-flags.ts` exports `FEATURE_FLAGS`, a plain object of booleans (one per major feature: `rosterTeams`, `raidSignups`, `attendance`, `applications`, `feedback`). A feature that's temporarily disabled but not removed is gated everywhere it surfaces:
  - Nav arrays (`AdminLayout.astro`'s `adminModules`, `Layout.astro`'s `memberNavItems`) conditionally include the entry.
  - Pages add `if (!FEATURE_FLAGS.x) return Astro.redirect('/')` (public) or `return Astro.redirect('/admin')` (admin), placed after the existing auth guard.
  - API routes add `if (!FEATURE_FLAGS.x) return new Response('Not found', { status: 404 })`, placed after the existing auth guard.
  - Flip the flag back to `true` to fully restore a feature — no other code changes needed. Underlying `src/lib/*.ts` business logic and DB schema for disabled features are left intact on purpose.
- **D1 queries**: written as raw SQL via `env.DB.prepare(...).bind(...).all()/.first()/.run()`. `env` is imported from `cloudflare:workers`.
- Migrations are numbered and additive (`NNNN_description.sql`); never edit an already-applied migration — add a new one.

## Commands

- `npm run dev` — Astro dev server + local cron refresher (see `scripts/dev-with-cron.mjs`).
- `npm run build` — `astro build` (typechecks via Astro's checker as part of the build) then patches the Wrangler config.
- `npm run db:migrate:local` / `db:migrate:prod` — apply migrations.
- `npm run db:check:migrations` — verify migration numbering/state.

## Notes

- There is no `[triggers] crons` entry in `wrangler.toml`; the attendance-refresh cron (`src/pages/api/cron/refresh-attendance.ts`) is triggered externally (Cloudflare dashboard or a third-party pinger hitting the URL with an `X-Cron-Secret` header) rather than from this repo.
- A separate companion app (`HiddenLodgeDesktop`, different repo) consumes some of these API routes (e.g. `src/pages/api/desktop/raid-signups-today.ts`) — check before removing/gating an endpoint under `api/desktop/`.
