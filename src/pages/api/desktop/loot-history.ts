export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { isAuthorizedDesktopRequest } from '../../../lib/desktop-auth';
import { isMidnightSeasonOneRaid } from '../../../lib/midnight-season-one';

interface LootHistoryInputEntry {
	entryKey?: string;
	sourceId?: string;
	factionRealm?: string;
	ownerFullName?: string;
	ownerName?: string;
	ownerRealm?: string;
	class?: string;
	mapId?: number | null;
	difficultyId?: number | null;
	instance?: string;
	boss?: string;
	groupSize?: number | null;
	date?: string;
	time?: string;
	response?: string;
	responseId?: string;
	typeCode?: string;
	note?: string;
	lootWon?: string;
	itemId?: number | null;
	itemName?: string | null;
	iClass?: number | null;
	iSubClass?: number | null;
	isAwardReason?: boolean;
}

interface CharacterLookupRow {
	blizzard_char_id: number;
	name: string;
	realm: string;
}

const ITEM_ID_PATTERN = /\|Hitem:(\d+)\b/i;
const ITEM_NAME_PATTERN = /\|h\[([^\]]+)\]\|h/i;
const SEASON_ONE_CUTOFF_DATE = '2026/03/17';
const SEASON_ONE_CUTOFF_EPOCH = 1773705600;

function asString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function asIntOrNull(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === 'string') {
		const n = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(n)) return n;
	}
	return null;
}

function normalizeRealm(realm: string): string {
	return realm.toLowerCase().replace(/\s+/g, '').replace(/[-']/g, '');
}

function normalizeName(name: string): string {
	return name.trim().toLowerCase();
}

function normalizedOwnerKey(name: string, realm: string): string {
	const n = normalizeName(name);
	const r = normalizeRealm(realm);
	return `${n}-${r}`;
}

function parseAwardedAtEpoch(dateValue: string, timeValue: string): number | null {
	if (!dateValue || !timeValue) return null;

	const dateMatch = dateValue.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
	const timeMatch = timeValue.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
	if (!dateMatch || !timeMatch) return null;

	const year = Number.parseInt(dateMatch[1], 10);
	const month = Number.parseInt(dateMatch[2], 10);
	const day = Number.parseInt(dateMatch[3], 10);
	const hour = Number.parseInt(timeMatch[1], 10);
	const minute = Number.parseInt(timeMatch[2], 10);
	const second = Number.parseInt(timeMatch[3] ?? '0', 10);

	if ([year, month, day, hour, minute, second].some((n) => !Number.isFinite(n))) return null;
	const epoch = Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1000);
	return Number.isFinite(epoch) ? epoch : null;
}

function isOnOrAfterSeasonOneCutoff(dateValue: string, timeValue: string, awardedAtEpoch: number | null): boolean {
	if (typeof awardedAtEpoch === 'number' && Number.isFinite(awardedAtEpoch)) {
		return awardedAtEpoch >= SEASON_ONE_CUTOFF_EPOCH;
	}

	if (!dateValue) return false;
	return dateValue >= SEASON_ONE_CUTOFF_DATE;
}

function extractItemFromLootLink(lootLink: string): { itemId: number | null; itemName: string } {
	const itemIdMatch = lootLink.match(ITEM_ID_PATTERN);
	const itemNameMatch = lootLink.match(ITEM_NAME_PATTERN);

	const itemId = itemIdMatch ? Number.parseInt(itemIdMatch[1], 10) : null;
	const itemName = (itemNameMatch?.[1] ?? '').trim();

	return {
		itemId: Number.isFinite(itemId ?? Number.NaN) ? itemId : null,
		itemName,
	};
}

function normalizeKeyToken(value: string): string {
	return value.trim().toLowerCase();
}

function canonicalEntryKey(entry: LootHistoryInputEntry, awardedAtEpoch: number | null, lootWon: string): string {
	const sourceId = asString(entry.sourceId);
	const ownerFullName = asString(entry.ownerFullName);
	const ownerName = asString(entry.ownerName);
	const ownerRealm = asString(entry.ownerRealm);

	if (sourceId && ownerFullName) {
		return ['src', ownerFullName, sourceId].map(normalizeKeyToken).join('|');
	}

	if (sourceId && ownerName) {
		return ['src-fallback', ownerName, ownerRealm, sourceId].map(normalizeKeyToken).join('|');
	}

	if (typeof awardedAtEpoch === 'number' && Number.isFinite(awardedAtEpoch) && awardedAtEpoch > 0) {
		return ['ts', ownerName, ownerRealm, String(awardedAtEpoch), lootWon].map(normalizeKeyToken).join('|');
	}

	const provided = asString(entry.entryKey);
	if (provided) return provided;

	return ['fallback', ownerName, ownerRealm, lootWon].map(normalizeKeyToken).join('|');
}

function toValidatedEntry(raw: unknown): LootHistoryInputEntry | null {
	if (!raw || typeof raw !== 'object') return null;
	const obj = raw as Record<string, unknown>;

	const entryKey = asString(obj.entryKey);
	const lootWon = asString(obj.lootWon);
	const ownerFullName = asString(obj.ownerFullName);
	let ownerName = asString(obj.ownerName);
	let ownerRealm = asString(obj.ownerRealm);

	if (!ownerName && ownerFullName.includes('-')) {
		const [namePart, ...realmParts] = ownerFullName.split('-');
		ownerName = namePart.trim();
		ownerRealm = realmParts.join('-').trim();
	}

	if (!lootWon || (!ownerFullName && !ownerName)) return null;

	return {
		entryKey,
		sourceId: asString(obj.sourceId),
		factionRealm: asString(obj.factionRealm),
		ownerFullName: ownerFullName || `${ownerName}-${ownerRealm}`,
		ownerName,
		ownerRealm,
		class: asString(obj.class),
		mapId: asIntOrNull(obj.mapId),
		difficultyId: asIntOrNull(obj.difficultyId),
		instance: asString(obj.instance),
		boss: asString(obj.boss),
		groupSize: asIntOrNull(obj.groupSize),
		date: asString(obj.date),
		time: asString(obj.time),
		response: asString(obj.response),
		responseId: asString(obj.responseId),
		typeCode: asString(obj.typeCode),
		note: asString(obj.note),
		lootWon,
		itemId: asIntOrNull(obj.itemId),
		itemName: asString(obj.itemName),
		iClass: asIntOrNull(obj.iClass),
		iSubClass: asIntOrNull(obj.iSubClass),
		isAwardReason: obj.isAwardReason === true,
	};
}

export async function POST(context: APIContext): Promise<Response> {
	if (!isAuthorizedDesktopRequest(context.request)) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 });
	}

	let payload: unknown;
	try {
		payload = await context.request.json();
	} catch {
		return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
	}

	const entriesRaw = (payload as { entries?: unknown })?.entries;
	if (!Array.isArray(entriesRaw)) {
		return Response.json({ error: 'Expected payload.entries to be an array.' }, { status: 400 });
	}

	const validated = entriesRaw.map(toValidatedEntry).filter((entry): entry is LootHistoryInputEntry => entry !== null);
	if (validated.length === 0) {
		return Response.json({ accepted: 0, received: entriesRaw.length });
	}

	const [characterRows, rosterRows] = await env.DB.batch([
		env.DB.prepare(
			`SELECT DISTINCT blizzard_char_id, name, realm
			 FROM characters`
		),
		env.DB.prepare(
			`SELECT DISTINCT blizzard_char_id, name, realm
			 FROM roster_members_cache`
		),
	]);

	const charIdByOwner = new Map<string, number>();
	const charIdsByName = new Map<string, Set<number>>();
	const allRows = [
		...((characterRows.results ?? []) as CharacterLookupRow[]),
		...((rosterRows.results ?? []) as CharacterLookupRow[]),
	];

	for (const row of allRows) {
		const key = normalizedOwnerKey(row.name, row.realm);
		if (!charIdByOwner.has(key)) {
			charIdByOwner.set(key, row.blizzard_char_id);
		}

		const nameKey = normalizeName(row.name);
		const ids = charIdsByName.get(nameKey) ?? new Set<number>();
		ids.add(row.blizzard_char_id);
		charIdsByName.set(nameKey, ids);
	}

	const seenCanonicalKeys = new Set<string>();
	const statements = validated.map((entry) => {
		const ownerName = asString(entry.ownerName);
		const ownerRealm = asString(entry.ownerRealm);
		const instanceName = asString(entry.instance);
		const fullKey = normalizedOwnerKey(ownerName, ownerRealm);
		let charId = charIdByOwner.get(fullKey) ?? null;
		if (charId === null) {
			const ids = charIdsByName.get(normalizeName(ownerName));
			if (ids && ids.size === 1) {
				charId = Array.from(ids)[0] ?? null;
			}
		}
		const awardedAtEpoch = parseAwardedAtEpoch(asString(entry.date), asString(entry.time));
		if (!isOnOrAfterSeasonOneCutoff(asString(entry.date), asString(entry.time), awardedAtEpoch)) {
			return null;
		}
		if (!isMidnightSeasonOneRaid(instanceName)) {
			return null;
		}

		const lootWon = asString(entry.lootWon);
		const canonicalKey = canonicalEntryKey(entry, awardedAtEpoch, lootWon);
		if (seenCanonicalKeys.has(canonicalKey)) {
			return null;
		}
		seenCanonicalKeys.add(canonicalKey);
		const extractedItem = extractItemFromLootLink(lootWon);
		const effectiveItemId = entry.itemId ?? extractedItem.itemId;
		const effectiveItemName = asString(entry.itemName) || extractedItem.itemName;

		if (effectiveItemId === null && effectiveItemName === '') {
			return null;
		}

		return env.DB.prepare(
			`INSERT INTO loot_history (
				entry_key,
				source_id,
				faction_realm,
				owner_full_name,
				owner_name,
				owner_realm,
				owner_blizzard_char_id,
				class_name,
				map_id,
				difficulty_id,
				instance_name,
				boss_name,
				group_size,
				awarded_date,
				awarded_time,
				awarded_at_epoch,
				response_text,
				response_id,
				type_code,
				note_text,
				loot_won_link,
				item_id,
				item_name,
				item_class_id,
				item_sub_class_id,
				is_award_reason,
				synced_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
			ON CONFLICT(entry_key) DO UPDATE SET
				source_id = excluded.source_id,
				faction_realm = excluded.faction_realm,
				owner_full_name = excluded.owner_full_name,
				owner_name = excluded.owner_name,
				owner_realm = excluded.owner_realm,
				owner_blizzard_char_id = excluded.owner_blizzard_char_id,
				class_name = excluded.class_name,
				map_id = excluded.map_id,
				difficulty_id = excluded.difficulty_id,
				instance_name = excluded.instance_name,
				boss_name = excluded.boss_name,
				group_size = excluded.group_size,
				awarded_date = excluded.awarded_date,
				awarded_time = excluded.awarded_time,
				awarded_at_epoch = excluded.awarded_at_epoch,
				response_text = excluded.response_text,
				response_id = excluded.response_id,
				type_code = excluded.type_code,
				note_text = excluded.note_text,
				loot_won_link = excluded.loot_won_link,
				item_id = excluded.item_id,
				item_name = excluded.item_name,
				item_class_id = excluded.item_class_id,
				item_sub_class_id = excluded.item_sub_class_id,
				is_award_reason = excluded.is_award_reason,
				synced_at = unixepoch()`
		).bind(
			canonicalKey,
			asString(entry.sourceId),
			asString(entry.factionRealm),
			asString(entry.ownerFullName),
			ownerName,
			ownerRealm,
			charId,
			asString(entry.class),
			entry.mapId,
			entry.difficultyId,
			instanceName,
			asString(entry.boss),
			entry.groupSize,
			asString(entry.date),
			asString(entry.time),
			awardedAtEpoch,
			asString(entry.response),
			asString(entry.responseId),
			asString(entry.typeCode),
			asString(entry.note),
			lootWon,
			effectiveItemId,
			effectiveItemName,
			entry.iClass,
			entry.iSubClass,
			entry.isAwardReason ? 1 : 0
		);
	}).filter((statement): statement is NonNullable<typeof statement> => statement !== null);

	if (statements.length === 0) {
		return Response.json({
			received: entriesRaw.length,
			accepted: 0,
		});
	}

	await env.DB.batch(statements);

	return Response.json({
		received: entriesRaw.length,
		accepted: statements.length,
	});
}
