export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

export async function POST(context: APIContext): Promise<Response> {
	// isAdmin is guaranteed by middleware for all /api/admin/* routes
	const user = context.locals.user!;

	let body: { id?: unknown; note?: unknown };
	try {
		body = await context.request.json();
	} catch {
		return Response.json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const rawId = body.id;
	const id = typeof rawId === 'number' ? rawId : Number.parseInt(String(rawId ?? ''), 10);
	const note = typeof body.note === 'string' ? body.note.trim() : '';

	if (!Number.isFinite(id) || id <= 0) {
		return Response.json({ error: 'Invalid id' }, { status: 400 });
	}
	if (!note) {
		return Response.json({ error: 'A note is required when excluding an entry.' }, { status: 400 });
	}

	const result = await env.DB.prepare(
		`UPDATE loot_history
		 SET is_excluded = 1,
		     exclude_note = ?,
		     excluded_by_user_id = ?,
		     excluded_at = unixepoch()
		 WHERE id = ? AND is_excluded = 0`
	)
		.bind(note, user.id, id)
		.run();

	if (result.meta.changes === 0) {
		return Response.json({ error: 'Entry not found or already excluded.' }, { status: 404 });
	}

	return Response.json({ ok: true });
}
