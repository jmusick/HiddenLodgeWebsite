// Central on/off switches for features currently on hiatus. Flip a value back
// to `true` to fully restore that feature — all gated pages/routes/nav items
// read from here, and the underlying code/data is left intact.
export const FEATURE_FLAGS = {
  rosterTeams: false,
  raidSignups: false,
  attendance: false,
  applications: false,
  feedback: false,
  tools: false,
  sim: false,
} as const;
