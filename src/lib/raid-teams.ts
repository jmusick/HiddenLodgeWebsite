export type TeamMode = 'flex' | 'mythic';
export type AssignedRole = 'tank' | 'healer' | 'melee-dps' | 'ranged-dps';
export type TokenGroup = 'Cloth' | 'Leather' | 'Mail' | 'Plate' | 'Unknown';

export interface ClassRaidData {
  buffs: string[];
  /** Non-stat raid utility (battle rez, summons/gateways, healthstones) — tracked separately since, unlike buffs, coverage is fight-specific rather than "always want at least one". */
  utility: string[];
  token: TokenGroup;
}

export interface TeamSummaryMember {
  className: string;
  assignedRole: AssignedRole;
}

export interface TeamSummary {
  roleCounts: Record<AssignedRole, number>;
  classDistribution: Array<{ className: string; count: number }>;
  tokenDistribution: Array<{ token: TokenGroup; count: number }>;
  raidBuffs: string[];
  raidBuffCounts: Array<{ buff: string; count: number }>;
  missingRaidBuffs: string[];
  /** Unlike buffs, utility has no fixed "should always have one" list — coverage is fight-specific, so this is just counts. */
  utilityCounts: Array<{ utility: string; count: number }>;
}

export const ASSIGNED_ROLES: AssignedRole[] = ['tank', 'healer', 'melee-dps', 'ranged-dps'];

const CLASS_RAID_DATA: Record<string, ClassRaidData> = {
  'Death Knight': {
    buffs: [],
    utility: ['Battle Resurrection'],
    token: 'Plate',
  },
  'Demon Hunter': {
    buffs: ['Chaos Brand'],
    utility: [],
    token: 'Leather',
  },
  Druid: {
    buffs: ['Mark of the Wild'],
    utility: ['Battle Resurrection'],
    token: 'Leather',
  },
  Evoker: {
    buffs: ['Blessing of the Bronze', 'Bloodlust/Heroism'],
    utility: [],
    token: 'Mail',
  },
  Hunter: {
    buffs: ['Bloodlust/Heroism', "Hunter's Mark"],
    utility: [],
    token: 'Mail',
  },
  Mage: {
    buffs: ['Arcane Intellect', 'Bloodlust/Heroism'],
    utility: [],
    token: 'Cloth',
  },
  Monk: {
    buffs: ['Mystic Touch'],
    utility: [],
    token: 'Leather',
  },
  Paladin: {
    buffs: [],
    utility: [],
    token: 'Plate',
  },
  Priest: {
    buffs: ['Power Word: Fortitude'],
    utility: [],
    token: 'Cloth',
  },
  Rogue: {
    buffs: ['Atrophic Poison'],
    utility: [],
    token: 'Leather',
  },
  Shaman: {
    buffs: ['Bloodlust/Heroism'],
    utility: [],
    token: 'Mail',
  },
  Warlock: {
    buffs: [],
    utility: ['Healthstones', 'Summoning Gateway', 'Demonic Gateway', 'Battle Resurrection'],
    token: 'Cloth',
  },
  Warrior: {
    buffs: ['Battle Shout'],
    utility: [],
    token: 'Plate',
  },
};

export const ALL_RAID_BUFFS = [...new Set(Object.values(CLASS_RAID_DATA).flatMap((data) => data.buffs))].sort((a, b) =>
  a.localeCompare(b)
);

export const ALL_UTILITY = [...new Set(Object.values(CLASS_RAID_DATA).flatMap((data) => data.utility))].sort((a, b) =>
  a.localeCompare(b)
);

/**
 * Raid buffs that apply per-target (e.g. Hunter's Mark) rather than to the
 * whole raid, so a fixed "at least 1" requirement is wrong on multi-target
 * fights. Officers can raise the minimum per buff the same way they do for
 * utility items; every other raid buff keeps a fixed minimum of 1.
 */
export const CONFIGURABLE_RAID_BUFFS = ["Hunter's Mark"];

export const DEFAULT_CONFIGURABLE_BUFF_MINIMUM = 1;

const RAID_BUFF_DESCRIPTIONS: Record<string, string> = {
  'Arcane Intellect': 'Increases Intellect for all raid members.',
  'Atrophic Poison': 'Reduces enemies\' physical damage dealt while the poison is active.',
  'Battle Shout': 'Increases Attack Power for all raid members.',
  'Blessing of the Bronze': 'Increases movement speed and extends major movement cooldowns.',
  'Bloodlust/Heroism': 'Provides a temporary haste increase for the group.',
  'Chaos Brand': 'Increases magic damage taken by targets hit by the raid.',
  "Hunter's Mark": 'Increases damage taken by the marked target from all sources.',
  'Mark of the Wild': 'Increases Versatility for all raid members.',
  'Mystic Touch': 'Increases physical damage taken by targets hit by the raid.',
  'Power Word: Fortitude': 'Increases Stamina for all raid members.',
};

const UTILITY_DESCRIPTIONS: Record<string, string> = {
  'Battle Resurrection': 'Allows an ally to be resurrected while in combat.',
  'Demonic Gateway': 'A two-way portal that teleports anyone who uses it between its two ends.',
  Healthstones: 'Provides personal emergency healing consumables.',
  'Summoning Gateway': 'Summons an absent or dead player to the caster.',
};

export function normalizeTeamMode(value: string | null | undefined): TeamMode | null {
  if (value === 'flex' || value === 'mythic') {
    return value;
  }
  return null;
}

export function normalizeAssignedRole(value: string | null | undefined): AssignedRole | null {
  if (value === 'tank' || value === 'healer' || value === 'melee-dps' || value === 'ranged-dps') {
    return value;
  }
  return null;
}

export function classRaidData(className: string): ClassRaidData {
  return CLASS_RAID_DATA[className] ?? { buffs: [], utility: [], token: 'Unknown' };
}

export function tokenArmorType(token: TokenGroup): string {
  if (token === 'Cloth') return 'Cloth';
  if (token === 'Leather') return 'Leather';
  if (token === 'Mail') return 'Mail';
  if (token === 'Plate') return 'Plate';
  return 'Unknown';
}

export function primaryRaidBuff(className: string): string {
  const buffs = classRaidData(className).buffs;
  return buffs.length > 0 ? buffs[0] : 'None';
}

export function allRaidBuffs(className: string): string[] {
  return classRaidData(className).buffs;
}

export function allUtility(className: string): string[] {
  return classRaidData(className).utility;
}

export function raidBuffDescription(buffName: string): string {
  return RAID_BUFF_DESCRIPTIONS[buffName] ?? 'Provides raid utility or throughput support.';
}

export function utilityDescription(utilityName: string): string {
  return UTILITY_DESCRIPTIONS[utilityName] ?? 'Provides raid utility.';
}

export function computeTeamSummary(members: TeamSummaryMember[]): TeamSummary {
  const roleCounts: Record<AssignedRole, number> = {
    tank: 0,
    healer: 0,
    'melee-dps': 0,
    'ranged-dps': 0,
  };
  const classCounts = new Map<string, number>();
  const tokenCounts = new Map<TokenGroup, number>();
  const buffCounts = new Map<string, number>();
  const buffs = new Set<string>();
  const utilityCounts = new Map<string, number>();

  for (const member of members) {
    roleCounts[member.assignedRole] += 1;
    classCounts.set(member.className, (classCounts.get(member.className) ?? 0) + 1);

    const data = classRaidData(member.className);
    tokenCounts.set(data.token, (tokenCounts.get(data.token) ?? 0) + 1);

    for (const buff of data.buffs) {
      buffs.add(buff);
      buffCounts.set(buff, (buffCounts.get(buff) ?? 0) + 1);
    }
    for (const utility of data.utility) {
      utilityCounts.set(utility, (utilityCounts.get(utility) ?? 0) + 1);
    }
  }

  const classDistribution = [...classCounts.entries()]
    .map(([className, count]) => ({ className, count }))
    .sort((a, b) => a.className.localeCompare(b.className));

  const tokenDistribution = [...tokenCounts.entries()]
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => a.token.localeCompare(b.token));

  const raidBuffCounts = [...buffCounts.entries()]
    .map(([buff, count]) => ({ buff, count }))
    .sort((a, b) => a.buff.localeCompare(b.buff));

  const utilityCountsList = [...utilityCounts.entries()]
    .map(([utility, count]) => ({ utility, count }))
    .sort((a, b) => a.utility.localeCompare(b.utility));

  return {
    roleCounts,
    classDistribution,
    tokenDistribution,
    raidBuffs: [...buffs].sort((a, b) => a.localeCompare(b)),
    raidBuffCounts,
    utilityCounts: utilityCountsList,
    missingRaidBuffs: ALL_RAID_BUFFS.filter((buff) => !buffs.has(buff)),
  };
}
