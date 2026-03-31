export const prerender = false;

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { getLatestSimForRaider } from '../../../../lib/sim-api';

type NormalizedRunStatus = 'queued' | 'running' | 'finished' | 'failed' | 'unknown';

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function readBaseUrl(): string | null {
  const base = env.WOWSIM_APP_BASE_URL?.trim();
  if (!base) return null;
  return base.replace(/\/+$/, '');
}

function readStatusPathTemplate(): string {
  const raw = env.WOWSIM_APP_STATUS_PATH?.trim() || '/api/jobs/{job_id}';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  const apiKey = env.WOWSIM_APP_API_KEY?.trim();
  if (apiKey) headers['X-LodgeSim-Key'] = apiKey;
  return headers;
}

function normalizeStatus(value: unknown): NormalizedRunStatus {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'queued' || raw === 'pending') return 'queued';
  if (raw === 'running' || raw === 'started' || raw === 'in_progress') return 'running';
  if (raw === 'finished' || raw === 'completed' || raw === 'success') return 'finished';
  if (raw === 'failed' || raw === 'error' || raw === 'timed_out' || raw === 'canceled') return 'failed';
  return 'unknown';
}

function deriveProgressPercent(record: Record<string, unknown>): number | null {
  const candidates = [
    record.progress_pct,
    record.progress_percent,
    record.progress,
    record.percent,
    record.pct,
  ];

  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) {
      return Math.max(0, Math.min(100, Math.round(value)));
    }
  }

  const current = Number(record.progress_current);
  const total = Number(record.progress_total);
  if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
  }

  return null;
}

function pickMessage(record: Record<string, unknown>): string | null {
  const fields = [
    record.error,
    record.message,
    record.progress_label,
    record.progress_detail,
    record.last_line,
  ];

  for (const field of fields) {
    if (typeof field === 'string' && field.trim()) return field.trim();
  }
  return null;
}

export async function GET(context: APIContext): Promise<Response> {
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

  const url = new URL(context.request.url);
  const charId = parsePositiveInt(url.searchParams.get('char_id'));
  const jobId = url.searchParams.get('job_id')?.trim();

  if (!charId) {
    return Response.json({ error: 'char_id is required and must be a positive integer.' }, { status: 400 });
  }
  if (!jobId) {
    return Response.json({ error: 'job_id is required.' }, { status: 400 });
  }

  const statusPath = readStatusPathTemplate().replace('{job_id}', encodeURIComponent(jobId));
  const statusUrl = `${baseUrl}${statusPath}`;

  let upstreamJson: unknown = null;
  let upstreamStatus = 502;
  try {
    const upstream = await fetch(statusUrl, {
      method: 'GET',
      headers: buildHeaders(),
    });
    upstreamStatus = upstream.status;
    upstreamJson = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      return Response.json(
        {
          error: 'LodgeSim app status request failed.',
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

  const latest = await getLatestSimForRaider(env.DB, charId);
  const record = (upstreamJson ?? {}) as Record<string, unknown>;
  const jobRecord = (record.job && typeof record.job === 'object'
    ? (record.job as Record<string, unknown>)
    : record) as Record<string, unknown>;

  const status = normalizeStatus(jobRecord.status ?? record.status);
  const progress = deriveProgressPercent(jobRecord);
  const message = pickMessage(jobRecord);

  return Response.json({
    success: true,
    job_id: jobId,
    status,
    progress_percent: progress,
    message,
    upstream_status: upstreamStatus,
    upstream: upstreamJson,
    latest,
  });
}
