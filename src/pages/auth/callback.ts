export const prerender = false;

import type { APIContext } from 'astro';
import { exchangeCode, getUserInfo, getWowCharacters } from '../../lib/blizzard';
import { createSession, makeSessionCookie } from '../../lib/auth';
import { env } from 'cloudflare:workers';
import { getBlizzardAuthConfig, getBlizzardRedirectUri } from '../../lib/runtime-env';

export async function GET(context: APIContext): Promise<Response> {
	const url = new URL(context.request.url);

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');

	// CSRF: validate the state parameter against the cookie
	const cookieHeader = context.request.headers.get('cookie') ?? '';
	const storedState = cookieHeader.match(/hl_oauth_state=([^;]+)/)?.[1] ?? null;

	if (!code || !state || !storedState || state !== storedState) {
		return new Response('Invalid or missing OAuth state. Please try logging in again.', {
			status: 400,
		});
	}

	const isPopup = state.startsWith('popup:');

	let authConfig;
	try {
		authConfig = getBlizzardAuthConfig();
	} catch (error) {
		console.error('Missing Blizzard auth config:', error);
		return new Response('Server auth configuration is incomplete.', { status: 500 });
	}

	try {
		const tokens = await exchangeCode(
			authConfig.clientId,
			authConfig.clientSecret,
			code,
			getBlizzardRedirectUri(context.request.url)
		);

		const blizzardUser = await getUserInfo(tokens.access_token);
		const tokenExpiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;

		// Upsert user record
		await env.DB.prepare(`
			INSERT INTO users (blizzard_id, battle_tag, access_token, token_expires_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(blizzard_id) DO UPDATE SET
				battle_tag       = excluded.battle_tag,
				access_token     = excluded.access_token,
				token_expires_at = excluded.token_expires_at,
				updated_at       = unixepoch()
		`)
			.bind(blizzardUser.id, blizzardUser.battletag, tokens.access_token, tokenExpiresAt)
			.run();

		const user = await env.DB.prepare('SELECT id FROM users WHERE blizzard_id = ?')
			.bind(blizzardUser.id)
			.first<{ id: number }>();

		if (!user) throw new Error('User not found after upsert');

		// Sync WoW characters from the Battle.net profile API
		const characters = await getWowCharacters(tokens.access_token);
		for (const char of characters) {
			await env.DB.prepare(`
				INSERT INTO characters
					(user_id, blizzard_char_id, name, realm, realm_slug, class_name, race_name, faction, level, last_synced)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
				ON CONFLICT(user_id, blizzard_char_id) DO UPDATE SET
					name        = excluded.name,
					realm       = excluded.realm,
					realm_slug  = excluded.realm_slug,
					class_name  = excluded.class_name,
					race_name   = excluded.race_name,
					faction     = excluded.faction,
					level       = excluded.level,
					last_synced = unixepoch()
			`)
				.bind(
					user.id,
					char.blizzardCharId,
					char.name,
					char.realm,
					char.realmSlug,
					char.className,
					char.raceName,
					char.faction,
					char.level
				)
				.run();
		}

		// Create session for both popup and regular flows
		const sessionId = await createSession(env.DB, user.id);
		const sessionCookie = makeSessionCookie(sessionId);
		const clearState = 'hl_oauth_state=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax';

		if (isPopup) {
			// Popup flow: return HTML that postMessages session ID and battletag to parent
			// Parent will set the cookie, update button, and reload
			const html = `<!DOCTYPE html><html><head><title>Blizzard Login</title>
<style>body{font-family:sans-serif;background:#0b1520;color:#d8e2e8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}</style>
</head><body><p>Logged in — returning to application form…</p>
<script>(function(){
var sessionId = '${sessionId}';
var battletag = '${blizzardUser.battletag}';
if(window.opener && window.opener !== window) {
  try{
    window.opener.postMessage({type:'blizzard-auth',battletag:battletag,characters:[],sessionId:sessionId},window.location.origin);
  }catch(_){}
  setTimeout(function(){window.close();},500);
}
})();<\/script></body></html>`;

			return new Response(html, {
				status: 200,
				headers: {
					'Content-Type': 'text/html;charset=utf-8',
					'Set-Cookie': clearState,
				},
			});
		}

		const resHeaders = new Headers({ Location: '/profile' });
		resHeaders.append('Set-Cookie', sessionCookie);
		// Clear the state cookie
		resHeaders.append('Set-Cookie', 'hl_oauth_state=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');

		return new Response(null, { status: 302, headers: resHeaders });
	} catch (err) {
		console.error('OAuth callback error:', err);
		return new Response('Authentication failed. Please try again.', { status: 500 });
	}
}
