export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';

function realmToSlug(name: string): string {
	return name.toLowerCase().replace(/'/g, '').replace(/\s+/g, '-');
}

interface CharInput {
	name: string;
	realm: string;
	realmSlug?: string;
}

export async function POST(context: APIContext): Promise<Response> {
	const json = (data: unknown, status = 200) =>
		new Response(JSON.stringify(data), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});

	try {

	let body: {
		discord_username?: string;
		battletag?: string;
		raid_history?: string;
		goals?: string;
		characters?: CharInput[];
	};

	try {
		body = await context.request.json();
	} catch {
		return json({ error: 'Invalid request body.' }, 400);
	}

	const discordUsername = (body.discord_username ?? '').trim();
	if (!discordUsername) {
		return json({ error: 'Discord username is required.' }, 400);
	}

	const characters = (body.characters ?? []).filter((c) => c?.name?.trim());
	if (!characters.length) {
		return json({ error: 'At least one character name is required.' }, 400);
	}

	const battletag = (body.battletag ?? '').trim();
	if (!battletag) {
		return json({ error: 'A Battle.net Tag is required.' }, 400);
	}
	const raidHistory = (body.raid_history ?? '').trim();
	const goals = (body.goals ?? '').trim();

	const insertApp = await env.DB.prepare(
		`INSERT INTO applications (discord_username, battletag, raid_history, goals)
		 VALUES (?, ?, ?, ?)`
	)
		.bind(discordUsername, battletag, raidHistory, goals)
		.run();

	const applicationId = insertApp.meta.last_row_id;

	await env.DB.batch(
		characters.map((char, i) =>
			env.DB.prepare(
				`INSERT INTO application_characters (application_id, char_name, realm, realm_slug, is_main)
				 VALUES (?, ?, ?, ?, ?)`
			).bind(
				applicationId,
				char.name.trim(),
				(char.realm ?? '').trim(),
				char.realmSlug?.trim() || realmToSlug(char.realm ?? ''),
				i === 0 ? 1 : 0
			)
		)
	);

	return json({ ok: true, id: applicationId });
	} catch (err) {
		console.error('apply error:', err);
		return json({ error: 'An unexpected error occurred. Please try again.' }, 500);
	}
}
