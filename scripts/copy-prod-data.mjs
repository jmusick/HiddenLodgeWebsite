#!/usr/bin/env node
/**
 * Copy data from production D1 database to local database
 * Usage: node scripts/copy-prod-data.mjs
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(__dirname);

const DATABASE_NAME = 'hidden-lodge-db';

// Skip tables by default
const SKIP_TABLES = ['sessions', 'sqlite_sequence', '_cf_KV'];

// Tables we prefer to skip (seed data that's consistent)
const PREFER_SKIP = ['link_categories', 'links', 'roster_cache_meta', 'site_settings'];

function runCommand(commandLine) {
  console.log(`\n$ ${commandLine}`);
  try {
    const result = execSync(commandLine, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result;
  } catch (error) {
    console.error('Command output:', error.stdout);
    console.error('Command error:', error.stderr);
    throw new Error(`Command failed: ${error.message}`);
  }
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
  const flag = remote ? '--remote' : '--local';
  const commandLine = `npx wrangler d1 execute ${DATABASE_NAME} ${flag} --json --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"`;
  
  try {
    const output = runCommand(commandLine);
    const parsed = parseJsonOutput(output);
    
    // Handle the fact that wrangler returns a JSON array with one element
    let resultSet = parsed.results || (Array.isArray(parsed) && parsed[0]?.results) || [];
    
    const allTables = resultSet
      .map(row => row.name)
      .filter(name => !SKIP_TABLES.includes(name));
    
    return allTables;
  } catch (err) {
    console.error('Failed to get table list:', err.message);
    return [];
  }
}

function getTableData(remote = false) {
  const results = {};
  const flag = remote ? '--remote' : '--local';

  console.log(`\n========================================`);
  console.log(`Fetching data from ${remote ? 'PRODUCTION' : 'LOCAL'} database`);
  console.log(`========================================`);

  // Get the actual list of tables to copy
  const tables = getAvailableTables(remote).filter(t => !PREFER_SKIP.includes(t));
  console.log(`\nFound ${tables.length} tables to copy:`, tables.join(', '));

  for (const table of tables) {
    try {
      console.log(`\nFetching ${table}...`);
      const commandLine = `npx wrangler d1 execute ${DATABASE_NAME} ${flag} --json --command "SELECT * FROM ${table}"`;
      const output = runCommand(commandLine);

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
  const columnList = columns.join(', ');

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
    statements.push(`INSERT INTO ${table} (${columnList}) VALUES (${valueList});`);
  }

  return statements;
}

function insertData(data) {
  console.log(`\n========================================`);
  console.log(`Inserting data into LOCAL database`);
  console.log(`========================================`);

  // Define insertion order to respect foreign key constraints
  const insertionOrder = [
    'users',                       // No dependencies
    'characters',                  // Depends on users
    'roster_members_cache',        // No dependencies
    'raid_teams',                  // No dependencies
    'raid_team_members',           // Depends on raid_teams, roster_members_cache
    'primary_raid_schedules',      // No dependencies
    'ad_hoc_raids',                // No dependencies
    'raid_signups',                // Depends on users, characters, raid schedules
    'raider_metrics_cache',        // No dependencies
  ];

  // Get list of tables with data
  const tablesWithData = insertionOrder.filter(table => 
    data[table] && data[table].length > 0
  );

  for (const table of tablesWithData) {
    const rows = data[table];

    try {
      console.log(`\nInserting into ${table}...`);

      // First, clear the table (be careful with foreign keys)
      console.log(`  - Clearing ${table}...`);
      const clearCmd = `npx wrangler d1 execute ${DATABASE_NAME} --local --command "DELETE FROM ${table};"`;
      try {
        runCommand(clearCmd);
      } catch (err) {
        if (!err.message.includes('no such table')) {
          throw err;
        }
        console.log(`  - Table ${table} doesn't exist locally, skipping clear`);
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
        const escapedSql = sql.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');

        const insertCmd = `npx wrangler d1 execute ${DATABASE_NAME} --local --command "${escapedSql}"`;
        try {
          runCommand(insertCmd);
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

  if (tablesWithData.length === 0) {
    console.log(`\nℹ No data to insert - production database is empty`);
  }
}

function main() {
  try {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║  Copy Production Data to Local DB      ║');
    console.log('╚════════════════════════════════════════╝');

    // Fetch production data
    const prodData = getTableData(true);

    // Insert into local
    insertData(prodData);

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
