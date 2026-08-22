#!/usr/bin/env node

/**
 * Drives /api/cron/backfill-gear until every raider has cached gear.
 *
 * The regular refresh cron only revisits a raider once its 12h details TTL
 * expires, so a freshly created raider_gear_cache stays empty for up to half a
 * day. This fills it in one pass. The actual work happens inside the Worker so
 * it reuses the same gear-mapping and cache-write code as the cron — this
 * script is just a loop with progress output.
 *
 * Usage:
 *   node scripts/backfill-raider-gear.mjs --local
 *   node scripts/backfill-raider-gear.mjs --remote --base-url https://hidden-lodge.com
 *
 * The cron secret is read from CRON_SECRET, or from .dev.vars for --local.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const remote = args.includes('--remote');
const limitArg = args.find((a) => a.startsWith('--limit='));
const baseUrlArg = args.find((a) => a.startsWith('--base-url='));

const limit = limitArg ? Number.parseInt(limitArg.split('=')[1], 10) : 25;
const baseUrl = (
  baseUrlArg?.split('=')[1] ?? (remote ? 'https://hidden-lodge.com' : 'http://localhost:4321')
).replace(/\/$/, '');

function readCronSecret() {
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET;
  try {
    const devVars = readFileSync(resolve(PROJECT_ROOT, '.dev.vars'), 'utf8');
    const match = devVars.match(/^CRON_SECRET=(.*)$/m);
    return match?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
  } catch {
    return null;
  }
}

const secret = readCronSecret();
if (!secret) {
  console.error('No cron secret found. Set CRON_SECRET or add it to .dev.vars.');
  process.exit(1);
}

console.log(`Backfilling raider gear via ${baseUrl} (limit ${limit} per request)...`);

let totalProcessed = 0;
let totalFailed = 0;
let totalIcons = 0;
let pass = 0;

while (true) {
  pass += 1;

  let res;
  try {
    res = await fetch(`${baseUrl}/api/cron/backfill-gear?limit=${limit}`, {
      headers: { 'X-Cron-Secret': secret },
    });
  } catch (error) {
    console.error(`Request failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }

  const body = await res.json();
  if (!body.success) {
    console.error(`Backfill error: ${body.error ?? 'unknown'}`);
    process.exit(1);
  }

  totalProcessed += body.processed;
  totalFailed += body.failed;
  totalIcons += body.iconsWarmed ?? 0;
  console.log(
    `  pass ${pass}: +${body.processed} raiders, +${body.iconsWarmed ?? 0} icons, ` +
      `${body.failed} failed, ${body.remaining} raiders / ${body.iconsRemaining ?? 0} icons remaining`
  );

  if (body.done) break;

  // No forward progress on either front means the rest are unresolvable (bad
  // token, missing characters, items neither Blizzard nor Wowhead knows);
  // stop rather than loop forever.
  if (body.processed === 0 && (body.iconsWarmed ?? 0) === 0) {
    console.error(
      `Stopping: no progress on pass ${pass} ` +
        `(${body.remaining} raiders / ${body.iconsRemaining ?? 0} icons still unresolved).`
    );
    break;
  }
}

console.log(`Done. ${totalProcessed} raiders backfilled, ${totalIcons} icons warmed, ${totalFailed} failed.`);
