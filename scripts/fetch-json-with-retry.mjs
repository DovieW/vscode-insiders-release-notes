import { setTimeout as sleep } from "node:timers/promises";

const UNDICI_TRANSIENT_ERROR_CODES = [
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
];

export class TransientFetchError extends Error {
  constructor(message) {
    super(message);
    this.name = "TransientFetchError";
  }
}

function getRetryDelayMs(retryAfterHeader, attempt, baseDelayMs) {
  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  const retryAfterDate = Date.parse(retryAfterHeader || "");
  if (Number.isFinite(retryAfterDate)) {
    return Math.max(retryAfterDate - Date.now(), 0);
  }

  return baseDelayMs * attempt;
}

function isTransientStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function isTransientError(error) {
  if (error instanceof TransientFetchError) return true;
  if (!error || typeof error !== "object") return false;

  const isFetchFailedTypeError = error instanceof TypeError && /fetch failed/i.test(error.message || "");
  const isKnownTransientErrorName = [
    "AbortError",
    "ConnectTimeoutError",
    "HeadersTimeoutError",
  ].includes(error.name);
  const hasTransientErrorCode = UNDICI_TRANSIENT_ERROR_CODES.includes(error.code) || UNDICI_TRANSIENT_ERROR_CODES.includes(error.cause?.code);

  return isFetchFailedTypeError || isKnownTransientErrorName || hasTransientErrorCode;
}

export async function fetchJsonWithRetry(
  url,
  {
    headers = {},
    maxAttempts = 3,
    baseDelayMs = 15000,
    timeoutMs = 30000,
    fetchImpl = fetch,
  } = {},
) {
  let lastTransientError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(url, { headers, signal: controller.signal });

      if (res.ok) {
        return res.json();
      }

      if (isTransientStatus(res.status)) {
        const message = `Failed to fetch ${url}: ${res.status} ${res.statusText}`;
        lastTransientError = new TransientFetchError(message);

        if (attempt < maxAttempts) {
          const delayMs = getRetryDelayMs(res.headers.get("retry-after"), attempt, baseDelayMs);
          console.warn(`${message}; retrying in ${Math.ceil(delayMs / 1000)}s.`);
          await sleep(delayMs);
          continue;
        }

        break;
      }

      throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
    } catch (error) {
      if (!isTransientError(error)) {
        throw error;
      }

      const message = `Failed to fetch ${url}: ${error.name}${error.message ? `: ${error.message}` : ""}`;
      lastTransientError = new TransientFetchError(message);

      if (attempt < maxAttempts) {
        const delayMs = getRetryDelayMs(null, attempt, baseDelayMs);
        console.warn(`${message}; retrying in ${Math.ceil(delayMs / 1000)}s.`);
        await sleep(delayMs);
        continue;
      }

      break;
    } finally {
      clearTimeout(timeout);
    }
  }

  if (!lastTransientError) {
    throw new Error(`Internal error: retry loop exited without a transient fetch error for ${url}`);
  }

  throw lastTransientError;
}
