import { execSync } from 'node:child_process';

const SEASON_START_TS = 1774364400;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const CURRENT_TS = Math.floor(Date.now() / 1000);
const CURRENT_SEASON_WEEK = Math.max(1, Math.floor((CURRENT_TS - SEASON_START_TS) / WEEK_SECONDS) + 1);

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' });
}

function easternUtcOffsetMinutes(atUtc) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
    hour: '2-digit',
  }).formatToParts(atUtc);

  const offsetLabel = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT-5';
  const match = offsetLabel.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) return -300;

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2] ?? '0');
  const minutes = Number(match[3] ?? '0');
  return sign * (hours * 60 + minutes);
}

function getUsWeeklyResetTimestamp() {
  const now = new Date();
  const nowParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const weekdayShort = nowParts.find((part) => part.type === 'weekday')?.value ?? 'Tue';
  const year = Number(nowParts.find((part) => part.type === 'year')?.value ?? '1970');
  const month = Number(nowParts.find((part) => part.type === 'month')?.value ?? '1');
  const day = Number(nowParts.find((part) => part.type === 'day')?.value ?? '1');
  const weekdayToIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayIndex = weekdayToIndex[weekdayShort] ?? 2;
  const daysSinceTuesday = (dayIndex - 2 + 7) % 7;

  const localResetSeedUtc = new Date(Date.UTC(year, month - 1, day - daysSinceTuesday, 10, 0, 0, 0));
  const offsetMinutes = easternUtcOffsetMinutes(localResetSeedUtc);
  let resetUtc = new Date(localResetSeedUtc.getTime() - offsetMinutes * 60 * 1000);

  if (resetUtc > now) {
    const previousWeekLocalSeedUtc = new Date(Date.UTC(year, month - 1, day - daysSinceTuesday - 7, 10, 0, 0, 0));
    const previousWeekOffsetMinutes = easternUtcOffsetMinutes(previousWeekLocalSeedUtc);
    resetUtc = new Date(previousWeekLocalSeedUtc.getTime() - previousWeekOffsetMinutes * 60 * 1000);
  }

  return Math.floor(resetUtc.getTime() / 1000);
}

const CURRENT_WEEK_RESET_TS = getUsWeeklyResetTimestamp();
const PREVIOUS_WEEK_START_TS = Math.max(SEASON_START_TS, CURRENT_WEEK_RESET_TS - WEEK_SECONDS);

function queryRows() {
  const cmd =
    "npx wrangler d1 execute hidden-lodge-db --remote --command=\"SELECT blizzard_char_id, name, realm_slug, COALESCE(mythic_plus_weekly_runs,0) AS weekly FROM raider_metrics_cache WHERE auth_state='ready' ORDER BY name\" --json";
  const payload = JSON.parse(run(cmd));
  return payload?.[0]?.results ?? [];
}

async function fetchCharacterId(realmSlug, name) {
  const realm = encodeURIComponent(realmSlug);
  const encodedName = encodeURIComponent(name);

  const detailsRes = await fetch(
    `https://raider.io/api/characters/us/${realm}/${encodedName}?season=season-mn-1&tier=35`,
    { headers: { Accept: 'application/json' } }
  );
  if (!detailsRes.ok) return null;
  const details = await detailsRes.json();
  const characterId = Number(details?.characterDetails?.character?.id ?? NaN);
  return Number.isInteger(characterId) && characterId > 0 ? characterId : null;
}

async function fetchStatsWeekTotal(realmSlug, name, seasonWeek) {
  const characterId = await fetchCharacterId(realmSlug, name);
  if (characterId === null) return null;

  const realm = encodeURIComponent(realmSlug);
  const encodedName = encodeURIComponent(name);
  const href = `/characters/us/${realm}/${encodedName}/stats/mythic-plus-runs?groupBy=dungeon&statSeason=season-mn-1`;
  const url = new URL('https://raider.io/api/statistics/get-data');
  url.searchParams.set('season', 'season-mn-1');
  url.searchParams.set('type', 'runs-over-time');
  url.searchParams.set('minMythicLevel', '2');
  url.searchParams.set('maxMythicLevel', '99');
  url.searchParams.set('seasonWeekStart', String(seasonWeek));
  url.searchParams.set('seasonWeekEnd', String(seasonWeek));
  url.searchParams.set('href', href);
  url.searchParams.set('version', '4');
  url.searchParams.set('characterIds', String(characterId));
  url.searchParams.set('groupBy', 'dungeon');

  const statsRes = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!statsRes.ok) return null;
  const stats = await statsRes.json();
  const rows = Array.isArray(stats?.data) ? stats.data : [];
  return rows.reduce((sum, row) => sum + Math.max(0, Number(row?.quantity ?? 0)), 0);
}

function queryActualRunCount(charId, weekStartTs, weekEndTs) {
  const sql = `SELECT COUNT(*) AS cnt FROM raider_keystones WHERE blizzard_char_id = ${Number(charId)} AND completed_ts >= ${weekStartTs} AND completed_ts < ${weekEndTs} AND NOT (dungeon_id IS NULL AND keystone_level IS NULL)`;
  const payload = JSON.parse(
    run(`npx wrangler d1 execute hidden-lodge-db --remote --command=\"${sql}\" --json`)
  );
  return Number(payload?.[0]?.results?.[0]?.cnt ?? 0);
}

function rebuildSyntheticWeek(charId, weekStartTs, weekEndTs, targetTotal) {
  const actualCount = queryActualRunCount(charId, weekStartTs, weekEndTs);
  const syntheticNeeded = Math.max(0, targetTotal - actualCount);
  const baseOffset = 300000 + ((Number(charId) % 1000) * 100);
  const sql = `DELETE FROM raider_keystones WHERE blizzard_char_id = ${Number(charId)} AND completed_ts >= ${weekStartTs} AND completed_ts < ${weekEndTs} AND dungeon_id IS NULL AND keystone_level IS NULL; WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM seq WHERE x < ${syntheticNeeded}) INSERT OR IGNORE INTO raider_keystones (blizzard_char_id, completed_ts, dungeon_id, keystone_level) SELECT ${Number(charId)}, ${weekStartTs} + ${baseOffset} + x, NULL, NULL FROM seq;`;
  run(`npx wrangler d1 execute hidden-lodge-db --remote --command=\"${sql}\"`);
}

function updateCache(charId, previousWeekTotal, currentWeekTotal) {
  const seasonTotal = previousWeekTotal + currentWeekTotal;
  const sql = `UPDATE raider_metrics_cache SET mythic_plus_weekly_runs = ${currentWeekTotal}, mythic_plus_prev_weekly_runs = ${previousWeekTotal}, mythic_plus_season_runs = ${seasonTotal}, updated_at = strftime('%s','now') WHERE blizzard_char_id = ${Number(charId)};`;
  run(`npx wrangler d1 execute hidden-lodge-db --remote --command=\"${sql}\"`);
}

async function main() {
  const rows = queryRows();
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const name = row.name;

    try {
      const previousWeekTotal = CURRENT_SEASON_WEEK > 1
        ? await fetchStatsWeekTotal(row.realm_slug, name, CURRENT_SEASON_WEEK - 1)
        : 0;
      const currentWeekTotal = await fetchStatsWeekTotal(row.realm_slug, name, CURRENT_SEASON_WEEK);

      if (previousWeekTotal === null || currentWeekTotal === null) {
        failed += 1;
        console.log(`fail ${name}: unable to fetch week totals`);
        continue;
      }

      rebuildSyntheticWeek(row.blizzard_char_id, PREVIOUS_WEEK_START_TS, CURRENT_WEEK_RESET_TS, previousWeekTotal);
      rebuildSyntheticWeek(row.blizzard_char_id, CURRENT_WEEK_RESET_TS, CURRENT_WEEK_RESET_TS + WEEK_SECONDS, currentWeekTotal);
      updateCache(row.blizzard_char_id, previousWeekTotal, currentWeekTotal);

      if (Number(row.weekly ?? 0) !== currentWeekTotal || previousWeekTotal > 0 || currentWeekTotal > 0) {
        updated += 1;
        console.log(`sync ${name}: prev=${previousWeekTotal} current=${currentWeekTotal}`);
      } else {
        skipped += 1;
        console.log(`skip ${name}: prev=0 current=0`);
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`error ${name}: ${message.split('\n')[0]}`);
    }
  }

  console.log(`DONE updated=${updated} skipped=${skipped} failed=${failed}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`fatal: ${message}`);
  process.exit(1);
});
