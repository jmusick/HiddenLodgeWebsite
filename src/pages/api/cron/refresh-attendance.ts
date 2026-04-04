import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { importAttendanceFromReportCode, refreshAttendanceCache } from '../../../lib/attendance';

export const GET: APIRoute = async ({ request }) => {
  const provided = request.headers.get('X-Cron-Secret');
  if (!env.CRON_SECRET || !provided || provided !== env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const reportCode = (url.searchParams.get('reportCode') ?? '').trim();
    const raidKindRaw = (url.searchParams.get('raidKind') ?? '').trim().toLowerCase();
    const raidKind = raidKindRaw === 'primary' || raidKindRaw === 'adhoc' ? raidKindRaw : null;
    const primaryScheduleIdRaw = Number.parseInt(url.searchParams.get('primaryScheduleId') ?? '', 10);
    const adHocRaidIdRaw = Number.parseInt(url.searchParams.get('adHocRaidId') ?? '', 10);
    const occurrenceStartUtcRaw = Number.parseInt(url.searchParams.get('occurrenceStartUtc') ?? '', 10);

    if (reportCode && raidKind && Number.isInteger(occurrenceStartUtcRaw) && occurrenceStartUtcRaw > 0) {
      const primaryScheduleId = Number.isInteger(primaryScheduleIdRaw) && primaryScheduleIdRaw > 0 ? primaryScheduleIdRaw : null;
      const adHocRaidId = Number.isInteger(adHocRaidIdRaw) && adHocRaidIdRaw > 0 ? adHocRaidIdRaw : null;

      if ((raidKind === 'primary' && !primaryScheduleId) || (raidKind === 'adhoc' && !adHocRaidId)) {
        return Response.json({ success: false, error: 'Missing raid schedule ID for provided raid kind.' }, { status: 400 });
      }

      const imported = await importAttendanceFromReportCode(
        env.DB,
        {
          raidKind,
          primaryScheduleId,
          adHocRaidId,
          occurrenceStartUtc: occurrenceStartUtcRaw,
        },
        reportCode
      );

      return Response.json({
        success: true,
        imported,
        mode: 'single-report',
      });
    }

    await refreshAttendanceCache(env.DB);

    const reportCounts = await env.DB
      .prepare(
        `SELECT
           COUNT(*) AS total_reports,
            SUM(CASE WHEN (total_boss_kills + COALESCE(total_boss_wipes, 0)) > 0 THEN 1 ELSE 0 END) AS reports_with_kills,
           MAX(synced_at) AS last_synced_at
         FROM raid_attendance_reports`
      )
      .first<{ total_reports: number | null; reports_with_kills: number | null; last_synced_at: number | null }>();

    return Response.json({
      success: true,
      totalReports: Number(reportCounts?.total_reports ?? 0),
      reportsWithKills: Number(reportCounts?.reports_with_kills ?? 0),
      lastSyncedAt: reportCounts?.last_synced_at ?? null,
    });
  } catch (error) {
    console.error('Cron attendance refresh failed', error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Attendance refresh failed',
      },
      { status: 500 }
    );
  }
};
