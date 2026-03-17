export const prerender = false;

import type { APIContext } from 'astro';
import { getSessionId, deleteSession, clearSessionCookie } from '../../lib/auth';
import { env } from 'cloudflare:workers';

export async function GET(context: APIContext): Promise<Response> {
	const sessionId = getSessionId(context.request);

	if (sessionId) {
		await deleteSession(env.DB, sessionId);
	}

	return new Response(null, {
		status: 302,
		headers: {
			Location: '/',
			'Set-Cookie': clearSessionCookie(),
		},
	});
}
