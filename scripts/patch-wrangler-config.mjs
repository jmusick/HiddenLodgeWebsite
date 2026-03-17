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

const indexContent = `\
import astroHandler from './entry.mjs';
export default astroHandler;

export const scheduled = async (event, env, ctx) => {
  const fetchFn = typeof astroHandler === 'function'
    ? astroHandler
    : astroHandler.fetch.bind(astroHandler);
  const req = new Request('https://placeholder/api/cron/refresh-roster', {
    method: 'POST',
    headers: { 'X-Cron-Secret': env.CRON_SECRET ?? '' },
  });
  await fetchFn(req, env, ctx);
};
`;
writeFileSync(workerIndexPath, indexContent, 'utf8');
