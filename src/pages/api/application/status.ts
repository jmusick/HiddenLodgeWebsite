export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { getSessionUser } from '../../../lib/auth';

export async function GET(context: APIContext): Promise<Response> {
	const json = (data: unknown) =>
		new Response(JSON.stringify(data), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});

	const user = await getSessionUser(env.DB, context.request);
	if (!user) return json(null);

	// Match by battletag OR by character name (for guild members who skipped the battletag field)
	const row = await env.DB.prepare(
		`SELECT a.id, a.status, a.submitted_at
		 FROM applications a
		 WHERE (
		   (a.battletag != '' AND LOWER(a.battletag) = LOWER(?))
		   OR EXISTS (
		     SELECT 1 FROM application_characters ac
		     JOIN characters c ON LOWER(c.name) = LOWER(ac.char_name) AND c.realm_slug = ac.realm_slug
		     WHERE ac.application_id = a.id AND c.user_id = ?
		   )
		 )
		 ORDER BY a.submitted_at DESC
		 LIMIT 1`
	)
		.bind(user.battleTag, user.id)
		.first<{ id: number; status: string; submitted_at: number }>();

	if (!row) return json(null);

	return json({ id: row.id, status: row.status, submittedAt: row.submitted_at });
}
