// Central on/off switches for features currently on hiatus. Flip a value back
// to `true` to fully restore that feature — all gated pages/routes/nav items
// read from here, and the underlying code/data is left intact.
export const FEATURE_FLAGS = {
  rosterTeams: false,
  raidSignups: false,
  attendance: false,
  deathAnalysis: true,
  // Reads Death Analysis's canonical reports, so it also needs deathAnalysis on.
  mechanicsAnalysis: true,
  // Reads Bench's scoring (src/lib/bench.ts), so it also needs deathAnalysis on.
  raidComp: true,
  // Gates only the /parse-analysis page, its nav entry, and the profile Pull
  // Score panel — Raid Comp's own Pull Score sync/scoring runs whenever
  // deathAnalysis is on, regardless of this flag.
  parseAnalysis: true,
  applications: false,
  feedback: false,
  tools: true,
  sim: false,
} as const;
