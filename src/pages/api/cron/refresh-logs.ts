import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { refreshRaidLogActivity } from '../../../lib/raid-log-activity';
import { refreshDeathAnalysis } from '../../../lib/death-analysis';
import { FEATURE_FLAGS } from '../../../lib/feature-flags';

export const prerender = false;

/**
 * Warcraft Logs refresh: raid-log activity + death analysis.
 *
 * Both legs depend on WCL, whose latency is the least predictable of any
 * upstream, and death analysis pages through whole reports after a raid night.
 * Running them here keeps a slow WCL from pushing /api/cron/refresh past the
 * scheduler's 30s timeout. Logs only change on raid nights, so this can be
 * scheduled less often than the main refresh.
 *
 * Pair this with /api/cron/refresh?skipLogs=1 so the work is not done twice.
 */
export const GET: APIRoute = async ({ request }) => {
  const provided = request.headers.get('X-Cron-Secret');
  if (!env.CRON_SECRET || !provided || provided !== env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const url = new URL(request.url);
  const logReportBatchSize = url.searchParams.get('logReportBatchSize')
    ? Number.parseInt(url.searchParams.get('logReportBatchSize')!, 10)
    : undefined;
  const deathReportBatchSize = url.searchParams.get('deathReportBatchSize')
    ? Number.parseInt(url.searchParams.get('deathReportBatchSize')!, 10)
    : undefined;
  const runDeathAnalysis = FEATURE_FLAGS.deathAnalysis;

  const timings: Record<string, number> = {};
  const timed = <T>(label: string, work: Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    return work.finally(() => {
      timings[label] = Date.now() - startedAt;
    });
  };

  const startedAt = Date.now();
  const [logActivityResult, deathAnalysisResult] = await Promise.allSettled([
    timed('logActivity', refreshRaidLogActivity(undefined, { maxReports: logReportBatchSize })),
    runDeathAnalysis
      ? timed('deathAnalysis', refreshDeathAnalysis(undefined, { maxReports: deathReportBatchSize }))
      : Promise.resolve(null),
  ]);
  timings.total = Date.now() - startedAt;
  console.log('Cron logs refresh timings (ms)', timings);

  const failures: string[] = [];
  if (logActivityResult.status === 'rejected') {
    console.error('Cron raid log activity refresh failed', logActivityResult.reason);
    failures.push('logActivity');
  }
  if (deathAnalysisResult.status === 'rejected') {
    console.error('Cron death analysis refresh failed', deathAnalysisResult.reason);
    failures.push('deathAnalysis');
  }

  return Response.json({
    success: failures.length === 0,
    partial: failures.length > 0,
    failed: failures,
    logActivity: logActivityResult.status === 'fulfilled' ? logActivityResult.value : null,
    deathAnalysis: deathAnalysisResult.status === 'fulfilled' ? deathAnalysisResult.value : null,
    timingsMs: timings,
    skipped: { deathAnalysis: !runDeathAnalysis },
    requestedLogReportBatchSize: logReportBatchSize,
    requestedDeathReportBatchSize: deathReportBatchSize,
  });
};
