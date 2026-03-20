export interface RaidProgressTargetOption {
  raidName: string;
  code: string;
}

export interface RaidProgressTargetGroup {
  id: string;
  expansion: string;
  tier: string;
  raids: RaidProgressTargetOption[];
}

export const RAID_PROGRESS_TARGET_GROUPS: RaidProgressTargetGroup[] = [
  {
    id: 'midnight-s1',
    expansion: 'Midnight',
    tier: 'Season 1',
    raids: [
      { raidName: 'The Voidspire', code: 'VS' },
      { raidName: 'The Dreamrift', code: 'DR' },
      { raidName: "March on Quel'Danas", code: 'MQD' },
    ],
  },
];

export const RAID_PROGRESS_TARGETS = RAID_PROGRESS_TARGET_GROUPS.flatMap((group) => group.raids);

export function getDefaultRaidProgressTierId(): string {
  return RAID_PROGRESS_TARGET_GROUPS[0]?.id ?? '';
}

export function getRaidProgressTierById(id: string | null | undefined): RaidProgressTargetGroup | null {
  const normalized = (id ?? '').trim().toLowerCase();
  if (!normalized) return null;
  return RAID_PROGRESS_TARGET_GROUPS.find((group) => group.id.toLowerCase() === normalized) ?? null;
}

export function resolveRaidProgressTier(id: string | null | undefined): RaidProgressTargetGroup | null {
  const matched = getRaidProgressTierById(id);
  if (matched) return matched;
  const fallbackId = getDefaultRaidProgressTierId();
  return getRaidProgressTierById(fallbackId);
}

export function isValidRaidProgressTierId(id: string): boolean {
  if (!id.trim()) return true;
  return getRaidProgressTierById(id) !== null;
}

export function getRaidProgressTargetCode(raidName: string | null | undefined): string | null {
  const normalized = (raidName ?? '').trim().toLowerCase();
  if (!normalized) return null;
  const option = RAID_PROGRESS_TARGETS.find((entry) => entry.raidName.toLowerCase() === normalized);
  return option?.code ?? null;
}
