import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const deployConfigPath = resolve('.wrangler/deploy/config.json');

const workerEntryDir = resolve('dist/_worker.js');
const workerIndexPath = resolve(workerEntryDir, 'index.js');

if (existsSync(deployConfigPath)) {
  rmSync(deployConfigPath, { force: true });
}

const generatedWorkerConfigPath = resolve(workerEntryDir, 'wrangler.json');
if (existsSync(generatedWorkerConfigPath)) {
  rmSync(generatedWorkerConfigPath, { force: true });
}

mkdirSync(workerEntryDir, { recursive: true });

// No scheduled() export: this deploys as a Cloudflare Pages project, which has no
// cron triggers, so one would never fire. The /api/cron/* endpoints are driven
// by an external scheduler (cron-job.org) instead.
const indexContent = `\
import astroHandler from './entry.mjs';
export default astroHandler;
`;
writeFileSync(workerIndexPath, indexContent, 'utf8');
