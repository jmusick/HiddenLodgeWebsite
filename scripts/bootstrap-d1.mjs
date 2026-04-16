#!/usr/bin/env node

import { listMigrationFiles, getNonSystemTables, runWranglerFile, MIGRATIONS_DIR } from './d1-migration-helpers.mjs';
import { join } from 'path';

const args = process.argv.slice(2);
const remote = args.includes('--remote');
const local = args.includes('--local');
const requireEmpty = args.includes('--require-empty');

if (remote && local) {
  console.error('Choose either --local or --remote, not both.');
  process.exit(1);
}

const useRemote = remote;
const locationLabel = useRemote ? 'remote' : 'local';

if (useRemote && !requireEmpty) {
  console.error('Remote bootstrap requires --require-empty to confirm this is an intentionally empty database.');
  process.exit(1);
}

if (requireEmpty) {
  const existingTables = getNonSystemTables({ remote: useRemote });
  if (existingTables.length > 0) {
    console.error(`Refusing to bootstrap ${locationLabel} database because it already has user tables: ${existingTables.join(', ')}`);
    process.exit(1);
  }
}

const migrationFiles = listMigrationFiles();

console.log(`Applying ${migrationFiles.length} bootstrap migrations to ${locationLabel} D1...`);
for (const migrationFile of migrationFiles) {
  console.log(`- ${migrationFile}`);
  runWranglerFile(join(MIGRATIONS_DIR, migrationFile), { remote: useRemote });
}
console.log(`Bootstrap complete for ${locationLabel} D1.`);