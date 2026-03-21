const OAUTH_BASE = 'https://oauth.battle.net';

type TokenCacheEntry = {
  accessToken: string;
  expiresAt: number;
};

const tokenCacheByClientId = new Map<string, TokenCacheEntry>();

interface BlizzardClientCredentialsTokenResponse {
  access_token?: string;
  expires_in?: number;
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export async function getBlizzardAppAccessToken(
  clientId?: string,
  clientSecret?: string
): Promise<string | null> {
  if (!clientId || !clientSecret) {
    return null;
  }

  const now = nowInSeconds();
  const cached = tokenCacheByClientId.get(clientId);
  if (cached && cached.expiresAt > now) {
    return cached.accessToken;
  }

  const credentials = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch(`${OAUTH_BASE}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as BlizzardClientCredentialsTokenResponse;
  if (!data.access_token) {
    return null;
  }

  const ttlSeconds = Math.max(60, Number(data.expires_in ?? 0) || 0);
  tokenCacheByClientId.set(clientId, {
    accessToken: data.access_token,
    expiresAt: now + Math.max(60, ttlSeconds - 60),
  });

  return data.access_token;
}
