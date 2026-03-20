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
- **System tables**: `sqlite_sequence`, `_cf_KV` (Cloudflare internal)
- **Pre-seeded data** (optional skip): 
  - `link_categories` and `links` (shared URLs)
  - `roster_cache_meta` (metadata)
  - `site_settings` (system configuration)

### Tables That Will Be Copied

When production has data, the script copies:
- `users` - User accounts
- `characters` - World of Warcraft characters
- `roster_members_cache` - Guild roster data
- `primary_raid_schedules` - Recurring raid schedule definitions
- `ad_hoc_raids` - One-time raid events
- `raid_signups` - User signups for raid events
- `raid_teams` - Raid roster team definitions
- `raid_team_members` - Team composition and assigned roles
- `raider_metrics_cache` - Cached raider statistics

## How It Works

1. **Connects to production** D1 database using Cloudflare's remote API
2. **Queries each table** using `SELECT *` to extract all data
3. **Reconnects to local** D1 database in your `.wrangler` directory
4. **Clears existing data** in each table (preserves schema)
5. **Inserts production data** in batches to avoid command-line length limits
6. **Reports results** showing row counts per table

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

Found 9 tables to copy: users, characters, raid_signups, ...

Fetching users...
✓ Fetched 42 rows from users

Fetching characters...
✓ Fetched 156 rows from characters

...

========================================
Inserting data into LOCAL database
========================================

Inserting into users...
  - Clearing users...
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
- Clears old data before inserting new data
- Handles missing tables gracefully
- Won't break if production schema differs from local

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

### Exclude Pre-seeded Tables

If you want to keep your local `links`, `link_categories`, or `site_settings`, edit [scripts/copy-prod-data.mjs](scripts/copy-prod-data.mjs) and modify:

```javascript
const PREFER_SKIP = ['link_categories', 'links', 'roster_cache_meta', 'site_settings'];
```

Remove the table names you want to copy, then rerun.

## Next Steps

After syncing data:

```bash
npm run dev
```

Then navigate to your app and test with real production data locally!

## Notes

- **Sensitive data**: Session tokens and OAuth credentials are NOT copied (they're environment-specific)
- **Performance**: Batch inserts are limited to 10 statements per command to avoid PowerShell command-line limits
- **Schema differences**: If production schema differs from local migrations, the script will skip those tables
