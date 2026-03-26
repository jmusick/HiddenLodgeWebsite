import { env as cloudflareEnv } from 'cloudflare:workers';

interface BlizzardAuthConfig {
	clientId: string;
	clientSecret: string;
}

interface RaiderIoConfig {
	accessKey: string | null;
}

function readEnv(key: string): string | undefined {
	const runtimeValue = (cloudflareEnv as unknown as Record<string, string | undefined>)[key];
	if (runtimeValue && runtimeValue.trim()) {
		return runtimeValue;
	}

	const viteValue = (import.meta.env as Record<string, string | undefined>)[key];
	if (viteValue && viteValue.trim()) {
		return viteValue;
	}

	return undefined;
}

function assertValidUri(value: string, key: string): void {
	try {
		new URL(value);
	} catch {
		throw new Error(`${key} must be a valid absolute URI.`);
	}
}

function isLocalOrigin(origin: string): boolean {
	const hostname = new URL(origin).hostname;
	return hostname === 'localhost' || hostname === '127.0.0.1';
}

export function getBlizzardAuthConfig(): BlizzardAuthConfig {
	const clientId = readEnv('BLIZZARD_CLIENT_ID');
	const clientSecret = readEnv('BLIZZARD_CLIENT_SECRET');

	if (!clientId) throw new Error('BLIZZARD_CLIENT_ID is missing.');
	if (!clientSecret) throw new Error('BLIZZARD_CLIENT_SECRET is missing.');

	return {
		clientId,
		clientSecret,
	};
}

export function getBlizzardRedirectUri(requestUrl: string): string {
	const fallback = new URL('/auth/callback', requestUrl).toString();
	assertValidUri(fallback, 'Computed redirect URI');

	const configured = readEnv('BLIZZARD_REDIRECT_URI');
	if (configured) {
		assertValidUri(configured, 'BLIZZARD_REDIRECT_URI');

		const configuredOrigin = new URL(configured).origin;
		const fallbackOrigin = new URL(fallback).origin;
		if (configuredOrigin === fallbackOrigin || isLocalOrigin(fallbackOrigin)) {
			return configured;
		}
	}

	return fallback;
}

export function getRaiderIoConfig(): RaiderIoConfig {
	const accessKey = readEnv('RAIDER_IO_ACCESS_KEY');

	return {
		accessKey: accessKey?.trim() || null,
	};
}
