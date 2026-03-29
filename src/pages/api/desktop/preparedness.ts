export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { isAuthorizedDesktopRequest } from '../../../lib/desktop-auth';

// ---- Row types (same source columns as admin/export.astro) ----

interface CharRow {
	name: string;
	realm: string;
	socketed_gems: number | null;
	total_sockets: number | null;
	enchanted_slots: number | null;
	enchantable_slots: number | null;
	avg_30d_socketed_gems: number | null;
	avg_30d_total_sockets: number | null;
	avg_30d_enchanted_slots: number | null;
	avg_30d_enchantable_slots: number | null;
}

// ---- Preparedness tier calculation (mirrors export.astro) ----

function preparednessTier(char: CharRow): string {
	const socketedGems = char.avg_30d_socketed_gems ?? char.socketed_gems;
	const totalSockets = char.avg_30d_total_sockets ?? char.total_sockets;
	const enchantedSlots = char.avg_30d_enchanted_slots ?? char.enchanted_slots;
	const enchantableSlots = char.avg_30d_enchantable_slots ?? char.enchantable_slots;

	if (socketedGems === null || totalSockets === null || enchantedSlots === null || enchantableSlots === null) {
		return '—';
	}

	const filled = socketedGems + enchantedSlots;
	const total = totalSockets + enchantableSlots;
	if (total === 0) return 'N/A';

	const pct = filled / total;
	if (pct >= 1) return 'S Tier';
	if (pct >= 0.85) return 'A Tier';
	if (pct >= 0.7) return 'B Tier';
	if (pct >= 0.4) return 'C Tier';
	return 'D Tier';
}

// ---- Handler ----

export async function GET(context: APIContext): Promise<Response> {
	if (!isAuthorizedDesktopRequest(context.request)) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 });
	}

	const result = await env.DB.prepare(`
		SELECT
			c.name,
			c.realm,
			mc.socketed_gems,
			mc.total_sockets,
			mc.enchanted_slots,
			mc.enchantable_slots,
			mc.avg_30d_socketed_gems,
			mc.avg_30d_total_sockets,
			mc.avg_30d_enchanted_slots,
			mc.avg_30d_enchantable_slots
		FROM characters c
		JOIN roster_members_cache rmc ON rmc.blizzard_char_id = c.blizzard_char_id
		LEFT JOIN raider_metrics_cache mc ON mc.blizzard_char_id = c.blizzard_char_id
		ORDER BY c.name ASC
	`).all<CharRow>();

	const entries = (result.results ?? []).map((char) => ({
		character: char.name,
		realm: char.realm,
		preparednessTier: preparednessTier(char),
	}));

	return Response.json(entries);
}
