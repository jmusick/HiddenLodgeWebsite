#!/usr/bin/env node

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const PROJECT_ROOT = dirname(__dirname);
export const MIGRATIONS_DIR = join(PROJECT_ROOT, 'migrations');
export const DATABASE_NAME = 'hidden-lodge-db';
export const BACKUP_DIR = join(PROJECT_ROOT, '.migration-backups');
export const LEGACY_DESTRUCTIVE_ALLOWLIST = new Set([
  '0004_nickname.sql',
  '0007_split_dps_roles.sql',
  '0025_drop_legacy_sim_tables.sql',
  '0035_raider_notes_by_user.sql',
  '0036_raider_notes_by_char.sql',
  '0039_signup_notes_and_statuses.sql',
  '0052_loot_history_fk_repair.sql',
  '0053_loot_history_season1_cutoff.sql',
  '0054_loot_history_canonical_dedupe.sql',
  '0058_loot_history_content_dedupe.sql',
  '0061_preserve_raider_notes.sql',
]);
export const PROTECTED_TABLES = [
  'users',
  'characters',
  'raider_notes',
  'raid_signups',
  'loot_history',
  'applications',
  'application_notes',
];

const SYSTEM_TABLES = new Set(['sqlite_sequence', '_cf_KV', '_cf_METADATA', 'd1_migrations']);
const DESTRUCTIVE_PATTERNS = [
  { kind: 'DROP TABLE', regex: /\bDROP\s+TABLE\b/gi },
  { kind: 'DROP VIEW', regex: /\bDROP\s+VIEW\b/gi },
  { kind: 'DROP INDEX', regex: /\bDROP\s+INDEX\b/gi },
  { kind: 'DELETE FROM', regex: /\bDELETE\s+FROM\b/gi },
  { kind: 'TRUNCATE', regex: /\bTRUNCATE\b/gi },
  { kind: 'ALTER TABLE DROP COLUMN', regex: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+COLUMN\b/gi },
];

export function runCommand(commandLine, options = {}) {
  return execSync(commandLine, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
}

export function parseJsonOutput(output) {
  const jsonMatch = String(output).match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON payload found in output:\n${output}`);
  }
  return JSON.parse(jsonMatch[0]);
}

export function runWranglerCommand(sql, { remote = false, json = false } = {}) {
  const locationFlag = remote ? '--remote --yes' : '--local';
  const jsonFlag = json ? ' --json' : '';
  const escapedSql = sql.replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
  return runCommand(
    `npx wrangler d1 execute ${DATABASE_NAME} ${locationFlag}${jsonFlag} --command "${escapedSql}"`
  );
}

export function runWranglerFile(filePath, { remote = false } = {}) {
  const locationFlag = remote ? '--remote --yes' : '--local';
  return runCommand(
    `npx wrangler d1 execute ${DATABASE_NAME} ${locationFlag} --file "${filePath}"`
  );
}

export function listMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((entry) => entry.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));
}

export function resolveMigrationPath(inputPath) {
  const absolutePath = resolve(PROJECT_ROOT, inputPath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Migration file not found: ${inputPath}`);
  }
  return absolutePath;
}

export function readMigrationSql(filePath) {
  return readFileSync(filePath, 'utf8');
}

export function hasAllowDestructiveAnnotation(sql) {
  return /--\s*allow-destructive\b/i.test(sql);
}

export function findDestructiveStatements(sql) {
  const matches = [];
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    for (const match of sql.matchAll(pattern.regex)) {
      const prefix = sql.slice(0, match.index ?? 0);
      const line = prefix.split(/\r?\n/).length;
      matches.push({ kind: pattern.kind, line });
    }
  }
  return matches.sort((left, right) => left.line - right.line || left.kind.localeCompare(right.kind));
}

export function findReferencedProtectedTables(sql) {
  return PROTECTED_TABLES.filter((tableName) => {
    const regex = new RegExp(`(^|[^A-Za-z0-9_])${tableName}([^A-Za-z0-9_]|$)`, 'i');
    return regex.test(sql);
  });
}

export function getNonSystemTables({ remote = false } = {}) {
  const output = runWranglerCommand(
    `SELECT name
     FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
     ORDER BY name;`,
    { remote, json: true }
  );
  const parsed = parseJsonOutput(output);
  const rows = parsed.results || (Array.isArray(parsed) && parsed[0]?.results) || [];
  return rows
    .map((row) => String(row.name))
    .filter((name) => !SYSTEM_TABLES.has(name));
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function escapeSqlString(value) {
  return String(value).replace(/'/g, "''");
}

function renameCreateTableSql(sql, newTableName) {
  const match = sql.match(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"([^"]+)"|([^\s(]+))/i);
  if (!match) {
    return null;
  }

  const originalName = match[1] ?? match[2];
  const quotedOriginal = `"${originalName}"`;
  if (sql.includes(quotedOriginal)) {
    return sql.replace(quotedOriginal, quoteIdentifier(newTableName));
  }
  return sql.replace(originalName, quoteIdentifier(newTableName));
}

function generateInsertStatements(tableName, rows) {
  if (!rows.length) {
    return [];
  }

  const columns = Object.keys(rows[0]);
  const columnList = columns.map(quoteIdentifier).join(', ');
  return rows.map((row) => {
    const values = columns.map((column) => {
      const value = row[column];
      if (value === null || value === undefined) {
        return 'NULL';
      }
      if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : 'NULL';
      }
      if (typeof value === 'boolean') {
        return value ? '1' : '0';
      }
      return `'${escapeSqlString(value)}'`;
    });

    return `INSERT INTO ${quoteIdentifier(tableName)} (${columnList}) VALUES (${values.join(', ')});`;
  });
}

export function writeProtectedTableBackups({ remote = false, migrationFileName, tables }) {
  if (!tables.length) {
    return [];
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFiles = [];

  for (const tableName of tables) {
    const schemaOutput = runWranglerCommand(
      `SELECT sql
       FROM sqlite_master
       WHERE type = 'table'
         AND name = '${escapeSqlString(tableName)}'
       LIMIT 1;`,
      { remote, json: true }
    );
    const schemaParsed = parseJsonOutput(schemaOutput);
    const schemaRows = schemaParsed.results || (Array.isArray(schemaParsed) && schemaParsed[0]?.results) || [];
    const createSql = schemaRows[0]?.sql ? String(schemaRows[0].sql) : null;

    const rowsOutput = runWranglerCommand(`SELECT * FROM ${quoteIdentifier(tableName)};`, { remote, json: true });
    const rowsParsed = parseJsonOutput(rowsOutput);
    const rows = rowsParsed.results || (Array.isArray(rowsParsed) && rowsParsed[0]?.results) || [];

    const backupTableName = `${tableName}__backup__${stamp.replace(/[^0-9A-Za-z_]/g, '_')}`;
    const backupPath = join(BACKUP_DIR, `${stamp}-${migrationFileName}-${tableName}.sql`);
    const backupSql = [];

    backupSql.push(`-- Backup for ${tableName}`);
    backupSql.push(`-- Generated before applying ${migrationFileName} to ${remote ? 'remote' : 'local'} D1`);
    backupSql.push(`-- Restore by executing this file manually against a safe recovery database.`);
    backupSql.push('');

    const renamedCreateSql = createSql ? renameCreateTableSql(createSql, backupTableName) : null;
    if (renamedCreateSql) {
      backupSql.push(`${renamedCreateSql};`);
    } else {
      backupSql.push(`CREATE TABLE ${quoteIdentifier(backupTableName)} AS SELECT * FROM ${quoteIdentifier(tableName)} WHERE 0;`);
    }

    const insertStatements = generateInsertStatements(backupTableName, rows);
    if (insertStatements.length > 0) {
      backupSql.push('');
      backupSql.push(...insertStatements);
    }

    writeFileSync(backupPath, `${backupSql.join('\n')}\n`, 'utf8');
    backupFiles.push(backupPath);
  }

  return backupFiles;
}

export function describeMigration(relativePath, sql) {
  const destructive = findDestructiveStatements(sql);
  const protectedTables = findReferencedProtectedTables(sql);
  return {
    relativePath,
    fileName: basename(relativePath),
    destructive,
    protectedTables,
    allowDestructive: hasAllowDestructiveAnnotation(sql),
    legacyAllowed: LEGACY_DESTRUCTIVE_ALLOWLIST.has(basename(relativePath)),
  };
}