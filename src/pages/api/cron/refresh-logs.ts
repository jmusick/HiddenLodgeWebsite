import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { refreshRaidLogActivity } from '../../../lib/raid-log-activity';
import { refreshDeathAnalysis } from '../../../lib/death-analysis';
import { refreshMechanicsAnalysis } from '../../../lib/mechanics-analysis';
import { refreshBenchParses } from '../../../lib/bench';
import { FEATURE_FLAGS } from '../../../lib/feature-flags';

export const prerender = false;

/**
 * Mechanics analysis only starts if death analysis finished within this long,
 * so its own 6s budget plus one in-flight report still fits under the 30s cron cap.
 */
const MECHANICS_START_CUTOFF_MS = 16_000;

/**
 * Bench parses run after log activity (the lighter leg) and only start if it
 * finished within this long. Their own budget stops starting new WCL batches
 * after BENCH_PARSES_BUDGET_MS; a full refresh is one request per 10 raiders,
 * so this normally finishes in a few seconds and the rest carries over.
 */
const BENCH_PARSES_START_CUTOFF_MS = 8_000;
const BENCH_PARSES_BUDGET_MS = 4_000;

/**
 * Warcraft Logs refresh: raid-log activity (then bench parses) + death analysis
 * (then mechanics analysis). Bench parses only call WCL when a cached parse is
 * older than BENCH_PARSE_STALE_SECONDS.
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
  const mechanicsReportBatchSize = url.searchParams.get('mechanicsReportBatchSize')
    ? Number.parseInt(url.searchParams.get('mechanicsReportBatchSize')!, 10)
    : undefined;
  const runDeathAnalysis = FEATURE_FLAGS.deathAnalysis;
  const runMechanicsAnalysis = FEATURE_FLAGS.deathAnalysis && FEATURE_FLAGS.mechanicsAnalysis;
  const runBenchParses = FEATURE_FLAGS.deathAnalysis;

  const timings: Record<string, number> = {};
  const timed = <T>(label: string, work: Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    return work.finally(() => {
      timings[label] = Date.now() - startedAt;
    });
  };

  const startedAt = Date.now();
  // Mechanics runs after death analysis in the same leg: it reads the reports
  // death analysis just synced, and chaining keeps WCL load to one stream here.
  const deathThenMechanics = async () => {
    const [death] = await Promise.allSettled([
      runDeathAnalysis
        ? timed('deathAnalysis', refreshDeathAnalysis(undefined, { maxReports: deathReportBatchSize }))
        : Promise.resolve(null),
    ]);
    const mechanicsSkipped = !runMechanicsAnalysis || Date.now() - startedAt > MECHANICS_START_CUTOFF_MS;
    const [mechanics] = await Promise.allSettled([
      mechanicsSkipped
        ? Promise.resolve(null)
        : timed('mechanicsAnalysis', refreshMechanicsAnalysis(undefined, { maxReports: mechanicsReportBatchSize })),
    ]);
    return { death, mechanics, mechanicsSkipped };
  };
  const logActivityThenBench = async () => {
    const [logActivity] = await Promise.allSettled([
      timed('logActivity', refreshRaidLogActivity(undefined, { maxReports: logReportBatchSize })),
    ]);
    const benchSkipped = !runBenchParses || Date.now() - startedAt > BENCH_PARSES_START_CUTOFF_MS;
    const [bench] = await Promise.allSettled([
      benchSkipped
        ? Promise.resolve(null)
        : timed('benchParses', refreshBenchParses(undefined, { budgetMs: BENCH_PARSES_BUDGET_MS })),
    ]);
    return { logActivity, bench, benchSkipped };
  };
  const [
    { logActivity: logActivityResult, bench: benchParsesResult, benchSkipped },
    { death: deathAnalysisResult, mechanics: mechanicsAnalysisResult, mechanicsSkipped },
  ] = await Promise.all([logActivityThenBench(), deathThenMechanics()]);
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
  if (mechanicsAnalysisResult.status === 'rejected') {
    console.error('Cron mechanics analysis refresh failed', mechanicsAnalysisResult.reason);
    failures.push('mechanicsAnalysis');
  }
  if (benchParsesResult.status === 'rejected') {
    console.error('Cron bench parses refresh failed', benchParsesResult.reason);
    failures.push('benchParses');
  }

  return Response.json({
    success: failures.length === 0,
    partial: failures.length > 0,
    failed: failures,
    logActivity: logActivityResult.status === 'fulfilled' ? logActivityResult.value : null,
    deathAnalysis: deathAnalysisResult.status === 'fulfilled' ? deathAnalysisResult.value : null,
    mechanicsAnalysis: mechanicsAnalysisResult.status === 'fulfilled' ? mechanicsAnalysisResult.value : null,
    benchParses: benchParsesResult.status === 'fulfilled' ? benchParsesResult.value : null,
    timingsMs: timings,
    skipped: { deathAnalysis: !runDeathAnalysis, mechanicsAnalysis: mechanicsSkipped, benchParses: benchSkipped },
    requestedLogReportBatchSize: logReportBatchSize,
    requestedDeathReportBatchSize: deathReportBatchSize,
    requestedMechanicsReportBatchSize: mechanicsReportBatchSize,
  });
};
