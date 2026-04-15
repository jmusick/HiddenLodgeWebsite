import fs from 'node:fs/promises';

const API_BASE = 'https://us.api.blizzard.com';
const STATIC_NAMESPACE = 'static-us';
const LOCALE = 'en_US';

const RAIDS = [
  { slug: 'voidspire', name: 'The Voidspire' },
  { slug: 'dreamrift', name: 'The Dreamrift' },
  { slug: 'queldanas', name: "March on Quel'Danas" },
];

function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

async function getAccessToken(clientId, clientSecret) {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    throw new Error(`Token request failed: ${response.status}`);
  }

  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error('Token request did not return an access token.');
  }

  return payload.access_token;
}

async function fetchJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }

  return response.json();
}

async function main() {
  const envText = await fs.readFile(new URL('../.dev.vars', import.meta.url), 'utf8');
  const env = parseEnv(envText);
  const accessToken = await getAccessToken(env.BLIZZARD_CLIENT_ID, env.BLIZZARD_CLIENT_SECRET);

  const indexUrl = `${API_BASE}/data/wow/journal-instance/index?namespace=${STATIC_NAMESPACE}&locale=${LOCALE}`;
  const indexData = await fetchJson(indexUrl, accessToken);
  const allInstances = Array.isArray(indexData.instances) ? indexData.instances : [];

  const output = [];

  for (const raid of RAIDS) {
    const instanceSummary = allInstances.find((entry) => entry?.name === raid.name);
    if (!instanceSummary?.id) {
      throw new Error(`Could not find journal instance for ${raid.name}`);
    }

    const instanceUrl = `${API_BASE}/data/wow/journal-instance/${instanceSummary.id}?namespace=${STATIC_NAMESPACE}&locale=${LOCALE}`;
    const instanceData = await fetchJson(instanceUrl, accessToken);
    const encounters = Array.isArray(instanceData.encounters) ? instanceData.encounters : [];

    const bosses = [];
    for (const encounter of encounters) {
      if (!encounter?.id) continue;
      const encounterUrl = `${API_BASE}/data/wow/journal-encounter/${encounter.id}?namespace=${STATIC_NAMESPACE}&locale=${LOCALE}`;
      const encounterData = await fetchJson(encounterUrl, accessToken);
      const itemIds = Array.isArray(encounterData.items)
        ? [...new Set(encounterData.items.map((entry) => Number(entry?.item?.id ?? 0)).filter((id) => id > 0))]
        : [];

      bosses.push({
        encounterId: Number(encounter.id),
        name: String(encounter.name ?? `Boss ${encounter.id}`),
        itemIds,
      });
    }

    output.push({
      raidSlug: raid.slug,
      raidName: raid.name,
      bosses,
    });
  }

  const outPath = new URL('../src/data/midnight-journal-data.json', import.meta.url);
  await fs.writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outPath.pathname}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});