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
writeFileSync(workerIndexPath, "export { default } from './entry.mjs';\n", 'utf8');
