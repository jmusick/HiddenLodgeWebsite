export const prerender = false;

import type { APIContext } from 'astro';
import { FEATURE_FLAGS } from '../../../lib/feature-flags';
import { getDeathCooldownDetail, type DeathCooldownAbilityStatus } from '../../../lib/death-cooldowns';
import { fetchSpellIconUrls } from '../../../lib/spell-icons';

type AbilityWithIcon = DeathCooldownAbilityStatus & { iconUrl: string | null };

function withIcon(ability: DeathCooldownAbilityStatus, icons: Map<number, string>): AbilityWithIcon {
  return { ...ability, iconUrl: icons.get(ability.abilityId) ?? null };
}

export async function GET(context: APIContext): Promise<Response> {
  if (!FEATURE_FLAGS.tools || !FEATURE_FLAGS.deathAnalysis) {
    return new Response('Not found', { status: 404 });
  }
  if (!context.locals.isGuildMember) {
    return new Response('Forbidden', { status: 403 });
  }

  const params = context.url.searchParams;
  const reportCode = (params.get('reportCode') ?? '').trim();
  const fightId = Number(params.get('fightId'));
  const deathPosition = Number(params.get('deathPosition'));
  const deathOffsetMs = Number(params.get('deathOffsetMs'));
  const blizzardCharId = Number(params.get('blizzardCharId'));

  if (
    !reportCode ||
    !Number.isFinite(fightId) || fightId <= 0 ||
    !Number.isFinite(deathPosition) || deathPosition <= 0 ||
    !Number.isFinite(deathOffsetMs) || deathOffsetMs < 0 ||
    !Number.isFinite(blizzardCharId) || blizzardCharId <= 0
  ) {
    return Response.json({ error: 'Invalid parameters' }, { status: 400 });
  }

  try {
    const detail = await getDeathCooldownDetail(reportCode, fightId, deathPosition, deathOffsetMs, blizzardCharId);
    const abilityIds = [...detail.defensives, ...detail.consumables].map((a) => a.abilityId);
    const icons = await fetchSpellIconUrls(abilityIds);
    return Response.json({
      data: {
        specId: detail.specId,
        defensives: detail.defensives.map((ability) => withIcon(ability, icons)),
        consumables: detail.consumables.map((ability) => withIcon(ability, icons)),
      },
    });
  } catch (error) {
    console.warn('[death-cooldowns] failed to compute detail', {
      reportCode,
      fightId,
      deathPosition,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: 'Failed to load cooldown data' }, { status: 502 });
  }
}
