#!/usr/bin/env node

import { execSync } from 'child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(__dirname);
const DATABASE_NAME = 'hidden-lodge-db';
const targetArg = process.argv.find((arg) => arg.startsWith('--target='));
const target = (targetArg?.split('=')[1] ?? 'local').trim();

if (!['local', 'remote'].includes(target)) {
  console.error(`Unsupported target: ${target}`);
  process.exit(1);
}

function runCommand(commandLine) {
  return execSync(commandLine, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function createScratchProject(rootDir) {
  const scratchProject = join(rootDir, 'project');
  const scratchMigrationsDir = join(scratchProject, 'migrations');
  const sourceMigrationsDir = join(PROJECT_ROOT, 'migrations');

  mkdirSync(scratchMigrationsDir, { recursive: true });
  copyFileSync(join(PROJECT_ROOT, 'wrangler.toml'), join(scratchProject, 'wrangler.toml'));

  for (const entry of readdirSync(sourceMigrationsDir)) {
    if (!entry.endsWith('.sql')) {
      continue;
    }
    if (entry.startsWith('seed_')) {
      continue;
    }
    copyFileSync(join(sourceMigrationsDir, entry), join(scratchMigrationsDir, entry));
  }

  return scratchProject;
}

function parseJsonOutput(output) {
  const jsonMatch = output.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON payload found in output:\n${output}`);
  }
  return JSON.parse(jsonMatch[0]);
}

function executeSql(sql, { remote = false, persistTo, cwd = PROJECT_ROOT } = {}) {
  const locationFlag = remote ? '--remote' : '--local';
  const persistFlag = persistTo ? ` --persist-to "${persistTo}"` : '';
  const escapedSql = sql.replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
  return execSync(
    `npx wrangler d1 execute ${DATABASE_NAME} ${locationFlag}${persistFlag} --json --command "${escapedSql}"`
    , {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    }
  );
}

function applyScratchMigrations({ persistTo, cwd }) {
  execSync(
    `npx wrangler d1 migrations apply ${DATABASE_NAME} --local --persist-to "${persistTo}"`
    , {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    }
  );
}

function normalizeSql(sql) {
  return String(sql ?? '')
    .replace(/\s+/g, ' ')
    .replace(/"/g, '')
    .trim()
    .toLowerCase();
}

function loadSchema({ remote = false, persistTo, cwd = PROJECT_ROOT } = {}) {
  const output = executeSql(
    `SELECT type, name, tbl_name, sql
     FROM sqlite_master
     WHERE sql IS NOT NULL
       AND name NOT LIKE 'sqlite_%'
       AND name != 'd1_migrations'
     ORDER BY type, name;`,
    { remote, persistTo, cwd }
  );
  const parsed = parseJsonOutput(output);
  const rows = parsed.results || (Array.isArray(parsed) && parsed[0]?.results) || [];
  return new Map(
    rows.map((row) => [`${row.type}:${row.name}`, { ...row, normalizedSql: normalizeSql(row.sql) }])
  );
}

function diffSchemas(expected, actual) {
  const missing = [];
  const extra = [];
  const changed = [];

  for (const [key, expectedEntry] of expected.entries()) {
    const actualEntry = actual.get(key);
    if (!actualEntry) {
      missing.push(key);
      continue;
    }
    if (expectedEntry.normalizedSql !== actualEntry.normalizedSql) {
      changed.push({ key, expectedSql: expectedEntry.sql, actualSql: actualEntry.sql });
    }
  }

  for (const key of actual.keys()) {
    if (!expected.has(key)) {
      extra.push(key);
    }
  }

  return { missing, extra, changed };
}

function printDiff(diff, label) {
  console.log(`\nSchema comparison against ${label}:`);
  console.log(`  Missing objects: ${diff.missing.length}`);
  console.log(`  Extra objects:   ${diff.extra.length}`);
  console.log(`  Changed objects: ${diff.changed.length}`);

  if (diff.missing.length > 0) {
    console.log('\nMissing:');
    for (const item of diff.missing) {
      console.log(`  - ${item}`);
    }
  }

  if (diff.extra.length > 0) {
    console.log('\nExtra:');
    for (const item of diff.extra) {
      console.log(`  - ${item}`);
    }
  }

  if (diff.changed.length > 0) {
    console.log('\nChanged:');
    for (const item of diff.changed) {
      console.log(`  - ${item.key}`);
    }
  }
}

function main() {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'hiddenlodge-d1-schema-'));

  try {
    const scratchProject = createScratchProject(scratchRoot);
    applyScratchMigrations({ persistTo: scratchRoot, cwd: scratchProject });
    const expectedSchema = loadSchema({ persistTo: scratchRoot, cwd: scratchProject });
    const actualSchema = loadSchema({ remote: target === 'remote' });
    const diff = diffSchemas(expectedSchema, actualSchema);

    printDiff(diff, target === 'remote' ? 'remote D1' : 'local D1');

    if (diff.missing.length || diff.extra.length || diff.changed.length) {
      process.exitCode = 1;
      return;
    }

    console.log('\nSchema matches repo migrations.');
  } catch (error) {
    console.error(`\nSchema comparison failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

main();