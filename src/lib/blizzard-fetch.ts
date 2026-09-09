const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Per-attempt ceiling for a Blizzard subrequest. Callers run under the raider
 * refresh cron's wall-clock budget, and an unbounded fetch here could eat the
 * whole budget on a single slow character, so every attempt is capped.
 */
const REQUEST_TIMEOUT_MS = 8_000;

export async function fetchBlizzardJsonWithRetry<T>(
  url: string,
  accessToken: string,
  attempts = 3
): Promise<T | null> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Timed out or the connection failed. Treat like a retryable status so a
      // transient blip still gets its remaining attempts.
      if (attempt === attempts) return null;
      await delay(attempt * 500);
      continue;
    }

    if (response.ok) {
      return (await response.json()) as T;
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === attempts) {
      return null;
    }

    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : 0;
    // Clamp: Blizzard can hand back a multi-second retry-after, and honouring it
    // verbatim would overrun the caller's wall-clock budget on its own.
    const backoff = Math.min(2_000, retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : attempt * 500);
    await delay(backoff);
  }

  return null;
}
