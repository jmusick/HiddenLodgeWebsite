// Reference data for the Death Analysis "defensives available" column: a
// per-class list of personal defensive cooldowns, plus the shared
// healthstone/health-potion abilities, with their Warcraft Logs ability IDs
// and base cooldown durations. death-cooldowns.ts uses this to estimate
// whether each ability was available at the moment of a death by finding the
// most recent matching cast in the pull and comparing elapsed time to the
// cooldown here.
//
// This is inherently an approximation: it ignores talents/gear that alter
// cooldown durations, and a cast before the pull started (outside the
// queried window) is treated as "no cast seen" (shown as available). Spell
// IDs below are long-stable personal defensives; re-verify against a real
// report's Casts events before trusting a new spec's entry.

export interface DefensiveAbility {
  abilityId: number;
  name: string;
  /** Base cooldown in seconds, ignoring talent/gear modifiers. */
  cooldownSeconds: number;
  /**
   * Abilities sharing a group ID share one cooldown in-game — casting any of
   * them puts the whole group on cooldown, not just the one cast. death-
   * cooldowns.ts uses the most recent cast across the whole group, not just
   * an ability's own cast history, when computing its status.
   */
  cooldownGroup?: string;
}

// WCL CombatantInfo specID -> class name, matching classColor()/CLASS_RAID_DATA
// naming elsewhere in this codebase (src/lib/wow.ts, src/lib/raid-teams.ts).
export const SPEC_ID_TO_CLASS = new Map<number, string>([
  [250, 'Death Knight'], [251, 'Death Knight'], [252, 'Death Knight'],
  [577, 'Demon Hunter'], [581, 'Demon Hunter'],
  [102, 'Druid'], [103, 'Druid'], [104, 'Druid'], [105, 'Druid'],
  [1467, 'Evoker'], [1468, 'Evoker'], [1473, 'Evoker'],
  [253, 'Hunter'], [254, 'Hunter'], [255, 'Hunter'],
  [62, 'Mage'], [63, 'Mage'], [64, 'Mage'],
  [268, 'Monk'], [269, 'Monk'], [270, 'Monk'],
  [65, 'Paladin'], [66, 'Paladin'], [70, 'Paladin'],
  [256, 'Priest'], [257, 'Priest'], [258, 'Priest'],
  [259, 'Rogue'], [260, 'Rogue'], [261, 'Rogue'],
  [262, 'Shaman'], [263, 'Shaman'], [264, 'Shaman'],
  [265, 'Warlock'], [266, 'Warlock'], [267, 'Warlock'],
  [71, 'Warrior'], [72, 'Warrior'], [73, 'Warrior'],
]);

// One personal defensive list per class, used as the default for every spec
// of that class. This is still an approximation (assumes talent trees let
// most specs reach most of a class's defensives), but some abilities are
// spec-locked regardless of talents — e.g. Warrior's Shield Wall requires
// Protection, Die by the Sword requires Arms/Fury, and neither talent tree
// can cross that line. Those cases need an explicit SPEC_OVERRIDES entry
// below rather than living in this shared list.
const CLASS_DEFENSIVES: Record<string, DefensiveAbility[]> = {
  // Vampiric Blood is Blood-only — see SPEC_OVERRIDES, which removes it for
  // Frost/Unholy.
  'Death Knight': [
    { abilityId: 48792, name: 'Icebound Fortitude', cooldownSeconds: 180 },
    { abilityId: 48707, name: 'Anti-Magic Shell', cooldownSeconds: 60 },
    { abilityId: 55233, name: 'Vampiric Blood', cooldownSeconds: 90 },
  ],
  'Demon Hunter': [
    { abilityId: 198589, name: 'Blur', cooldownSeconds: 60 },
    { abilityId: 196718, name: 'Darkness', cooldownSeconds: 180 },
    { abilityId: 187827, name: 'Metamorphosis', cooldownSeconds: 180 },
  ],
  // Survival Instincts and Frenzied Regeneration are Feral/Guardian only
  // (Balance/Restoration don't have them) — see SPEC_OVERRIDES.
  Druid: [
    { abilityId: 22812, name: 'Barkskin', cooldownSeconds: 60 },
    { abilityId: 61336, name: 'Survival Instincts', cooldownSeconds: 180 },
    { abilityId: 22842, name: 'Frenzied Regeneration', cooldownSeconds: 36 },
  ],
  Evoker: [
    { abilityId: 363916, name: 'Obsidian Scales', cooldownSeconds: 90 },
    { abilityId: 374348, name: 'Renewing Blaze', cooldownSeconds: 90 },
  ],
  Hunter: [
    { abilityId: 186265, name: 'Aspect of the Turtle', cooldownSeconds: 180 },
    { abilityId: 109304, name: 'Exhilaration', cooldownSeconds: 120 },
    { abilityId: 264735, name: 'Survival of the Fittest', cooldownSeconds: 180 },
  ],
  // Ice Cold and Alter Time are class-tree talents, available to all three
  // specs (like Ice Block). Each spec also has its own barrier — Frost gets
  // Ice Barrier, Fire gets Blazing Barrier, Arcane gets Prismatic Barrier —
  // added per spec via SPEC_OVERRIDES rather than here. All three barriers
  // share a 30s-per-charge cooldown (raised from 25s in a recent balance
  // pass) but commonly have 2 charges via an Improved-* talent, which our
  // simple last-cast model doesn't account for — a second banked charge can
  // make one "available" sooner than 30s after the last cast suggests.
  Mage: [
    { abilityId: 45438, name: 'Ice Block', cooldownSeconds: 240 },
    { abilityId: 414659, name: 'Ice Cold', cooldownSeconds: 180 },
    { abilityId: 108978, name: 'Alter Time', cooldownSeconds: 60 },
  ],
  Monk: [
    { abilityId: 115203, name: 'Fortifying Brew', cooldownSeconds: 180 },
    { abilityId: 122783, name: 'Diffuse Magic', cooldownSeconds: 90 },
  ],
  Paladin: [
    { abilityId: 642, name: 'Divine Shield', cooldownSeconds: 300 },
    { abilityId: 498, name: 'Divine Protection', cooldownSeconds: 60 },
    { abilityId: 86659, name: 'Guardian of Ancient Kings', cooldownSeconds: 300 },
    { abilityId: 31850, name: 'Ardent Defender', cooldownSeconds: 120 },
  ],
  // Dispersion is Shadow-only — see SPEC_OVERRIDES, which removes it for
  // Discipline/Holy.
  Priest: [
    { abilityId: 19236, name: 'Desperate Prayer', cooldownSeconds: 90 },
    { abilityId: 47585, name: 'Dispersion', cooldownSeconds: 120 },
  ],
  Rogue: [
    { abilityId: 31224, name: 'Cloak of Shadows', cooldownSeconds: 120 },
    { abilityId: 5277, name: 'Evasion', cooldownSeconds: 120 },
  ],
  Shaman: [
    { abilityId: 108271, name: 'Astral Shift', cooldownSeconds: 90 },
  ],
  Warlock: [
    { abilityId: 104773, name: 'Unending Resolve', cooldownSeconds: 180 },
    { abilityId: 108416, name: 'Dark Pact', cooldownSeconds: 60 },
  ],
  // Shield Wall (Protection-only) and Die by the Sword (Arms/Fury-only) are
  // mutually exclusive by spec — see SPEC_OVERRIDES, which removes whichever
  // one a given Warrior spec doesn't actually have.
  Warrior: [
    { abilityId: 871, name: 'Shield Wall', cooldownSeconds: 180 },
    { abilityId: 118038, name: 'Die by the Sword', cooldownSeconds: 120 },
  ],
};

interface SpecOverride {
  /** Ability IDs from the class's default list that this spec does NOT have. */
  remove?: number[];
  /** Spec-only abilities not in the class's default list. */
  add?: DefensiveAbility[];
}

// WCL specIDs (matches SPEC_ID_TO_CLASS/ROLE_BY_SPEC_ID elsewhere in this
// codebase): Warrior Arms 71/Fury 72/Protection 73; Death Knight Blood
// 250/Frost 251/Unholy 252; Druid Balance 102/Feral 103/Guardian 104/
// Restoration 105; Priest Discipline 256/Holy 257/Shadow 258; Mage Arcane
// 62/Fire 63/Frost 64.
const SPEC_OVERRIDES: Record<number, SpecOverride> = {
  71: { remove: [871] }, // Warrior Arms: no Shield Wall (Protection-only)
  72: { remove: [871] }, // Warrior Fury: no Shield Wall (Protection-only)
  73: { remove: [118038] }, // Warrior Protection: no Die by the Sword (Arms/Fury-only)
  251: { remove: [55233] }, // DK Frost: no Vampiric Blood (Blood-only)
  252: { remove: [55233] }, // DK Unholy: no Vampiric Blood (Blood-only)
  102: { remove: [61336, 22842] }, // Balance: no Survival Instincts/Frenzied Regeneration (Feral/Guardian-only)
  105: { remove: [61336, 22842] }, // Restoration: no Survival Instincts/Frenzied Regeneration (Feral/Guardian-only)
  256: { remove: [47585] }, // Discipline: no Dispersion (Shadow-only)
  257: { remove: [47585] }, // Holy: no Dispersion (Shadow-only)
  62: { add: [{ abilityId: 235450, name: 'Prismatic Barrier', cooldownSeconds: 30 }] }, // Arcane
  63: { add: [{ abilityId: 235313, name: 'Blazing Barrier', cooldownSeconds: 30 }] }, // Fire
  64: { add: [{ abilityId: 11426, name: 'Ice Barrier', cooldownSeconds: 30 }] }, // Frost
};

export function defensivesForSpecId(specId: number): DefensiveAbility[] {
  const className = SPEC_ID_TO_CLASS.get(specId);
  const base = className ? (CLASS_DEFENSIVES[className] ?? []) : [];
  const override = SPEC_OVERRIDES[specId];
  if (!override) return base;

  const removed = new Set(override.remove ?? []);
  return [...base.filter((ability) => !removed.has(ability.abilityId)), ...(override.add ?? [])];
}

// Healthstone consumption has used this ability ID for many expansions.
// Cooldown confirmed against Wowhead's current spell page (1 minute), not
// the older ~30 min value from past expansions.
export const HEALTHSTONE: DefensiveAbility = { abilityId: 6262, name: 'Healthstone', cooldownSeconds: 60 };

// Current-season healing potions, verified by pulling a real Hidden Lodge
// Venomous Abyss report's raw Casts events and cross-checking the ability
// IDs that actually appear against Wowhead (both confirmed present, both
// 5-minute cooldown per Wowhead). Two distinct potions are tracked because
// both are genuinely in use — raiders aren't all drinking the same one, and
// tracking only one would misreport for anyone using the other. Both share
// the standard "Potion" cooldown category — drinking either puts both on
// cooldown, confirmed by the user — hence the shared cooldownGroup. Re-verify
// against a real report if these stop matching what's actually cast (e.g.
// after a new season's potion replaces one of these).
export const HEALTH_POTIONS: DefensiveAbility[] = [
  { abilityId: 1234768, name: 'Silvermoon Health Potion', cooldownSeconds: 300, cooldownGroup: 'potion' },
  { abilityId: 1262857, name: 'Potent Healing Potion', cooldownSeconds: 300, cooldownGroup: 'potion' },
];
