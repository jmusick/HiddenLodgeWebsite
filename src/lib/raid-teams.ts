export type TeamMode = 'flex' | 'mythic';
export type AssignedRole = 'tank' | 'healer' | 'melee-dps' | 'ranged-dps';
export type TokenGroup = 'Conqueror' | 'Protector' | 'Vanquisher' | 'Unknown';

export interface ClassRaidData {
  buffs: string[];
  healerCooldowns: string[];
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
}

export const ASSIGNED_ROLES: AssignedRole[] = ['tank', 'healer', 'melee-dps', 'ranged-dps'];

const CLASS_RAID_DATA: Record<string, ClassRaidData> = {
  'Death Knight': {
    buffs: ['Battle Resurrection'],
    healerCooldowns: [],
    token: 'Vanquisher',
  },
  'Demon Hunter': {
    buffs: ['Chaos Brand'],
    healerCooldowns: [],
    token: 'Vanquisher',
  },
  Druid: {
    buffs: ['Mark of the Wild', 'Battle Resurrection'],
    healerCooldowns: ['Tranquility'],
    token: 'Vanquisher',
  },
  Evoker: {
    buffs: ['Blessing of the Bronze', 'Bloodlust/Heroism'],
    healerCooldowns: ['Rewind'],
    token: 'Protector',
  },
  Hunter: {
    buffs: ['Bloodlust/Heroism'],
    healerCooldowns: [],
    token: 'Protector',
  },
  Mage: {
    buffs: ['Arcane Intellect', 'Bloodlust/Heroism'],
    healerCooldowns: [],
    token: 'Vanquisher',
  },
  Monk: {
    buffs: ['Mystic Touch'],
    healerCooldowns: ['Revival'],
    token: 'Vanquisher',
  },
  Paladin: {
    buffs: [],
    healerCooldowns: ['Aura Mastery'],
    token: 'Conqueror',
  },
  Priest: {
    buffs: ['Power Word: Fortitude'],
    healerCooldowns: ['Power Word: Barrier', 'Divine Hymn'],
    token: 'Conqueror',
  },
  Rogue: {
    buffs: [],
    healerCooldowns: [],
    token: 'Vanquisher',
  },
  Shaman: {
    buffs: ['Bloodlust/Heroism'],
    healerCooldowns: ['Spirit Link Totem', 'Healing Tide Totem'],
    token: 'Protector',
  },
  Warlock: {
    buffs: ['Healthstones', 'Summoning Gateway', 'Battle Resurrection'],
    healerCooldowns: [],
    token: 'Conqueror',
  },
  Warrior: {
    buffs: ['Battle Shout'],
    healerCooldowns: ['Rallying Cry'],
    token: 'Protector',
  },
};

const ALL_RAID_BUFFS = [...new Set(Object.values(CLASS_RAID_DATA).flatMap((data) => data.buffs))].sort((a, b) =>
  a.localeCompare(b)
);

const RAID_BUFF_DESCRIPTIONS: Record<string, string> = {
  'Arcane Intellect': 'Increases Intellect for all raid members.',
  'Battle Resurrection': 'Allows an ally to be resurrected while in combat.',
  'Battle Shout': 'Increases Attack Power for all raid members.',
  'Blessing of the Bronze': 'Increases movement speed and extends major movement cooldowns.',
  'Bloodlust/Heroism': 'Provides a temporary haste increase for the group.',
  'Chaos Brand': 'Increases magic damage taken by targets hit by the raid.',
  Healthstones: 'Provides personal emergency healing consumables.',
  'Mark of the Wild': 'Increases Versatility for all raid members.',
  'Mystic Touch': 'Increases physical damage taken by targets hit by the raid.',
  'Power Word: Fortitude': 'Increases Stamina for all raid members.',
  'Summoning Gateway': 'Adds a movement utility gateway for raid positioning.',
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
  return CLASS_RAID_DATA[className] ?? { buffs: [], healerCooldowns: [], token: 'Unknown' };
}

export function tokenArmorType(token: TokenGroup): string {
  if (token === 'Conqueror') return 'Cloth';
  if (token === 'Protector') return 'Mail';
  if (token === 'Vanquisher') return 'Leather';
  return 'Unknown';
}

export function primaryRaidBuff(className: string): string {
  const buffs = classRaidData(className).buffs;
  return buffs.length > 0 ? buffs[0] : 'None';
}

export function allRaidBuffs(className: string): string[] {
  return classRaidData(className).buffs;
}

export function raidBuffDescription(buffName: string): string {
  return RAID_BUFF_DESCRIPTIONS[buffName] ?? 'Provides raid utility or throughput support.';
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

  for (const member of members) {
    roleCounts[member.assignedRole] += 1;
    classCounts.set(member.className, (classCounts.get(member.className) ?? 0) + 1);

    const data = classRaidData(member.className);
    tokenCounts.set(data.token, (tokenCounts.get(data.token) ?? 0) + 1);

    for (const buff of data.buffs) {
      buffs.add(buff);
      buffCounts.set(buff, (buffCounts.get(buff) ?? 0) + 1);
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

  return {
    roleCounts,
    classDistribution,
    tokenDistribution,
    raidBuffs: [...buffs].sort((a, b) => a.localeCompare(b)),
    raidBuffCounts,
    missingRaidBuffs: ALL_RAID_BUFFS.filter((buff) => !buffs.has(buff)),
  };
}
