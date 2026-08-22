import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getRosterRefreshOptions, refreshRosterCache } from '../../../lib/roster-cache';
import { refreshRaidersCache } from '../../../lib/raiders';
import { refreshAttendanceCache } from '../../../lib/attendance';
import { refreshProfessionsCache } from '../../../lib/professions-cache';
import { warmTrinketTierCacheChunk } from '../../../lib/trinkets';
import { refreshRaidLogActivity } from '../../../lib/raid-log-activity';
import { FEATURE_FLAGS } from '../../../lib/feature-flags';

export const GET: APIRoute = async ({ request }) => {
  const provided = request.headers.get('X-Cron-Secret');
  if (!env.CRON_SECRET || !provided || provided !== env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const url = new URL(request.url);
  const rosterOptions = getRosterRefreshOptions({
    batchSize: url.searchParams.get('detailBatchSize') ? Number.parseInt(url.searchParams.get('detailBatchSize')!, 10) : undefined,
    questBackfillBatchSize: url.searchParams.get('backfillBatchSize') ? Number.parseInt(url.searchParams.get('backfillBatchSize')!, 10) : undefined,
  });
  const professionBatchSize = url.searchParams.get('professionBatchSize')
    ? Number.parseInt(url.searchParams.get('professionBatchSize')!, 10)
    : undefined;
  const trinketBatchSize = url.searchParams.get('trinketBatchSize')
    ? Number.parseInt(url.searchParams.get('trinketBatchSize')!, 10)
    : undefined;
  const logReportBatchSize = url.searchParams.get('logReportBatchSize')
    ? Number.parseInt(url.searchParams.get('logReportBatchSize')!, 10)
    : undefined;

  // Per-refresh timings: this endpoint runs against a 30s external timeout and
  // has little headroom, so record how long each leg takes to make the slow one
  // identifiable from a successful run's response.
  const timings: Record<string, number> = {};
  const timed = <T>(label: string, work: Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    return work.finally(() => {
      timings[label] = Date.now() - startedAt;
    });
  };

  // Opt out of the slowest leg when it is scheduled separately against
  // /api/cron/refresh-raiders, so it is not run twice.
  const skipRaiders = url.searchParams.get('skipRaiders') === '1';

  // Don't spend the cron budget refreshing caches for features that are on
  // hiatus. Flipping the flag back in feature-flags.ts restores these with no
  // other change, same as everywhere else these flags are honoured.
  const runAttendance = FEATURE_FLAGS.attendance;
  const runTools = FEATURE_FLAGS.tools;

  const startedAt = Date.now();
  const [rosterResult, raidersResult, attendanceResult, professionsResult, trinketsResult, logActivityResult] = await Promise.allSettled([
    timed('roster', refreshRosterCache(undefined, rosterOptions)),
    skipRaiders ? Promise.resolve(null) : timed('raiders', refreshRaidersCache()),
    runAttendance ? timed('attendance', refreshAttendanceCache()) : Promise.resolve(null),
    runTools ? timed('professions', refreshProfessionsCache(undefined, { batchSize: professionBatchSize })) : Promise.resolve(null),
    runTools ? timed('trinkets', warmTrinketTierCacheChunk({ batchSize: trinketBatchSize })) : Promise.resolve(null),
    // Not gated on FEATURE_FLAGS.attendance: this is the small "seen in a guild
    // log lately" sync that the raiders/gear pages filter on, not the full
    // scheduled-raid attendance pipeline.
    timed('logActivity', refreshRaidLogActivity(undefined, { maxReports: logReportBatchSize })),
  ]);
  timings.total = Date.now() - startedAt;
  console.log('Cron refresh timings (ms)', timings);

  const failures: string[] = [];
  if (rosterResult.status === 'rejected') {
    console.error('Cron roster refresh failed', rosterResult.reason);
    failures.push('roster');
  }
  if (raidersResult.status === 'rejected') {
    console.error('Cron raiders refresh failed', raidersResult.reason);
    failures.push('raiders');
  }
  if (attendanceResult.status === 'rejected') {
    console.error('Cron attendance refresh failed', attendanceResult.reason);
    failures.push('attendance');
  }
  if (professionsResult.status === 'rejected') {
    console.error('Cron professions refresh failed', professionsResult.reason);
    failures.push('professions');
  }
  if (trinketsResult.status === 'rejected') {
    console.error('Cron trinkets refresh failed', trinketsResult.reason);
    failures.push('trinkets');
  }
  if (logActivityResult.status === 'rejected') {
    console.error('Cron raid log activity refresh failed', logActivityResult.reason);
    failures.push('logActivity');
  }

  const attendanceSummary = runAttendance
    ? await env.DB
        .prepare(
          `SELECT
             COUNT(*) AS total_reports,
            SUM(CASE WHEN (total_boss_kills + COALESCE(total_boss_wipes, 0)) > 0 THEN 1 ELSE 0 END) AS reports_with_kills,
             MAX(synced_at) AS last_synced_at
           FROM raid_attendance_reports`
        )
        .first<{ total_reports: number | null; reports_with_kills: number | null; last_synced_at: number | null }>()
    : null;

  return Response.json({
    success: failures.length === 0,
    partial: failures.length > 0,
    failed: failures,
    roster: rosterResult.status === 'fulfilled' ? rosterResult.value : null,
    raiders: raidersResult.status === 'fulfilled' ? raidersResult.value : null,
    professions: professionsResult.status === 'fulfilled' ? professionsResult.value : null,
    trinkets: trinketsResult.status === 'fulfilled' ? trinketsResult.value : null,
    logActivity: logActivityResult.status === 'fulfilled' ? logActivityResult.value : null,
    attendance: {
      totalReports: Number(attendanceSummary?.total_reports ?? 0),
      reportsWithKills: Number(attendanceSummary?.reports_with_kills ?? 0),
      lastSyncedAt: attendanceSummary?.last_synced_at ?? null,
    },
    timingsMs: timings,
    skipped: {
      raiders: skipRaiders,
      attendance: !runAttendance,
      professions: !runTools,
      trinkets: !runTools,
    },
    requestedRosterOptions: rosterOptions,
    requestedProfessionBatchSize: professionBatchSize,
    requestedTrinketBatchSize: trinketBatchSize,
    requestedLogReportBatchSize: logReportBatchSize,
  });
};
