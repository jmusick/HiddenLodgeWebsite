export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

export async function POST(context: APIContext): Promise<Response> {
	if (!context.locals.isAdmin) {
		return new Response('Forbidden', { status: 403 });
	}

	const formData = await context.request.formData();
	const blizzardCharId = parseInt(formData.get('blizzard_char_id') as string, 10);
	const noteText = (formData.get('note_text') as string | null)?.trim() ?? '';

	if (isNaN(blizzardCharId) || !noteText) {
		return new Response(null, { status: 302, headers: { Location: '/admin/mains?status=error' } });
	}

	// Verify the character is in the roster
	const inRoster = await env.DB.prepare(
		`SELECT 1 FROM roster_members_cache WHERE blizzard_char_id = ? LIMIT 1`
	)
		.bind(blizzardCharId)
		.first();

	if (!inRoster) {
		return new Response(null, { status: 302, headers: { Location: '/admin/mains?status=error' } });
	}

	await env.DB.prepare(
		`INSERT INTO raider_notes (blizzard_char_id, author_user_id, note_text) VALUES (?, ?, ?)`
	)
		.bind(blizzardCharId, context.locals.user!.id, noteText)
		.run();

	return new Response(null, {
		status: 302,
		headers: { Location: '/admin/mains?status=note-added' },
	});
}
