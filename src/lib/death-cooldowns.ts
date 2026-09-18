import type { D1Database } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { loadWclCharacterLookup, matchWclActorCharId, queryWcl } from './wcl';
import { requireAccessToken } from './death-analysis';
import { HEALTHSTONE, HEALTH_POTIONS, defensivesForSpecId, type DefensiveAbility } from './defensive-cooldowns';

// Lazily computed, cached estimate of "what was available" at the moment of
// a death, backing an expanded death row on /death-analysis. See
// defensive-cooldowns.ts for the caveats this estimate carries.

export type CooldownStatus = 'available' | 'on_cooldown' | 'unknown' | 'not_tracked';

export interface DeathCooldownAbilityStatus {
  abilityId: number;
  name: string;
  status: CooldownStatus;
  secondsRemaining: number | null;
}

export interface DeathCooldownDetail {
  specId: number;
  defensives: DeathCooldownAbilityStatus[];
  /** Healthstone plus every tracked healing potion (see HEALTH_POTIONS). */
  consumables: DeathCooldownAbilityStatus[];
}

function consumableAbilities(): DefensiveAbility[] {
  return [HEALTHSTONE, ...HEALTH_POTIONS];
}

function getDatabase(dbInput?: D1Database): D1Database {
  return dbInput ?? env.DB;
}

function toPositiveInt(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function unknownStatus(ability: DefensiveAbility): DeathCooldownAbilityStatus {
  return { abilityId: ability.abilityId, name: ability.name, status: 'unknown', secondsRemaining: null };
}

function statusFor(ability: DefensiveAbility, lastCastMs: number | null, deathTimestampMs: number): DeathCooldownAbilityStatus {
  if (lastCastMs === null) {
    return { abilityId: ability.abilityId, name: ability.name, status: 'available', secondsRemaining: null };
  }
  const elapsedSeconds = (deathTimestampMs - lastCastMs) / 1000;
  const remaining = ability.cooldownSeconds - elapsedSeconds;
  return remaining > 0
    ? { abilityId: ability.abilityId, name: ability.name, status: 'on_cooldown', secondsRemaining: Math.round(remaining) }
    : { abilityId: ability.abilityId, name: ability.name, status: 'available', secondsRemaining: null };
}

function parseAbilityStatusJson(json: unknown): DeathCooldownAbilityStatus[] {
  try {
    return JSON.parse(String(json ?? '[]'));
  } catch {
    return [];
  }
}

async function fetchCachedDetail(
  db: D1Database,
  reportCode: string,
  fightId: number,
  deathPosition: number
): Promise<DeathCooldownDetail | null> {
  const row = await db
    .prepare(
      `SELECT spec_id, defensives_json, consumables_json
       FROM death_cooldown_cache
       WHERE report_code = ? AND fight_id = ? AND death_position = ?`
    )
    .bind(reportCode, fightId, deathPosition)
    .first<Record<string, unknown>>();
  if (!row) return null;

  return {
    specId: toPositiveInt(row.spec_id),
    defensives: parseAbilityStatusJson(row.defensives_json),
    consumables: parseAbilityStatusJson(row.consumables_json),
  };
}

async function storeDetail(
  db: D1Database,
  reportCode: string,
  fightId: number,
  deathPosition: number,
  detail: DeathCooldownDetail
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO death_cooldown_cache (
         report_code, fight_id, death_position, spec_id, defensives_json, consumables_json, computed_at
       ) VALUES (?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(report_code, fight_id, death_position) DO UPDATE SET
         spec_id = excluded.spec_id,
         defensives_json = excluded.defensives_json,
         consumables_json = excluded.consumables_json,
         computed_at = excluded.computed_at`
    )
    .bind(reportCode, fightId, deathPosition, detail.specId, JSON.stringify(detail.defensives), JSON.stringify(detail.consumables))
    .run();
}

type WclCastEvent = { type?: string; sourceID?: number; targetID?: number; fight?: number; abilityGameID?: number; timestamp?: number };
type WclCombatantEvent = { type?: string; sourceID?: number; fight?: number; specID?: number };

async function computeDetail(
  db: D1Database,
  reportCode: string,
  fightId: number,
  deathOffsetMs: number,
  blizzardCharId: number
): Promise<DeathCooldownDetail> {
  const accessToken = await requireAccessToken(db);

  const metadata = await queryWcl<{
    reportData?: {
      report?: {
        fights?: Array<{ id?: number; startTime?: number }>;
        masterData?: { actors?: Array<{ id?: number; name?: string; server?: string; gameID?: number }> };
      } | null;
    };
  }>(
    accessToken,
    `
      query DeathCooldownMetadata($code: String!, $fightIDs: [Int]!) {
        reportData {
          report(code: $code) {
            fights(fightIDs: $fightIDs) { id startTime }
            masterData { actors(type: "Player") { id name server gameID } }
          }
        }
      }
    `,
    { code: reportCode, fightIDs: [fightId] }
  );

  const report = metadata?.reportData?.report;
  const fightStartMs = toPositiveInt(report?.fights?.[0]?.startTime);
  if (!report || fightStartMs <= 0) throw new Error('Unable to load fight metadata for death cooldown lookup.');

  const ownership = await loadWclCharacterLookup(db);
  let actorId: number | null = null;
  for (const actor of report.masterData?.actors ?? []) {
    const id = toPositiveInt(actor.id);
    if (!id) continue;
    if (matchWclActorCharId(actor, ownership) === blizzardCharId) {
      actorId = id;
      break;
    }
  }

  const deathTimestampMs = fightStartMs + Math.max(0, deathOffsetMs);
  if (!actorId) {
    return {
      specId: 0,
      defensives: [],
      consumables: consumableAbilities().map(unknownStatus),
    };
  }

  const combatantPayload = await queryWcl<{
    reportData?: { report?: { events?: { data?: WclCombatantEvent[] } } };
  }>(
    accessToken,
    `
      query DeathCooldownCombatant($code: String!, $fightIDs: [Int]!, $startTime: Float!, $endTime: Float!) {
        reportData {
          report(code: $code) {
            events(dataType: CombatantInfo, fightIDs: $fightIDs, startTime: $startTime, endTime: $endTime) {
              data
            }
          }
        }
      }
    `,
    { code: reportCode, fightIDs: [fightId], startTime: fightStartMs, endTime: deathTimestampMs }
  );
  let specId = 0;
  for (const event of combatantPayload?.reportData?.report?.events?.data ?? []) {
    if (String(event.type ?? '').toLowerCase() !== 'combatantinfo') continue;
    if (toPositiveInt(event.sourceID) !== actorId) continue;
    specId = toPositiveInt(event.specID);
    break;
  }

  const defensives = defensivesForSpecId(specId);

  const lastCastMsByAbility = new Map<number, number>();
  let nextStart = fightStartMs;
  const CAST_EVENT_MAX_PAGES = 20;
  for (let page = 0; page < CAST_EVENT_MAX_PAGES && nextStart <= deathTimestampMs; page += 1) {
    const castPayload = await queryWcl<{
      reportData?: { report?: { events?: { data?: WclCastEvent[]; nextPageTimestamp?: number | null } } };
    }>(
      accessToken,
      `
        query DeathCooldownCasts($code: String!, $fightIDs: [Int]!, $sourceID: Int!, $startTime: Float!, $endTime: Float!) {
          reportData {
            report(code: $code) {
              events(dataType: Casts, sourceID: $sourceID, fightIDs: $fightIDs, startTime: $startTime, endTime: $endTime) {
                data
                nextPageTimestamp
              }
            }
          }
        }
      `,
      { code: reportCode, fightIDs: [fightId], sourceID: actorId, startTime: nextStart, endTime: deathTimestampMs }
    );

    const events = castPayload?.reportData?.report?.events?.data ?? [];
    for (const event of events) {
      const abilityId = toPositiveInt(event.abilityGameID);
      const timestamp = toPositiveInt(event.timestamp);
      if (!abilityId || !timestamp || timestamp > deathTimestampMs) continue;
      const existing = lastCastMsByAbility.get(abilityId) ?? 0;
      if (timestamp > existing) lastCastMsByAbility.set(abilityId, timestamp);
    }

    const nextPage = toPositiveInt(castPayload?.reportData?.report?.events?.nextPageTimestamp);
    if (!nextPage || nextPage <= nextStart) break;
    nextStart = nextPage;
  }

  // Abilities in the same cooldownGroup (e.g. both healing potions) share one
  // in-game cooldown, so casting either one puts both on cooldown — use the
  // most recent cast across the whole group, not just the ability's own.
  const allTracked = [...defensives, ...consumableAbilities()];
  const lastCastForAbility = (ability: DefensiveAbility): number | null => {
    if (!ability.cooldownGroup) return lastCastMsByAbility.get(ability.abilityId) ?? null;
    let latest: number | null = null;
    for (const sibling of allTracked) {
      if (sibling.cooldownGroup !== ability.cooldownGroup) continue;
      const castMs = lastCastMsByAbility.get(sibling.abilityId);
      if (castMs !== undefined && (latest === null || castMs > latest)) latest = castMs;
    }
    return latest;
  };

  return {
    specId,
    defensives: defensives.map((ability) => statusFor(ability, lastCastForAbility(ability), deathTimestampMs)),
    consumables: consumableAbilities().map((ability) => statusFor(ability, lastCastForAbility(ability), deathTimestampMs)),
  };
}

export async function getDeathCooldownDetail(
  reportCode: string,
  fightId: number,
  deathPosition: number,
  deathOffsetMs: number,
  blizzardCharId: number,
  dbInput?: D1Database
): Promise<DeathCooldownDetail> {
  const db = getDatabase(dbInput);
  const cached = await fetchCachedDetail(db, reportCode, fightId, deathPosition);
  if (cached) return cached;

  const detail = await computeDetail(db, reportCode, fightId, deathOffsetMs, blizzardCharId);
  await storeDetail(db, reportCode, fightId, deathPosition, detail);
  return detail;
}
