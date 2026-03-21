const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchBlizzardJsonWithRetry<T>(
  url: string,
  accessToken: string,
  attempts = 3
): Promise<T | null> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.ok) {
      return (await response.json()) as T;
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === attempts) {
      return null;
    }

    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : 0;
    const backoff = retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : attempt * 500;
    await delay(backoff);
  }

  return null;
}
