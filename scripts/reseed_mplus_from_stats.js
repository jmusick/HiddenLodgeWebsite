import { execSync } from 'node:child_process';

const WEEKLY_RESET_TS = 1774364400;

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' });
}

function queryRows() {
  const cmd =
    "npx wrangler d1 execute hidden-lodge-db --remote --command=\"SELECT blizzard_char_id, name, realm_slug, COALESCE(mythic_plus_weekly_runs,0) AS weekly FROM raider_metrics_cache WHERE auth_state='ready' ORDER BY name\" --json";
  const payload = JSON.parse(run(cmd));
  return payload?.[0]?.results ?? [];
}

async function fetchStatsTotal(realmSlug, name) {
  const realm = encodeURIComponent(realmSlug);
  const encodedName = encodeURIComponent(name);

  const detailsRes = await fetch(
    `https://raider.io/api/characters/us/${realm}/${encodedName}?season=season-mn-1&tier=35`,
    { headers: { Accept: 'application/json' } }
  );
  if (!detailsRes.ok) return null;
  const details = await detailsRes.json();
  const characterId = details?.characterDetails?.character?.id;
  if (!characterId) return null;

  const href = `/characters/us/${realm}/${encodedName}/stats/mythic-plus-runs?groupBy=dungeon&statSeason=season-mn-1`;
  const url = new URL('https://raider.io/api/statistics/get-data');
  url.searchParams.set('season', 'season-mn-1');
  url.searchParams.set('type', 'runs-over-time');
  url.searchParams.set('minMythicLevel', '2');
  url.searchParams.set('maxMythicLevel', '99');
  url.searchParams.set('seasonWeekStart', '1');
  url.searchParams.set('seasonWeekEnd', '1');
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

function topUpCharacter(charId, currentWeekly, statsTotal) {
  const missing = statsTotal - currentWeekly;
  if (missing <= 0) return false;

  const baseOffset = 300000 + ((Number(charId) % 1000) * 100);
  const sql = `WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM seq WHERE x < ${missing}) INSERT OR IGNORE INTO raider_keystones (blizzard_char_id, completed_ts, dungeon_id, keystone_level) SELECT ${Number(charId)}, ${WEEKLY_RESET_TS} + ${baseOffset} + x, NULL, NULL FROM seq; UPDATE raider_metrics_cache SET mythic_plus_weekly_runs = ${statsTotal}, mythic_plus_season_runs = ${statsTotal}, mythic_plus_prev_weekly_runs = 0 WHERE blizzard_char_id = ${Number(charId)};`;

  const cmd = `npx wrangler d1 execute hidden-lodge-db --remote --command=\"${sql}\"`;
  run(cmd);
  return true;
}

async function main() {
  const rows = queryRows();
  let toppedUp = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const name = row.name;
    const currentWeekly = Number(row.weekly ?? 0);

    try {
      const statsTotal = await fetchStatsTotal(row.realm_slug, name);
      if (statsTotal === null) {
        failed += 1;
        console.log(`fail ${name}: unable to fetch stats total`);
        continue;
      }

      if (statsTotal > currentWeekly) {
        topUpCharacter(row.blizzard_char_id, currentWeekly, statsTotal);
        toppedUp += 1;
        console.log(`topup ${name}: ${currentWeekly} -> ${statsTotal}`);
      } else {
        skipped += 1;
        console.log(`skip ${name}: ${currentWeekly} >= ${statsTotal}`);
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`error ${name}: ${message.split('\n')[0]}`);
    }
  }

  console.log(`DONE toppedUp=${toppedUp} skipped=${skipped} failed=${failed}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`fatal: ${message}`);
  process.exit(1);
});
