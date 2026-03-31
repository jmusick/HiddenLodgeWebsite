export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { getLatestSimForRaider, getSimLaunchContextForRaider } from '../../../lib/sim-api';
import { isCharacterOwner } from '../../../lib/auth';

interface LaunchRequestBody {
  char_id: number;
  mode: 'site' | 'addon';
  addon_export?: string;
  sim_raid?: string;
  sim_difficulty?: string;
}

function readBaseUrl(): string | null {
  const base = env.WOWSIM_APP_BASE_URL?.trim();
  if (!base) return null;
  return base.replace(/\/+$/, '');
}

function readTriggerPath(): string {
  const raw = env.WOWSIM_APP_TRIGGER_PATH?.trim() || '/api/jobs/start';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  const apiKey = env.WOWSIM_APP_API_KEY?.trim();
  if (apiKey) headers['X-LodgeSim-Key'] = apiKey;
  return headers;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseBody(payload: unknown): { value: LaunchRequestBody | null; error?: string } {
  if (!payload || typeof payload !== 'object') {
    return { value: null, error: 'Payload must be a JSON object.' };
  }

  const record = payload as Record<string, unknown>;
  const charId = Number(record.char_id ?? NaN);
  const modeRaw = typeof record.mode === 'string' ? record.mode.trim().toLowerCase() : '';
  const mode = modeRaw === 'addon' ? 'addon' : modeRaw === 'site' ? 'site' : null;
  const addonExport = typeof record.addon_export === 'string' ? record.addon_export.trim() : '';

  const validRaids = new Set(['all', 'voidspire', 'dreamrift', 'queldanas']);
  const simRaidRaw = typeof record.sim_raid === 'string' ? record.sim_raid.trim().toLowerCase() : 'all';
  const simRaid = validRaids.has(simRaidRaw) ? simRaidRaw : 'all';

  const validDifficulties = new Set(['all', 'normal', 'heroic', 'mythic']);
  const simDifficultyRaw = typeof record.sim_difficulty === 'string' ? record.sim_difficulty.trim().toLowerCase() : 'all';
  const simDifficulty = validDifficulties.has(simDifficultyRaw) ? simDifficultyRaw : 'all';

  if (!Number.isInteger(charId) || charId <= 0) {
    return { value: null, error: 'char_id must be a positive integer.' };
  }
  if (!mode) {
    return { value: null, error: "mode must be either 'site' or 'addon'." };
  }
  if (mode === 'addon' && !addonExport) {
    return { value: null, error: 'addon_export is required when mode is addon.' };
  }
  if (addonExport.length > 200000) {
    return { value: null, error: 'addon_export is too large.' };
  }

  return {
    value: {
      char_id: charId,
      mode,
      addon_export: addonExport || undefined,
      sim_raid: simRaid,
      sim_difficulty: simDifficulty,
    },
  };
}

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.user || (!context.locals.isGuildMember && !context.locals.isAdmin)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const baseUrl = readBaseUrl();
  if (!baseUrl) {
    return Response.json(
        { error: 'LodgeSim app URL is not configured. Set WOWSIM_APP_BASE_URL.' },
      { status: 503 }
    );
  }

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = parseBody(payload);
  if (!parsed.value) {
    return Response.json({ error: parsed.error ?? 'Invalid payload.' }, { status: 400 });
  }

  if (!context.locals.isAdmin) {
    const ownsCharacter = await isCharacterOwner(env.DB, context.locals.user.id, parsed.value.char_id);
    if (!ownsCharacter) {
      return Response.json(
        { error: 'Only the character owner or an officer can start sims for this character.' },
        { status: 403 }
      );
    }
  }

  const launchContext = await getSimLaunchContextForRaider(env.DB, parsed.value.char_id);
  if (!launchContext) {
    return Response.json(
      { error: 'Raider is not assigned to an active raid team.' },
      { status: 404 }
    );
  }

  const triggerUrl = `${baseUrl}${readTriggerPath()}`;
  const configDifficulty = parsed.value.sim_difficulty === 'mythic' ? 'mythic' : 'heroic';
  const upstreamPayload = {
    char_id: parsed.value.char_id,
    char_name: launchContext.char_name,
    realm_slug: launchContext.realm_slug,
    region: 'us',
    site_team_id: launchContext.team_id,
    difficulty: configDifficulty,
    mode: parsed.value.mode,
    addon_export: parsed.value.mode === 'addon' ? parsed.value.addon_export ?? '' : null,
    sim_raid: parsed.value.sim_raid ?? 'all',
    sim_difficulty: parsed.value.sim_difficulty ?? 'all',
    requested_by_user_id: context.locals.user.id,
    requested_at_utc: new Date().toISOString(),
    source: 'hiddenlodgewebsite',
  };

  let upstreamStatus = 502;
  let upstreamJson: unknown = null;
  try {
    const upstream = await fetch(triggerUrl, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(upstreamPayload),
    });
    upstreamStatus = upstream.status;
    upstreamJson = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      return Response.json(
        {
          error: 'LodgeSim app rejected the launch request.',
          details: upstreamJson,
        },
        { status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502 }
      );
    }
  } catch (error) {
    return Response.json(
      {
        error: 'Could not reach LodgeSim app.',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 502 }
    );
  }

  const upstreamRecord = (upstreamJson ?? {}) as Record<string, unknown>;
  const jobIdRaw = upstreamRecord.job_id ?? upstreamRecord.id ?? upstreamRecord.run_id;
  const jobId = typeof jobIdRaw === 'string' ? jobIdRaw : null;

  if (!jobId) {
    return Response.json(
      {
        error: 'LodgeSim app response did not include a job identifier.',
        details: upstreamJson,
      },
      { status: 502 }
    );
  }

  const latest = await getLatestSimForRaider(env.DB, parsed.value.char_id);

  return Response.json({
    success: true,
    char_id: parsed.value.char_id,
    site_team_id: launchContext.team_id,
    difficulty: launchContext.difficulty,
    team_name: launchContext.team_name,
    job_id: jobId,
    upstream_status: upstreamStatus,
    status_poll_url: `/api/sim/launch/status?job_id=${encodeURIComponent(jobId)}&char_id=${parsed.value.char_id}`,
    latest,
  });
}

export async function GET(context: APIContext): Promise<Response> {
  if (!context.locals.user || (!context.locals.isGuildMember && !context.locals.isAdmin)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const baseUrl = readBaseUrl();
  if (!baseUrl) {
    return Response.json({
      online: false,
      remote_mode: true,
      message: 'Remote runner mode: website launch endpoint is disabled (WOWSIM_APP_BASE_URL not set).',
    });
  }

  try {
    const response = await fetchWithTimeout(
      `${baseUrl}${readTriggerPath()}`,
      {
        method: 'OPTIONS',
        headers: buildHeaders(),
      },
      2500
    );

    return Response.json({
      online: response.ok || response.status === 405 || response.status === 401,
      status: response.status,
      message: response.ok || response.status === 405 || response.status === 401
        ? 'Connected to LodgeSim launch endpoint.'
        : `LodgeSim responded with HTTP ${response.status}.`,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? 'Timed out while connecting to LodgeSim app.'
        : 'LodgeSim app is unreachable.';

    return Response.json({
      online: false,
      message,
    });
  }
}
