import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getRosterRefreshOptions, refreshRosterCache } from '../../../lib/roster-cache';
import { refreshRaidersCache } from '../../../lib/raiders';
import { refreshAttendanceCache } from '../../../lib/attendance';

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

  const [rosterResult, raidersResult, attendanceResult] = await Promise.allSettled([
    refreshRosterCache(undefined, rosterOptions),
    refreshRaidersCache(),
    refreshAttendanceCache(),
  ]);

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

  const attendanceSummary = await env.DB
    .prepare(
      `SELECT
         COUNT(*) AS total_reports,
        SUM(CASE WHEN (total_boss_kills + COALESCE(total_boss_wipes, 0)) > 0 THEN 1 ELSE 0 END) AS reports_with_kills,
         MAX(synced_at) AS last_synced_at
       FROM raid_attendance_reports`
    )
    .first<{ total_reports: number | null; reports_with_kills: number | null; last_synced_at: number | null }>();

  return Response.json({
    success: failures.length === 0,
    partial: failures.length > 0,
    failed: failures,
    roster: rosterResult.status === 'fulfilled' ? rosterResult.value : null,
    raiders: raidersResult.status === 'fulfilled' ? raidersResult.value : null,
    attendance: {
      totalReports: Number(attendanceSummary?.total_reports ?? 0),
      reportsWithKills: Number(attendanceSummary?.reports_with_kills ?? 0),
      lastSyncedAt: attendanceSummary?.last_synced_at ?? null,
    },
    requestedRosterOptions: rosterOptions,
  });
};
