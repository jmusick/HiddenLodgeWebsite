#!/usr/bin/env node

import { relative } from 'path';
import {
  PROJECT_ROOT,
  describeMigration,
  listMigrationFiles,
  readMigrationSql,
  resolveMigrationPath,
} from './d1-migration-helpers.mjs';

const args = process.argv.slice(2);
const migrationPaths = args.length > 0
  ? args.map((entry) => resolveMigrationPath(entry))
  : listMigrationFiles().map((entry) => resolveMigrationPath(`migrations/${entry}`));

if (migrationPaths.length === 0) {
  console.log('No migration files to check.');
  process.exit(0);
}

const failures = [];

for (const migrationPath of migrationPaths) {
  const relativePath = relative(PROJECT_ROOT, migrationPath).replace(/\\/g, '/');
  const details = describeMigration(relativePath, readMigrationSql(migrationPath));

  if (details.destructive.length > 0 && !details.allowDestructive && !details.legacyAllowed) {
    failures.push(details);
    continue;
  }

  const protectedLabel = details.protectedTables.length > 0
    ? ` protected tables: ${details.protectedTables.join(', ')}`
    : '';
  const destructiveLabel = details.destructive.length > 0
    ? ` destructive statements: ${details.destructive.map((entry) => `${entry.kind}@L${entry.line}`).join(', ')}`
    : ' no destructive statements';
  console.log(`OK ${relativePath}:${protectedLabel}${destructiveLabel}`);
}

if (failures.length > 0) {
  console.error('Migration safety check failed.');
  for (const failure of failures) {
    console.error(`- ${failure.relativePath}`);
    for (const entry of failure.destructive) {
      console.error(`  - ${entry.kind} at line ${entry.line}`);
    }
    if (failure.protectedTables.length > 0) {
      console.error(`  - protected tables touched: ${failure.protectedTables.join(', ')}`);
    }
    console.error('  - add `-- allow-destructive` to the file after review if this is intentional');
  }
  process.exit(1);
}

console.log('Migration safety check passed.');