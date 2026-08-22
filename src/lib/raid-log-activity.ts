import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';

/**
 * "Has this raider actually shown up lately?" — sourced from the guild's
 * Warcraft Logs reports (https://www.warcraftlogs.com/guild/reports-list/781707)
 * rather than from the attendance tables, which are tied to the scheduled-raid
 * feature and stay empty while `FEATURE_FLAGS.attendance` is off.
 *
 * The sync is deliberately cheap so it can ride along on the 30s refresh cron:
 * one query lists the guild's reports inside the window, and only report codes
 * that aren't already in `raid_log_reports_seen` cost a second call for their
 * player list. Once caught up, a refresh is a single GraphQL request.
 */

const WCL_OAUTH_URL = 'https://www.warcraftlogs.com/oauth/token';
const WCL_GRAPHQL_URL = 'https://www.warcraftlogs.com/api/v2/client';
const WCL_GUILD_ID = 781707;

/** Window used by both the sync and the "recent raiders" page filters. */
export const RECENT_LOG_WINDOW_DAYS = 30;

const REPORT_PAGE_SIZE = 50;
const REPORT_MAX_PAGES = 4;
/** Per-run ceiling on new-report participant fetches, to bound cron time. */
const DEFAULT_MAX_REPORTS_PER_RUN = 6;

let wclTokenCache: { accessToken: string; expiresAt: number } | null = null;

function getDatabase(dbInput?: D1Database): D1Database {
  return dbInput ?? env.DB;
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function recentLogCutoffUtc(nowUtc: number = nowInSeconds()): number {
  return nowUtc - RECENT_LOG_WINDOW_DAYS * 24 * 60 * 60;
}

function normalizeName(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase();
}

// Mirrors attendance.ts: WCL reports the display realm, the roster cache stores
// a slug, so both sides get squashed into the same shape before matching.
function normalizeRealmSlug(realm: string | null | undefined): string {
  return (realm ?? '')
    .trim()
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/([a-z])([0-9])/g, '$1-$2')
    .replace(/([0-9])([a-z])/g, '$1-$2')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

async function getWclAccessToken(): Promise<string | null> {
  const clientId = (env.WCL_CLIENT_ID ?? '').trim();
  const clientSecret = (env.WCL_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;

  const now = Date.now();
  if (wclTokenCache && wclTokenCache.expiresAt > now) return wclTokenCache.accessToken;

  const response = await fetch(WCL_OAUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!response.ok) return null;

  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  const accessToken = (payload.access_token ?? '').trim();
  if (!accessToken) return null;

  wclTokenCache = {
    accessToken,
    expiresAt: now + Math.max(60, Number(payload.expires_in ?? 0) - 60) * 1000,
  };
  return accessToken;
}

async function queryWcl<T>(accessToken: string, query: string, variables: Record<string, unknown>): Promise<T | null> {
  const response = await fetch(WCL_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) return null;

  const payload = (await response.json()) as { data?: T; errors?: unknown[] };
  if ((payload.errors?.length ?? 0) > 0) return null;
  return payload.data ?? null;
}

interface GuildReportSummary {
  code: string;
  startUtc: number;
  endUtc: number;
}

async function listGuildReportsSince(accessToken: string, sinceUtc: number): Promise<GuildReportSummary[]> {
  const byCode = new Map<string, GuildReportSummary>();

  for (let page = 1; page <= REPORT_MAX_PAGES; page += 1) {
    const payload = await queryWcl<{
      reportData?: { reports?: { data?: Array<{ code?: string; startTime?: number; endTime?: number }> } };
    }>(
      accessToken,
      `
        query GuildReports($guildID: Int!, $startTime: Float!, $endTime: Float!, $limit: Int!, $page: Int!) {
          reportData {
            reports(guildID: $guildID, startTime: $startTime, endTime: $endTime, limit: $limit, page: $page) {
              data {
                code
                startTime
                endTime
              }
            }
          }
        }
      `,
      {
        guildID: WCL_GUILD_ID,
        startTime: sinceUtc * 1000,
        endTime: (nowInSeconds() + 60 * 60) * 1000,
        limit: REPORT_PAGE_SIZE,
        page,
      }
    );

    const rows = payload?.reportData?.reports?.data ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      const code = (row.code ?? '').trim();
      const startMs = Number(row.startTime ?? 0);
      const endMs = Number(row.endTime ?? 0);
      if (!code || !Number.isFinite(startMs) || startMs <= 0) continue;
      byCode.set(code, {
        code,
        startUtc: Math.floor(startMs / 1000),
        endUtc: Math.floor((Number.isFinite(endMs) && endMs > startMs ? endMs : startMs) / 1000),
      });
    }

    if (rows.length < REPORT_PAGE_SIZE) break;
  }

  return [...byCode.values()].sort((a, b) => b.startUtc - a.startUtc);
}

async function fetchReportPlayerNames(
  accessToken: string,
  reportCode: string
): Promise<Array<{ name: string; server: string }>> {
  const payload = await queryWcl<{
    reportData?: {
      report?: { masterData?: { actors?: Array<{ name?: string; server?: string }> } };
    };
  }>(
    accessToken,
    `
      query GuildReportPlayers($code: String!) {
        reportData {
          report(code: $code) {
            masterData {
              actors(type: "Player") {
                name
                server
              }
            }
          }
        }
      }
    `,
    { code: reportCode }
  );

  return (payload?.reportData?.report?.masterData?.actors ?? [])
    .map((actor) => ({ name: (actor.name ?? '').trim(), server: (actor.server ?? '').trim() }))
    .filter((actor) => actor.name.length > 0);
}

/**
 * name(::realm) -> blizzard_char_id for every character on the cached roster.
 * Realm-qualified keys win; bare names are only kept when unambiguous, since a
 * duplicate name across realms can't be resolved from a log actor alone.
 */
async function loadRosterNameLookup(db: D1Database): Promise<{
  byNameAndRealm: Map<string, number>;
  byName: Map<string, number>;
}> {
  const rows = await db
    .prepare(`SELECT blizzard_char_id, name, realm_slug FROM roster_members_cache`)
    .all<{ blizzard_char_id: number; name: string; realm_slug: string }>();

  const byNameAndRealm = new Map<string, number>();
  const nameHits = new Map<string, number[]>();

  for (const row of rows.results ?? []) {
    const charId = Number(row.blizzard_char_id);
    const name = normalizeName(row.name);
    if (!Number.isInteger(charId) || charId <= 0 || !name) continue;

    byNameAndRealm.set(`${name}::${normalizeRealmSlug(row.realm_slug)}`, charId);
    nameHits.set(name, [...(nameHits.get(name) ?? []), charId]);
  }

  const byName = new Map<string, number>();
  for (const [name, charIds] of nameHits) {
    const unique = [...new Set(charIds)];
    if (unique.length === 1) byName.set(name, unique[0]);
  }

  return { byNameAndRealm, byName };
}

export interface RaidLogActivityRefreshResult {
  skipped: boolean;
  reason?: string;
  reportsInWindow: number;
  reportsProcessed: number;
  reportsRemaining: number;
  charactersTouched: number;
}

export async function refreshRaidLogActivity(
  dbInput?: D1Database,
  options: { maxReports?: number } = {}
): Promise<RaidLogActivityRefreshResult> {
  const db = getDatabase(dbInput);
  const empty = { reportsInWindow: 0, reportsProcessed: 0, reportsRemaining: 0, charactersTouched: 0 };

  const accessToken = await getWclAccessToken();
  if (!accessToken) {
    return { skipped: true, reason: 'Warcraft Logs credentials are not configured.', ...empty };
  }

  const cutoffUtc = recentLogCutoffUtc();
  const reports = await listGuildReportsSince(accessToken, cutoffUtc);
  if (reports.length === 0) {
    await pruneStaleReportRows(db, cutoffUtc);
    return { skipped: false, ...empty };
  }

  const seenRows = await db
    .prepare(`SELECT report_code FROM raid_log_reports_seen`)
    .all<{ report_code: string }>();
  const seenCodes = new Set((seenRows.results ?? []).map((row) => row.report_code));

  const pending = reports.filter((report) => !seenCodes.has(report.code));
  const maxReports = Math.max(1, options.maxReports ?? DEFAULT_MAX_REPORTS_PER_RUN);
  // Newest first: a fresh raid night matters more than backfilling an old one.
  const batch = pending.slice(0, maxReports);
  if (batch.length === 0) {
    await pruneStaleReportRows(db, cutoffUtc);
    return {
      skipped: false,
      reportsInWindow: reports.length,
      reportsProcessed: 0,
      reportsRemaining: 0,
      charactersTouched: 0,
    };
  }

  const lookup = await loadRosterNameLookup(db);
  const lastSeenByCharId = new Map<number, { seenUtc: number; reportCode: string }>();
  const statements: D1PreparedStatement[] = [];
  let processed = 0;

  for (const report of batch) {
    let actors: Array<{ name: string; server: string }>;
    try {
      actors = await fetchReportPlayerNames(accessToken, report.code);
    } catch (error) {
      console.error('[raid-log-activity] failed to load report players', { code: report.code, error });
      continue;
    }

    let matched = 0;
    for (const actor of actors) {
      const name = normalizeName(actor.name);
      const charId =
        lookup.byNameAndRealm.get(`${name}::${normalizeRealmSlug(actor.server)}`) ?? lookup.byName.get(name);
      if (!charId) continue;

      matched += 1;
      const existing = lastSeenByCharId.get(charId);
      if (!existing || report.startUtc > existing.seenUtc) {
        lastSeenByCharId.set(charId, { seenUtc: report.startUtc, reportCode: report.code });
      }
    }

    processed += 1;
    statements.push(
      db
        .prepare(
          `INSERT INTO raid_log_reports_seen (report_code, report_start_utc, report_end_utc, participant_count, processed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (report_code) DO UPDATE SET
             report_start_utc = excluded.report_start_utc,
             report_end_utc = excluded.report_end_utc,
             participant_count = excluded.participant_count,
             processed_at = excluded.processed_at`
        )
        .bind(report.code, report.startUtc, report.endUtc, matched, nowInSeconds())
    );
  }

  for (const [charId, entry] of lastSeenByCharId) {
    statements.push(
      db
        .prepare(
          `INSERT INTO raider_log_activity (blizzard_char_id, last_seen_log_utc, last_report_code, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (blizzard_char_id) DO UPDATE SET
             last_seen_log_utc = MAX(raider_log_activity.last_seen_log_utc, excluded.last_seen_log_utc),
             last_report_code = CASE
               WHEN excluded.last_seen_log_utc >= raider_log_activity.last_seen_log_utc
                 THEN excluded.last_report_code
               ELSE raider_log_activity.last_report_code
             END,
             updated_at = excluded.updated_at`
        )
        .bind(charId, entry.seenUtc, entry.reportCode, nowInSeconds())
    );
  }

  if (statements.length > 0) await db.batch(statements);
  await pruneStaleReportRows(db, cutoffUtc);

  return {
    skipped: false,
    reportsInWindow: reports.length,
    reportsProcessed: processed,
    reportsRemaining: Math.max(0, pending.length - processed),
    charactersTouched: lastSeenByCharId.size,
  };
}

/**
 * The seen-report cursor only needs to cover the active window; older rows
 * would otherwise grow forever. `raider_log_activity` is kept in full so the
 * "show all" view can still say when someone was last seen.
 */
async function pruneStaleReportRows(db: D1Database, cutoffUtc: number): Promise<void> {
  await db
    .prepare(`DELETE FROM raid_log_reports_seen WHERE report_end_utc < ?`)
    .bind(cutoffUtc - 7 * 24 * 60 * 60)
    .run();
}

export interface RaidLogActivityMap {
  /** blizzard_char_id -> last time that character appeared in a guild report. */
  lastSeenByCharId: Map<number, number>;
  /** False when nothing has ever synced, so callers can fail open. */
  hasData: boolean;
  cutoffUtc: number;
}

export async function getRaidLogActivity(dbInput?: D1Database): Promise<RaidLogActivityMap> {
  const db = getDatabase(dbInput);
  const cutoffUtc = recentLogCutoffUtc();
  const lastSeenByCharId = new Map<number, number>();

  // Degrade gracefully when migration 0067 hasn't been applied yet (same guard
  // style as raider_gear_cache / item_icon_cache).
  const hasTable = await db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='raider_log_activity' LIMIT 1")
    .first<{ '1': number }>();
  if (!hasTable) return { lastSeenByCharId, hasData: false, cutoffUtc };

  const rows = await db
    .prepare(`SELECT blizzard_char_id, last_seen_log_utc FROM raider_log_activity`)
    .all<{ blizzard_char_id: number; last_seen_log_utc: number }>();

  for (const row of rows.results ?? []) {
    lastSeenByCharId.set(Number(row.blizzard_char_id), Number(row.last_seen_log_utc));
  }

  return { lastSeenByCharId, hasData: lastSeenByCharId.size > 0, cutoffUtc };
}
