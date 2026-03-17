export const prerender = false;

import type { APIContext } from 'astro';
import { buildAuthUrl } from '../../lib/blizzard';
import { getBlizzardAuthConfig, getBlizzardRedirectUri } from '../../lib/runtime-env';

export async function GET(context: APIContext): Promise<Response> {
	let authConfig;
	try {
		authConfig = getBlizzardAuthConfig();
	} catch (error) {
		console.error('Missing Blizzard auth config:', error);
		return new Response('Server auth configuration is incomplete.', { status: 500 });
	}

	const state = crypto.randomUUID();
	const redirectUri = getBlizzardRedirectUri(context.request.url);
	const url = buildAuthUrl(authConfig.clientId, redirectUri, state);

	const headers = new Headers({
		Location: url,
		// Short-lived state cookie for CSRF validation in /auth/callback
		'Set-Cookie': `hl_oauth_state=${state}; HttpOnly; Path=/; Max-Age=300; SameSite=Lax`,
	});

	return new Response(null, { status: 302, headers });
}
