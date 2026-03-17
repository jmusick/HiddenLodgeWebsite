import type { D1Database } from '@cloudflare/workers-types';

export interface SessionUser {
	id: number;
	battleTag: string;
	blizzardId: number;
}

const SESSION_COOKIE = 'hl_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export function getSessionId(request: Request): string | null {
	const cookie = request.headers.get('cookie') ?? '';
	const match = cookie.match(/hl_session=([^;]+)/);
	return match ? match[1] : null;
}

export async function getSessionUser(db: D1Database, request: Request): Promise<SessionUser | null> {
	const sessionId = getSessionId(request);
	if (!sessionId) return null;

	const now = Math.floor(Date.now() / 1000);
	const row = await db
		.prepare(`
			SELECT u.id, u.battle_tag, u.blizzard_id
			FROM sessions s
			JOIN users u ON u.id = s.user_id
			WHERE s.id = ? AND s.expires_at > ?
		`)
		.bind(sessionId, now)
		.first<{ id: number; battle_tag: string; blizzard_id: number }>();

	if (!row) return null;
	return { id: row.id, battleTag: row.battle_tag, blizzardId: row.blizzard_id };
}

export async function createSession(db: D1Database, userId: number): Promise<string> {
	const sessionId = crypto.randomUUID();
	const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
	await db
		.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
		.bind(sessionId, userId, expiresAt)
		.run();
	return sessionId;
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
	await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

export function makeSessionCookie(sessionId: string): string {
	return `${SESSION_COOKIE}=${sessionId}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SECONDS}; SameSite=Lax`;
}

export function clearSessionCookie(): string {
	return `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}
