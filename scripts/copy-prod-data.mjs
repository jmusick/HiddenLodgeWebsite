#!/usr/bin/env node
/**
 * Copy data from production D1 database to local database
 * Usage: node scripts/copy-prod-data.mjs
 */

import { execSync } from 'child_process';
import { rmSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(__dirname);

const DATABASE_NAME = 'hidden-lodge-db';

// Skip tables by default
const SKIP_TABLES = ['sessions', 'sqlite_sequence', '_cf_KV', '_cf_METADATA', 'd1_migrations'];

// Tables we prefer to skip (seed data that's consistent)
const PREFER_SKIP = ['link_categories', 'links', 'roster_cache_meta', 'site_settings'];

const INCLUDE_PREFERRED_SKIP = process.env.COPY_PROD_INCLUDE_SEEDED === '1';

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function runCommand(commandLine) {
  console.log(`\n$ ${commandLine}`);
  try {
    const result = execSync(commandLine, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 128 * 1024 * 1024,
    });
    return result;
  } catch (error) {
    console.error('Command output:', error.stdout);
    console.error('Command error:', error.stderr);
    throw new Error(`Command failed: ${error.message}`);
  }
}

function runSqlFile(sql, { remote = false, json = false } = {}) {
  const filePath = join(PROJECT_ROOT, '.tmp-copy-prod-data.sql');
  const flag = remote ? '--remote' : '--local';
  const jsonFlag = json ? ' --json' : '';
  const commandLine = `npx wrangler d1 execute ${DATABASE_NAME} ${flag}${jsonFlag} --file "${filePath}"`;

  writeFileSync(filePath, `${sql.trim()}\n`, 'utf8');
  try {
    return runCommand(commandLine);
  } finally {
    rmSync(filePath, { force: true });
  }
}

function runSqlCommand(sql, { remote = false, json = false } = {}) {
  const flag = remote ? '--remote' : '--local';
  const jsonFlag = json ? ' --json' : '';
  const escapedSql = sql.replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
  const commandLine = `npx wrangler d1 execute ${DATABASE_NAME} ${flag}${jsonFlag} --command "${escapedSql}"`;
  return runCommand(commandLine);
}

function parseJsonOutput(output) {
  try {
    // wrangler outputs text before the JSON, find where JSON starts
    const jsonMatch = output.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in output');
    }
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('Failed to parse output. Full output:', output);
    throw e;
  }
}

function getAvailableTables(remote = false) {
  try {
    const output = runSqlCommand("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;", { remote, json: true });
    const parsed = parseJsonOutput(output);
    
    // Handle the fact that wrangler returns a JSON array with one element
    let resultSet = parsed.results || (Array.isArray(parsed) && parsed[0]?.results) || [];
    
    const allTables = resultSet
      .map(row => row.name)
      .filter(name => !SKIP_TABLES.includes(name))
      .filter(name => INCLUDE_PREFERRED_SKIP || !PREFER_SKIP.includes(name));
    
    return allTables;
  } catch (err) {
    console.error('Failed to get table list:', err.message);
    return [];
  }
}

function getLocalTableDependencies(tables) {
  const dependencies = new Map();

  for (const table of tables) {
    const commandLine = `npx wrangler d1 execute ${DATABASE_NAME} --local --json --command "PRAGMA foreign_key_list(${quoteIdentifier(table)})"`;

    try {
      const output = runSqlCommand(`PRAGMA foreign_key_list(${quoteIdentifier(table)});`, { json: true });
      const parsed = parseJsonOutput(output);
      const resultSet = parsed.results || (Array.isArray(parsed) && parsed[0]?.results) || [];
      const refs = resultSet
        .map((row) => row.table)
        .filter((dependency) => tables.includes(dependency));
      dependencies.set(table, [...new Set(refs)]);
    } catch (err) {
      console.error(`Failed to inspect foreign keys for ${table}:`, err.message);
      throw err;
    }
  }

  return dependencies;
}

function sortTablesByDependencies(tables, dependencyMap) {
  const sorted = [];
  const remaining = new Set(tables);
  const dependencies = new Map(
    tables.map((table) => [table, new Set(dependencyMap.get(table) ?? [])])
  );

  while (remaining.size > 0) {
    const ready = [...remaining].filter((table) => dependencies.get(table)?.size === 0).sort();

    if (ready.length === 0) {
      throw new Error(`Unable to resolve table dependency order for: ${[...remaining].join(', ')}`);
    }

    for (const table of ready) {
      sorted.push(table);
      remaining.delete(table);
      for (const deps of dependencies.values()) {
        deps.delete(table);
      }
    }
  }

  return sorted;
}

function getTableData(tables, remote = false) {
  const results = {};
  const flag = remote ? '--remote' : '--local';

  console.log(`\n========================================`);
  console.log(`Fetching data from ${remote ? 'PRODUCTION' : 'LOCAL'} database`);
  console.log(`========================================`);
  console.log(`\nFound ${tables.length} tables to copy:`, tables.join(', '));

  for (const table of tables) {
    try {
      console.log(`\nFetching ${table}...`);
      const output = runSqlCommand(`SELECT * FROM ${quoteIdentifier(table)};`, { remote, json: true });

      const parsed = parseJsonOutput(output);
      
      // Handle the fact that wrangler returns a JSON array with one element
      let resultSet = parsed.results || (Array.isArray(parsed) && parsed[0]?.results) || [];
      
      // Check if there was an error (table doesn't exist)
      if (parsed.error || (Array.isArray(parsed) && parsed[0]?.error)) {
        console.log(`⚠  ${table}: Error querying table (skipping)`);
        results[table] = [];
        continue;
      }
      
      results[table] = resultSet;
      console.log(`✓ Fetched ${results[table].length} rows from ${table}`);
    } catch (err) {
      // If it's a "table does not exist" error, skip it
      if (err.message.includes('no such table') || err.stdout?.includes('no such table')) {
        console.log(`⚠ ${table}: Table does not exist (skipping)`);
        results[table] = [];
        continue;
      }
      console.error(`✗ Error fetching ${table}:`, err.message);
      throw err;
    }
  }

  return results;
}

function generateInsertStatements(table, rows) {
  if (!rows || rows.length === 0) {
    return [];
  }

  const statements = [];
  const columns = Object.keys(rows[0]);
  const columnList = columns.map(quoteIdentifier).join(', ');

  for (const row of rows) {
    const values = columns.map((col) => {
      const val = row[col];
      if (val === null || val === undefined) {
        return 'NULL';
      }
      if (typeof val === 'string') {
        // Escape single quotes
        return `'${val.replace(/'/g, "''")}'`;
      }
      return String(val);
    });

    const valueList = values.join(', ');
    statements.push(`INSERT INTO ${quoteIdentifier(table)} (${columnList}) VALUES (${valueList});`);
  }

  return statements;
}

function clearLocalTables(tables) {
  console.log(`\n========================================`);
  console.log(`Clearing existing LOCAL data`);
  console.log(`========================================`);

  for (const table of tables) {
    console.log(`  - Clearing ${table}...`);
    runSqlFile(`DELETE FROM ${quoteIdentifier(table)};`);
  }
}

function insertData(data, tables) {
  console.log(`\n========================================`);
  console.log(`Inserting data into LOCAL database`);
  console.log(`========================================`);

  for (const table of tables) {
    const rows = data[table];

    try {
      console.log(`\nInserting into ${table}...`);

      if (!rows || rows.length === 0) {
        console.log(`  - No rows in production; local ${table} left empty`);
        continue;
      }

      // Generate and execute INSERT statements
      const statements = generateInsertStatements(table, rows);
      console.log(`  - Generated ${statements.length} insert statements`);

      // Determine batch size based on table (some tables have very large data)
      const largeDataTables = ['raider_metrics_cache'];
      const batchSize = largeDataTables.includes(table) ? 1 : 10;
      
      let insertedCount = 0;
      for (let i = 0; i < statements.length; i += batchSize) {
        const batch = statements.slice(i, i + batchSize);
        const sql = batch.join('\n');
        
        // Escape quotes properly for command line
        try {
          runSqlFile(sql);
          insertedCount += batch.length;
          if (statements.length > 20 && (i / batchSize + 1) % 5 === 0) {
            console.log(`    ... inserted ${insertedCount} of ${rows.length} rows`);
          }
        } catch (err) {
          console.error(`  Error in batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(statements.length / batchSize)}:`);
          console.error(`  Error message: ${err.message}`);
          // Log the SQL for debugging
          console.error(`  First statement: ${statements[i]}`);
          throw err;
        }
      }

      console.log(`✓ Inserted ${rows.length} rows into ${table}`);
    } catch (err) {
      console.error(`✗ Error inserting into ${table}:`, err.message);
      throw err;
    }
  }

  if (!tables.some((table) => (data[table] ?? []).length > 0)) {
    console.log(`\nℹ No data to insert - production database is empty`);
  }
}

function main() {
  try {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║  Copy Production Data to Local DB      ║');
    console.log('╚════════════════════════════════════════╝');

    const remoteTables = getAvailableTables(true);
    const localTables = getAvailableTables(false);
    const sharedTables = remoteTables.filter((table) => localTables.includes(table));

    if (sharedTables.length === 0) {
      throw new Error('No shared tables found between production and local databases');
    }

    const dependencyMap = getLocalTableDependencies(sharedTables);
    const insertOrder = sortTablesByDependencies(sharedTables, dependencyMap);
    const deleteOrder = [...insertOrder].reverse();

    console.log(`\nShared tables (${sharedTables.length}): ${insertOrder.join(', ')}`);
    if (!INCLUDE_PREFERRED_SKIP) {
      console.log('Seeded tables are excluded by default. Set COPY_PROD_INCLUDE_SEEDED=1 to include them.');
    }

    // Fetch production data
    const prodData = getTableData(insertOrder, true);

    // Reset local shared tables before re-inserting
    clearLocalTables(deleteOrder);

    // Insert into local
    insertData(prodData, insertOrder);

    console.log(`\n╔════════════════════════════════════════╗`);
    console.log(`║  ✓ Data sync complete!                ║`);
    console.log(`╚════════════════════════════════════════╝`);
    console.log('\nYou can now run: npm run dev');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  }
}

main();
