#!/usr/bin/env node

import { basename, relative } from 'path';
import {
  PROJECT_ROOT,
  describeMigration,
  readMigrationSql,
  resolveMigrationPath,
  runWranglerFile,
  writeProtectedTableBackups,
} from './d1-migration-helpers.mjs';

const args = process.argv.slice(2);
const remote = args.includes('--remote');
const local = args.includes('--local');
const forceDestructive = args.includes('--force-destructive');
const skipBackup = args.includes('--skip-backup');
const migrationArg = args.find((arg) => !arg.startsWith('--'));

if (remote && local) {
  console.error('Choose either --local or --remote, not both.');
  process.exit(1);
}

if (!migrationArg) {
  console.error('Usage: npm run db:migrate:local -- migrations/0061_preserve_raider_notes.sql');
  console.error('Usage: npm run db:migrate:prod -- migrations/0061_preserve_raider_notes.sql');
  process.exit(1);
}

const migrationPath = resolveMigrationPath(migrationArg);
const relativePath = relative(PROJECT_ROOT, migrationPath).replace(/\\/g, '/');
const sql = readMigrationSql(migrationPath);
const details = describeMigration(relativePath, sql);
const useRemote = remote;

if (details.destructive.length > 0 && !details.allowDestructive && !details.legacyAllowed && !forceDestructive) {
  console.error(`Refusing to apply destructive migration ${relativePath}.`);
  for (const entry of details.destructive) {
    console.error(`- ${entry.kind} at line ${entry.line}`);
  }
  console.error('Add an explicit `-- allow-destructive` annotation to the file or rerun with --force-destructive after review.');
  process.exit(1);
}

if (useRemote && details.protectedTables.length > 0 && !skipBackup) {
  const backupFiles = writeProtectedTableBackups({
    remote: true,
    migrationFileName: basename(relativePath),
    tables: details.protectedTables,
  });
  console.log(`Created ${backupFiles.length} protected-table backup file(s):`);
  for (const backupFile of backupFiles) {
    console.log(`- ${relative(PROJECT_ROOT, backupFile).replace(/\\/g, '/')}`);
  }
}

console.log(`Applying ${relativePath} to ${useRemote ? 'remote' : 'local'} D1...`);
runWranglerFile(migrationPath, { remote: useRemote });
console.log(`Applied ${relativePath}.`);