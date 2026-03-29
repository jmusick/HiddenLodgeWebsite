import { env as cloudflareEnv } from 'cloudflare:workers';

const HEADER = 'X-Desktop-Key';

function readEnv(key: string): string | undefined {
	const runtimeValue = (cloudflareEnv as unknown as Record<string, string | undefined>)[key];
	if (runtimeValue?.trim()) return runtimeValue;
	const viteValue = (import.meta.env as Record<string, string | undefined>)[key];
	if (viteValue?.trim()) return viteValue;
	return undefined;
}

export function isAuthorizedDesktopRequest(request: Request): boolean {
	const expectedKey = readEnv('DESKTOP_API_KEY');
	if (!expectedKey) return false;
	const provided = request.headers.get(HEADER);
	if (!provided) return false;
	return provided === expectedKey;
}
