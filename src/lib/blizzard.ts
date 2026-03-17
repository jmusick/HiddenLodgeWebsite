const OAUTH_BASE = 'https://oauth.battle.net';
const API_BASE = 'https://us.api.blizzard.com';

export function buildAuthUrl(clientId: string, redirectUri: string, state: string): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: 'wow.profile',
		state,
	});
	return `${OAUTH_BASE}/authorize?${params}`;
}

export async function exchangeCode(
	clientId: string,
	clientSecret: string,
	code: string,
	redirectUri: string
): Promise<{ access_token: string; expires_in: number }> {
	const res = await fetch(`${OAUTH_BASE}/token`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
		},
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
		}),
	});
	if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
	return res.json();
}

export async function getUserInfo(accessToken: string): Promise<{ id: number; battletag: string }> {
	const res = await fetch(`${OAUTH_BASE}/userinfo`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!res.ok) throw new Error(`Userinfo request failed: ${res.status}`);
	return res.json();
}

export interface WowCharacter {
	blizzardCharId: number;
	name: string;
	realm: string;
	realmSlug: string;
	className: string;
	raceName: string;
	faction: string;
	level: number;
}

export async function getWowCharacters(accessToken: string): Promise<WowCharacter[]> {
	const res = await fetch(
		`${API_BASE}/profile/user/wow?namespace=profile-us&locale=en_US`,
		{ headers: { Authorization: `Bearer ${accessToken}` } }
	);
	if (!res.ok) return [];

	const data: any = await res.json();
	const characters: WowCharacter[] = [];

	for (const account of data.wow_accounts ?? []) {
		for (const char of account.characters ?? []) {
			characters.push({
				blizzardCharId: char.id,
				name: char.name,
				realm: char.realm?.name ?? '',
				realmSlug: char.realm?.slug ?? '',
				className: char.playable_class?.name ?? 'Unknown',
				raceName: char.playable_race?.name ?? 'Unknown',
				faction: char.faction?.name ?? 'Unknown',
				level: char.level ?? 0,
			});
		}
	}

	return characters;
}
