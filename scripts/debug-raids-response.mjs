const token = 'USQ4Kt1d4uWPKaRq6i66EILHeTJgWyLe1u';
const url = 'https://us.api.blizzard.com/profile/wow/character/malganis/beastndesist/encounters/raids?namespace=profile-us&locale=en_US';

const res = await fetch(url, {
  headers: { Authorization: `Bearer ${token}` },
});

console.log('status', res.status);
const data = await res.json();
console.log('top-level keys', Object.keys(data));
console.log('expansions length', data.expansions?.length ?? 0);

for (const expansion of data.expansions ?? []) {
  for (const instance of expansion.instances ?? []) {
    const instanceName = instance.instance?.name ?? instance.name ?? '(unknown instance)';
    console.log('\nRAID', instanceName);
    for (const mode of instance.modes ?? []) {
      const difficulty = mode.difficulty?.type ?? 'unknown';
      const kills = mode.progress?.completed_count ?? null;
      const total = mode.progress?.total_count ?? null;
      const latest = Math.max(0, ...((mode.progress?.encounters ?? []).map((e) => Number(e.completed_timestamp ?? 0))));
      console.log('  mode', difficulty, 'kills', kills, 'total', total, 'latest', latest);
    }
  }
}
