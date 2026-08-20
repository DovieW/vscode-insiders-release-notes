import OpenAI from "openai";

export const DEFAULT_OPENAI_SERVICE_TIER = "flex";
export const OPENAI_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
export const OPENAI_MAX_RETRIES = 2;

export function getOpenAIServiceTier(env = process.env) {
  return String(env.OPENAI_SERVICE_TIER || "").trim() || DEFAULT_OPENAI_SERVICE_TIER;
}

export function createOpenAIClient({ apiKey, fetch } = {}) {
  return new OpenAI({
    apiKey,
    timeout: OPENAI_REQUEST_TIMEOUT_MS,
    maxRetries: OPENAI_MAX_RETRIES,
    ...(fetch ? { fetch } : {}),
  });
}
