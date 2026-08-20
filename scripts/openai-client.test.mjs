import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenAIClient,
  DEFAULT_OPENAI_SERVICE_TIER,
  getOpenAIServiceTier,
  OPENAI_MAX_RETRIES,
  OPENAI_REQUEST_TIMEOUT_MS,
} from "./openai-client.mjs";

test("OpenAI service tier defaults to flex", () => {
  assert.equal(getOpenAIServiceTier({}), DEFAULT_OPENAI_SERVICE_TIER);
  assert.equal(getOpenAIServiceTier({ OPENAI_SERVICE_TIER: "  " }), DEFAULT_OPENAI_SERVICE_TIER);
  assert.equal(getOpenAIServiceTier({ OPENAI_SERVICE_TIER: " auto " }), "auto");
});

test("OpenAI client retries transient 429 responses without changing service tier", async () => {
  const requestBodies = [];
  const fetch = async (_url, init) => {
    requestBodies.push(JSON.parse(init.body));

    if (requestBodies.length <= OPENAI_MAX_RETRIES) {
      return new Response(JSON.stringify({
        error: {
          message: "Resource unavailable",
          type: "rate_limit_error",
          code: "resource_unavailable",
        },
      }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after-ms": "1",
        },
      });
    }

    return new Response(JSON.stringify({
      id: "resp_test",
      object: "response",
      created_at: 0,
      model: "test-model",
      status: "completed",
      output: [],
      service_tier: "flex",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const client = createOpenAIClient({ apiKey: "test-key", fetch });
  assert.equal(client.timeout, OPENAI_REQUEST_TIMEOUT_MS);
  assert.equal(client.maxRetries, OPENAI_MAX_RETRIES);

  await client.responses.create({
    model: "test-model",
    input: "test",
    service_tier: "flex",
  });

  assert.equal(requestBodies.length, OPENAI_MAX_RETRIES + 1);
  assert.deepEqual(requestBodies.map((body) => body.service_tier), ["flex", "flex", "flex"]);
});
