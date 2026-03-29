# Copying Production Data to Local Database

This guide explains how to sync production database data to your local development environment for testing with realistic data.

## Quick Start

Run this single command to copy all production data to your local database:

```bash
npm run db:copy-prod
```

## What Gets Copied

The script automatically discovers and copies all tables from production except:
- **Ephemeral data**: `sessions` (user login sessions expire and shouldn't be copied)
- **System tables**: `sqlite_sequence`, `_cf_KV`, `_cf_METADATA`, `d1_migrations`
- **Pre-seeded data** (optional skip): 
  - `link_categories` and `links` (shared URLs)
  - `roster_cache_meta` (metadata)
  - `site_settings` (system configuration)

### Tables That Will Be Copied

When production has data, the script copies every table shared by production and local schema, including newer tables such as:
- `applications`, `application_notes`, `application_characters`
- `member_profiles`, `member_profile_characters`
- `raider_notes`, `raider_preparedness_history`, `raider_progression_history`
- `raiding_content`, `raiding_addons`, `recruitment_needs`
- `sim_runs`, `sim_raider_summaries`, `sim_item_winners`
- Plus the existing user, character, roster, raid, and signup tables

## How It Works

1. **Connects to production** D1 database using Cloudflare's remote API
2. **Queries each table** using `SELECT *` to extract all data
3. **Reconnects to local** D1 database in your `.wrangler` directory
4. **Finds the shared table set** between production and local schema
5. **Orders tables by foreign key dependencies** so inserts happen safely
6. **Clears existing local rows** in reverse dependency order (preserves schema)
7. **Inserts production data** in batches to avoid command-line length limits
8. **Reports results** showing row counts per table

## Before You Run

### Prerequisites
- You must have **Cloudflare API access** configured with credentials (`wrangler` must be authenticated)
- Your **local database schema** must already exist (run `npm run db:setup` first if needed)
- You need **write permissions** to your local database

### Check Your Setup
```bash
# Verify wrangler is authenticated
npx wrangler whoami

# Check local database exists and has tables
npm run db:setup
```

## Script Output

The script provides detailed feedback:

```
╔════════════════════════════════════════╗
║  Copy Production Data to Local DB      ║
╚════════════════════════════════════════╝

========================================
Fetching data from PRODUCTION database
========================================

Shared tables (26): users, characters, applications, ...

Fetching users...
✓ Fetched 42 rows from users

Fetching characters...
✓ Fetched 156 rows from characters

...

========================================
Inserting data into LOCAL database
========================================

Clearing existing LOCAL data
  - Clearing raid_signups...
  - Clearing characters...

Inserting into users...
  - Generated 42 insert statements
✓ Inserted 42 rows into users

...

✓ Data sync complete!
```

## If Production Database Is Empty

If production has no data yet, you'll see:

```
ℹ No data to insert - production database is empty
```

This is normal during early development. The script will succeed, and you can manually add test data using your application's admin interface.

## Advanced Usage

### Copy Only Once in a While

The script is safe to run repeatedly. It:
- Clears old local rows before inserting new data
- Leaves shared tables empty when production has zero rows for that table
- Uses only tables that exist on both production and local schema
- Orders inserts by foreign key dependencies

### Troubleshooting

**Error: `Command failed: npx wrangler d1 execute`**
- Check your Cloudflare API token: `npx wrangler whoami`
- Verify you have access to the D1 database in your account

**Error: `no such table`**
- If local tables don't exist, run: `npm run db:setup`
- The script will skip tables that don't exist on either side

**Error: `duplicate column`**
- This means your local database schema is partially initialized
- Run: `npm run db:setup` to reset it properly

### Include Pre-seeded Tables

By default, the script skips `link_categories`, `links`, `roster_cache_meta`, and `site_settings` so you can keep local seed/config data.

If you want to copy those from production too, run:

```bash
$env:COPY_PROD_INCLUDE_SEEDED = '1'
npm run db:copy-prod
Remove-Item Env:COPY_PROD_INCLUDE_SEEDED
```

## Next Steps

After syncing data:

```bash
npm run dev
```

Then navigate to your app and test with real production data locally!

## Notes

- **Sensitive data**: Session tokens and OAuth credentials are NOT copied (they're environment-specific)
- **Performance**: Batch inserts are limited to 10 statements per command to avoid PowerShell command-line limits
- **Schema differences**: The script copies only the table intersection between production and local schema
