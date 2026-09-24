// Worldwide per-spec death rates, used by Death Analysis to judge a raider
// against how often their spec dies everywhere rather than against a flat
// guild average (a Beast Mastery Hunter dies ~4x as often as a Holy Priest
// across all Heroic logs, independent of who's playing it).
//
// Source: WCL Deaths Statistics, The Venomous Abyss (zone 53), Heroic, kills
// and wipes — https://www.warcraftlogs.com/zone/statistics/53?metric=deaths&difficulty=4
// "Death %" is deaths / player appearances (see warcraftlogs.com/help/deaths);
// wipes stop counting deaths at WCL's wipe-call cutoff. WCL blocks automated
// fetches of that page, so this is a hand-copied snapshot: refresh it each
// season (new zone id) or after a big class-balance patch.
// Snapshot: 2026-09-24.

export interface SpecDeathRate {
  className: string;
  specName: string;
  /** WCL "Death %" as a fraction (12.79% -> 0.1279). */
  deathRate: number;
  /** WCL "Deaths" column; with deathRate it gives the appearance count used for averaging. */
  deaths: number;
}

/**
 * How much of a spec's worldwide death-rate gap to credit to the spec itself.
 * 1 = fully (a spec dying 30% more than average gets its score divided by
 * 1.30); 0 = no adjustment. WCL's numbers mix in who plays each spec (popular,
 * easier specs draw less experienced players) and which specs get assigned
 * mechanics, so only part of the gap is inherent squishiness.
 */
export const SPEC_DEATH_ADJUSTMENT_STRENGTH = 0.5;

// Keyed by Blizzard spec id, same ids as ROLE_BY_SPEC_ID in mechanics-analysis.ts.
export const SPEC_DEATH_RATES = new Map<number, SpecDeathRate>([
  [257, { className: 'Priest', specName: 'Holy', deathRate: 0.022, deaths: 33_302 }],
  [581, { className: 'Demon Hunter', specName: 'Vengeance', deathRate: 0.0308, deaths: 8_035 }],
  [250, { className: 'Death Knight', specName: 'Blood', deathRate: 0.032, deaths: 48_837 }],
  [73, { className: 'Warrior', specName: 'Protection', deathRate: 0.034, deaths: 12_135 }],
  [268, { className: 'Monk', specName: 'Brewmaster', deathRate: 0.0345, deaths: 10_067 }],
  [104, { className: 'Druid', specName: 'Guardian', deathRate: 0.0349, deaths: 14_241 }],
  [66, { className: 'Paladin', specName: 'Protection', deathRate: 0.0358, deaths: 18_454 }],
  [251, { className: 'Death Knight', specName: 'Frost', deathRate: 0.0433, deaths: 44_957 }],
  [252, { className: 'Death Knight', specName: 'Unholy', deathRate: 0.0471, deaths: 43_087 }],
  [270, { className: 'Monk', specName: 'Mistweaver', deathRate: 0.0494, deaths: 24_565 }],
  [264, { className: 'Shaman', specName: 'Restoration', deathRate: 0.0525, deaths: 100_024 }],
  [263, { className: 'Shaman', specName: 'Enhancement', deathRate: 0.0553, deaths: 26_674 }],
  [1473, { className: 'Evoker', specName: 'Augmentation', deathRate: 0.057, deaths: 10_087 }],
  [1468, { className: 'Evoker', specName: 'Preservation', deathRate: 0.0577, deaths: 37_693 }],
  [577, { className: 'Demon Hunter', specName: 'Havoc', deathRate: 0.06, deaths: 65_432 }],
  [260, { className: 'Rogue', specName: 'Outlaw', deathRate: 0.0603, deaths: 10_411 }],
  [262, { className: 'Shaman', specName: 'Elemental', deathRate: 0.0619, deaths: 90_560 }],
  [254, { className: 'Hunter', specName: 'Marksmanship', deathRate: 0.0631, deaths: 83_223 }],
  [105, { className: 'Druid', specName: 'Restoration', deathRate: 0.0645, deaths: 44_098 }],
  [1480, { className: 'Demon Hunter', specName: 'Devourer', deathRate: 0.0671, deaths: 46_084 }],
  [261, { className: 'Rogue', specName: 'Subtlety', deathRate: 0.0679, deaths: 27_289 }],
  [269, { className: 'Monk', specName: 'Windwalker', deathRate: 0.0691, deaths: 59_800 }],
  [255, { className: 'Hunter', specName: 'Survival', deathRate: 0.0719, deaths: 10_234 }],
  [63, { className: 'Mage', specName: 'Fire', deathRate: 0.0739, deaths: 3_029 }],
  [259, { className: 'Rogue', specName: 'Assassination', deathRate: 0.0751, deaths: 101_625 }],
  [65, { className: 'Paladin', specName: 'Holy', deathRate: 0.0769, deaths: 122_277 }],
  [256, { className: 'Priest', specName: 'Discipline', deathRate: 0.0812, deaths: 7_304 }],
  [1467, { className: 'Evoker', specName: 'Devastation', deathRate: 0.0837, deaths: 24_962 }],
  [103, { className: 'Druid', specName: 'Feral', deathRate: 0.0843, deaths: 25_980 }],
  [102, { className: 'Druid', specName: 'Balance', deathRate: 0.0854, deaths: 93_579 }],
  [265, { className: 'Warlock', specName: 'Affliction', deathRate: 0.0857, deaths: 13_681 }],
  [62, { className: 'Mage', specName: 'Arcane', deathRate: 0.0862, deaths: 287_906 }],
  [72, { className: 'Warrior', specName: 'Fury', deathRate: 0.0881, deaths: 17_298 }],
  [258, { className: 'Priest', specName: 'Shadow', deathRate: 0.0957, deaths: 56_894 }],
  [267, { className: 'Warlock', specName: 'Destruction', deathRate: 0.0972, deaths: 16_228 }],
  [266, { className: 'Warlock', specName: 'Demonology', deathRate: 0.099, deaths: 217_098 }],
  [70, { className: 'Paladin', specName: 'Retribution', deathRate: 0.1021, deaths: 214_375 }],
  [64, { className: 'Mage', specName: 'Frost', deathRate: 0.1043, deaths: 21_078 }],
  [71, { className: 'Warrior', specName: 'Arms', deathRate: 0.1097, deaths: 257_867 }],
  [253, { className: 'Hunter', specName: 'Beast Mastery', deathRate: 0.1279, deaths: 202_297 }],
]);

function pooledRate(rows: SpecDeathRate[]): number | null {
  let deaths = 0;
  let appearances = 0;
  for (const row of rows) {
    deaths += row.deaths;
    appearances += row.deaths / row.deathRate;
  }
  return appearances > 0 ? deaths / appearances : null;
}

const ALL_SPECS = [...SPEC_DEATH_RATES.values()];
/** Deaths per appearance across every spec, i.e. the average raider worldwide. */
const OVERALL_DEATH_RATE = pooledRate(ALL_SPECS) ?? 1;

const CLASS_DEATH_RATES = new Map<string, number>();
for (const className of new Set(ALL_SPECS.map((row) => row.className))) {
  const rate = pooledRate(ALL_SPECS.filter((row) => row.className === className));
  if (rate !== null) CLASS_DEATH_RATES.set(className.toLowerCase(), rate);
}

/**
 * The divisor applied to a raider's death score: (spec rate / overall rate)
 * ^ SPEC_DEATH_ADJUSTMENT_STRENGTH. Falls back to the class's pooled rate
 * when the spec is unknown, and to 1 (no adjustment) when both are.
 */
export function specDeathAdjustment(specId: number | null, className: string): number {
  const rate =
    (specId !== null ? SPEC_DEATH_RATES.get(specId)?.deathRate : undefined) ??
    CLASS_DEATH_RATES.get(className.trim().toLowerCase());
  if (!rate) return 1;
  return (rate / OVERALL_DEATH_RATE) ** SPEC_DEATH_ADJUSTMENT_STRENGTH;
}

export function specName(specId: number | null): string | null {
  return specId !== null ? SPEC_DEATH_RATES.get(specId)?.specName ?? null : null;
}
