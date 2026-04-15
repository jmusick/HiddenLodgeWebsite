export const prerender = false;

import type { APIContext } from 'astro';
import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { isCharacterOwner } from '../../../../lib/auth';
import { extractReportId, fetchRaidbotsReport, validateRaidbotsReportConfig } from '../../../../lib/raidbots';
import { getRaiderRaidbotsTableData } from '../../../../lib/sim-api';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

async function getRosterMemberName(db: D1Database, charId: number): Promise<string | null> {
  const row = await db
    .prepare('SELECT name FROM roster_members_cache WHERE blizzard_char_id = ? LIMIT 1')
    .bind(charId)
    .first<{ name: string }>();
  return row?.name ?? null;
}

async function hasRaidbotsItemLabelColumn(db: D1Database): Promise<boolean> {
  const info = await db.prepare('PRAGMA table_info(sim_raidbots_item_scores)').all<{ name: string }>();
  return (info.results ?? []).some((row) => row.name === 'item_label');
}

function parseCharId(context: APIContext): number {
  return Number(context.params.charId);
}

async function ensureCanManageCharacter(context: APIContext, charId: number): Promise<Response | null> {
  const user = context.locals.user as { id: number } | null | undefined;
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = (env as any).DB as D1Database;
  const isAdmin = Boolean((context.locals as any).isAdmin);
  if (!isAdmin && !(await isCharacterOwner(db, user.id, charId))) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  return null;
}

// ── GET ──────────────────────────────────────────────────────────────────────
export async function GET(context: APIContext): Promise<Response> {
  const charId = parseCharId(context);
  if (!Number.isFinite(charId) || charId <= 0) {
    return Response.json({ error: 'Invalid character ID' }, { status: 400 });
  }

  const db = (env as any).DB as D1Database;

  const rows = await db
    .prepare(
      `SELECT id, report_id, raid_slug, difficulty, report_title, status, error_message, fetched_at
       FROM sim_raidbots_reports
       WHERE blizzard_char_id = ?
       ORDER BY updated_at DESC`
    )
    .bind(charId)
    .all<{
      id: number;
      report_id: string;
      raid_slug: string | null;
      difficulty: string | null;
      report_title: string | null;
      status: string;
      error_message: string | null;
      fetched_at: number | null;
    }>();

  return Response.json(
    (rows.results ?? []).map((r) => ({
      id: r.id,
      reportId: r.report_id,
      raidSlug: r.raid_slug,
      difficulty: r.difficulty,
      title: r.report_title,
      status: r.status,
      errorMessage: r.error_message,
      fetchedAt: r.fetched_at,
    }))
  );
}

// ── POST ─────────────────────────────────────────────────────────────────────
export async function POST(context: APIContext): Promise<Response> {
  const charId = parseCharId(context);
  if (!Number.isFinite(charId) || charId <= 0) {
    return Response.json({ error: 'Invalid character ID' }, { status: 400 });
  }

  const authError = await ensureCanManageCharacter(context, charId);
  if (authError) return authError;

  const db = (env as any).DB as D1Database;

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Expected JSON object' }, { status: 400 });
  }

  const rawReports = (body as Record<string, unknown>).reports;
  if (!Array.isArray(rawReports) || rawReports.length === 0) {
    return Response.json({ error: 'reports must be a non-empty array' }, { status: 400 });
  }
  if (rawReports.length > 6) {
    return Response.json({ error: 'Maximum 6 reports per submission' }, { status: 400 });
  }

  const urls = rawReports
    .map((r) => (r && typeof r === 'object' ? String((r as Record<string, unknown>).url ?? '') : String(r ?? '')))
    .map((u) => u.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    return Response.json({ error: 'No valid URLs provided' }, { status: 400 });
  }

  const raiderName = await getRosterMemberName(db, charId);
  if (!raiderName) {
    return Response.json({ error: 'Character not found in roster' }, { status: 404 });
  }

  const itemLabelColumn = await hasRaidbotsItemLabelColumn(db);

  const settledResults = await Promise.allSettled(
    urls.map(async (url) => {
      const reportId = extractReportId(url);
      if (!reportId) {
        return { url, ok: false, error: 'Could not extract report ID from URL' };
      }

      let data;
      try {
        data = await fetchRaidbotsReport(reportId);
      } catch (err) {
        return { url, reportId, ok: false, error: String((err as Error).message ?? err) };
      }

      if (normalizeName(data.characterName) !== normalizeName(raiderName)) {
        return {
          url,
          reportId,
          raidSlug: data.raidSlug,
          difficulty: data.difficulty,
          ok: false,
          error: `Report character "${data.characterName}" does not match raider "${raiderName}"`,
        };
      }

      const configError = validateRaidbotsReportConfig(data);
      if (configError) {
        return {
          url,
          reportId,
          raidSlug: data.raidSlug,
          difficulty: data.difficulty,
          ok: false,
          error: configError,
        };
      }

      try {
        const now = nowSeconds();

        if (data.raidSlug !== null && data.difficulty !== null) {
          await db
            .prepare(
              `DELETE FROM sim_raidbots_reports
               WHERE blizzard_char_id = ? AND raid_slug = ? AND difficulty = ? AND report_id != ?`
            )
            .bind(charId, data.raidSlug, data.difficulty, reportId)
            .run();
        }

        await db
          .prepare(
            `INSERT INTO sim_raidbots_reports
               (blizzard_char_id, report_id, raid_slug, difficulty, report_title, fetched_at, status, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'ok', ?)
             ON CONFLICT(blizzard_char_id, report_id) DO UPDATE SET
               raid_slug    = excluded.raid_slug,
               difficulty   = excluded.difficulty,
               report_title = excluded.report_title,
               fetched_at   = excluded.fetched_at,
               status       = 'ok',
               error_message = NULL,
               updated_at   = excluded.updated_at`
          )
          .bind(charId, reportId, data.raidSlug, data.difficulty, data.title, now, now)
          .run();

        const reportRow = await db
          .prepare('SELECT id FROM sim_raidbots_reports WHERE blizzard_char_id = ? AND report_id = ?')
          .bind(charId, reportId)
          .first<{ id: number }>();

        if (!reportRow) {
          return {
            url,
            reportId,
            raidSlug: data.raidSlug,
            difficulty: data.difficulty,
            ok: false,
            error: 'Failed to persist report record',
          };
        }

        const dbReportId = reportRow.id;

        await db
          .prepare('DELETE FROM sim_raidbots_item_scores WHERE raidbots_report_id = ?')
          .bind(dbReportId)
          .run();

        if (data.scores.length > 0) {
          const stmts = data.scores.map((score) => itemLabelColumn
            ? db
                .prepare(
                  `INSERT INTO sim_raidbots_item_scores
                     (raidbots_report_id, blizzard_char_id, item_id, item_label, delta_dps, pct_gain, slot, ilvl, difficulty)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .bind(
                  dbReportId,
                  charId,
                  score.itemId,
                  score.itemLabel ?? null,
                  score.deltaDps,
                  score.pctGain ?? null,
                  score.slot ?? null,
                  score.ilvl ?? null,
                  score.difficulty ?? data.difficulty,
                )
            : db
                .prepare(
                  `INSERT INTO sim_raidbots_item_scores
                     (raidbots_report_id, blizzard_char_id, item_id, delta_dps, pct_gain, slot, ilvl, difficulty)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .bind(
                  dbReportId,
                  charId,
                  score.itemId,
                  score.deltaDps,
                  score.pctGain ?? null,
                  score.slot ?? null,
                  score.ilvl ?? null,
                  score.difficulty ?? data.difficulty,
                )
          );

          const CHUNK = 100;
          for (let i = 0; i < stmts.length; i += CHUNK) {
            await db.batch(stmts.slice(i, i + CHUNK));
          }
        }

        return {
          url,
          reportId,
          ok: true,
          raidSlug: data.raidSlug,
          difficulty: data.difficulty,
          title: data.title,
          scoresCount: data.scores.length,
          dbId: dbReportId,
          fetchedAt: now,
        };
      } catch (err) {
        return {
          url,
          reportId,
          raidSlug: data.raidSlug,
          difficulty: data.difficulty,
          ok: false,
          error: String((err as Error).message ?? err),
        };
      }
    })
  );

  const results = settledResults.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : { ok: false, error: String((r.reason as Error)?.message ?? r.reason) }
  );

  let tableData: unknown = [];
  try {
    tableData = await getRaiderRaidbotsTableData(db, charId);
  } catch {
    // Ignore table-data refresh errors; import status is still returned.
  }

  return Response.json({ results, tableData });
}

// ── DELETE ───────────────────────────────────────────────────────────────────
export async function DELETE(context: APIContext): Promise<Response> {
  const charId = parseCharId(context);
  if (!Number.isFinite(charId) || charId <= 0) {
    return Response.json({ error: 'Invalid character ID' }, { status: 400 });
  }

  const authError = await ensureCanManageCharacter(context, charId);
  if (authError) return authError;

  const db = (env as any).DB as D1Database;

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const id = Number((body as Record<string, unknown>)?.id ?? NaN);
  if (!Number.isFinite(id) || id <= 0) {
    return Response.json({ error: 'Invalid report id' }, { status: 400 });
  }

  await db
    .prepare('DELETE FROM sim_raidbots_reports WHERE id = ? AND blizzard_char_id = ?')
    .bind(id, charId)
    .run();

  return Response.json({ ok: true });
}
