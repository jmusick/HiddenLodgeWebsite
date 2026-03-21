const DEFAULT_URL = 'http://localhost:4321/api/cron/refresh-roster';
const DEFAULT_INTERVAL_SECONDS = 300;
const DEFAULT_STARTUP_WAIT_SECONDS = 30;

async function readDevVarsSecret() {
  try {
    const file = await import('node:fs/promises');
    const content = await file.readFile('.dev.vars', 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      if (key !== 'CRON_SECRET') continue;
      const value = line.slice(eq + 1).trim();
      if (!value) continue;
      const unquoted = value.replace(/^['\"]|['\"]$/g, '');
      if (unquoted) return unquoted;
    }
  } catch {
    // No local .dev.vars file available; rely on process env values.
  }

  return null;
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function waitForUrl(url, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Cron-Secret': cronSecret,
        },
      });

      if (response.ok || response.status === 401 || response.status === 500) {
        return true;
      }
    } catch {
      // Server is likely not listening yet; keep polling until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return false;
}

const cronUrl = process.env.LOCAL_CRON_URL ?? DEFAULT_URL;
const fallbackDevVarsSecret = await readDevVarsSecret();
const cronSecret = process.env.LOCAL_CRON_SECRET ?? process.env.CRON_SECRET ?? fallbackDevVarsSecret;
const intervalSeconds = parsePositiveInteger(process.env.LOCAL_CRON_INTERVAL_SECONDS, DEFAULT_INTERVAL_SECONDS);
const runOnStart = parseBoolean(process.env.LOCAL_CRON_RUN_ON_START, true);
const startupWaitSeconds = parsePositiveInteger(process.env.LOCAL_CRON_STARTUP_WAIT_SECONDS, DEFAULT_STARTUP_WAIT_SECONDS);

if (!cronSecret) {
  console.error('Missing LOCAL_CRON_SECRET (or CRON_SECRET).');
  console.error('Set it to the same CRON_SECRET value used by your local Astro/Cloudflare env.');
  process.exit(1);
}

let isRunning = false;

async function triggerRefresh() {
  if (isRunning) {
    console.log(`[${new Date().toISOString()}] Previous refresh still running; skipping overlap.`);
    return;
  }

  isRunning = true;
  const startedAt = Date.now();

  try {
    const response = await fetch(cronUrl, {
      method: 'GET',
      headers: {
        'X-Cron-Secret': cronSecret,
      },
    });

    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) {
      const body = await response.text();
      console.error(`[${new Date().toISOString()}] Refresh failed (${response.status}) in ${elapsedMs}ms: ${body}`);
      return;
    }

    const payload = await response.json().catch(() => null);
    console.log(
      `[${new Date().toISOString()}] Refresh succeeded (${response.status}) in ${elapsedMs}ms`,
      payload ? JSON.stringify(payload) : ''
    );
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    console.error(`[${new Date().toISOString()}] Refresh error in ${elapsedMs}ms:`, error);
  } finally {
    isRunning = false;
  }
}

console.log('Local cron refresher started.');
console.log(`- URL: ${cronUrl}`);
console.log(`- Interval: ${intervalSeconds}s`);
console.log(`- Run immediately: ${runOnStart ? 'yes' : 'no'}`);

if (runOnStart) {
  const ready = await waitForUrl(cronUrl, startupWaitSeconds);
  if (!ready) {
    console.warn(`[${new Date().toISOString()}] Local server was not ready within ${startupWaitSeconds}s; waiting for scheduled retries.`);
  } else {
    await triggerRefresh();
  }
}

const timer = setInterval(() => {
  void triggerRefresh();
}, intervalSeconds * 1000);

function shutdown(signal) {
  clearInterval(timer);
  console.log(`\nReceived ${signal}; local cron refresher stopped.`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
