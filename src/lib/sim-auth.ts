import { env as cloudflareEnv } from 'cloudflare:workers';

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

export function getSimRunnerKey(): string | null {
  return readEnv('SIM_RUNNER_KEY') ?? null;
}

export function isAuthorizedSimRunnerRequest(request: Request): boolean {
  const expectedKey = getSimRunnerKey();
  if (!expectedKey) return false;

  const provided = request.headers.get('X-Sim-Runner-Key');
  if (!provided) return false;

  return provided === expectedKey;
}
