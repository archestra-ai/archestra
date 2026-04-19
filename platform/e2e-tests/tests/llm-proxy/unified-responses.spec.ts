import { expect, test } from "@playwright/test";
import { API_BASE_URL } from "../../consts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE = API_BASE_URL; // http://localhost:9000 by default
const GROQ_KEY = process.env.E2E_GROQ_API_KEY ?? "";
const AGENT_ID = process.env.E2E_AGENT_ID; // optional; tests that need it will skip if missing

/** Fast model — smallest latency + cost for e2e smoke tests */
const FAST_MODEL = "llama-3.1-8b-instant";
/** Larger model — confirms routing works beyond a single model */
const LARGE_MODEL = "llama-3.3-70b-versatile";

const AUTH = { Authorization: `Bearer ${GROQ_KEY}` };
const JSON_HEADERS = { "Content-Type": "application/json", ...AUTH };

test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function postResponses(
  request: import("@playwright/test").APIRequestContext,
  path: string,
  body: object,
) {
  return request.post(`${BASE}${path}`, {
    headers: JSON_HEADERS,
    data: body,
  });
}

function assertResponsesShape(body: Record<string, unknown>) {
  expect(body.object).toBe("response");
  expect(body.status).toBe("completed");
  expect(Array.isArray(body.output)).toBe(true);
  const output = body.output as Array<Record<string, unknown>>;
  expect(output.length).toBeGreaterThan(0);
  expect(output[0].type).toBe("message");
  expect(output[0].role).toBe("assistant");
  const content = output[0].content as Array<Record<string, unknown>>;
  expect(content[0].type).toBe("output_text");
  expect(typeof content[0].text).toBe("string");
  expect((content[0].text as string).length).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// GET /v1/unified/models — credential verification (used by n8n on "Test Connection")
// ---------------------------------------------------------------------------

test.describe("GET /v1/unified/models", () => {
  test("returns a valid OpenAI-format model list", async ({ request }) => {
    const res = await request.get(`${BASE}/v1/unified/models`, {
      headers: AUTH,
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    const models = body.data as Array<Record<string, unknown>>;
    expect(models.length).toBeGreaterThan(0);
    // Each model must be OpenAI-compatible
    for (const m of models.slice(0, 5)) {
      expect(typeof m.id).toBe("string");
      expect(m.object).toBe("model");
    }
  });

  test("rejects unauthenticated requests with 401", async ({ request }) => {
    const res = await request.get(`${BASE}/v1/unified/models`);
    expect(res.status()).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/unified/responses — agentless (default profile resolves)
// ---------------------------------------------------------------------------

test.describe("POST /v1/unified/responses — agentless", () => {
  test("plain string input resolves and returns Responses API format", async ({
    request,
  }) => {
    const res = await postResponses(request, "/v1/unified/responses", {
      model: FAST_MODEL,
      input: "Reply with exactly the word: PONG",
      stream: false,
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    assertResponsesShape(body);
    // Verify response fields
    expect(typeof body.id).toBe("string");
    expect((body.id as string).startsWith("resp_")).toBe(true);
    expect(body.model).toBe(FAST_MODEL);
  });

  test("n8n format input (no type field, just role+content) works", async ({
    request,
  }) => {
    const res = await postResponses(request, "/v1/unified/responses", {
      model: FAST_MODEL,
      input: [
        { role: "user", content: "What is 2+2? Answer with just the number." },
      ],
      stream: false,
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    assertResponsesShape(body);
    const text = (body.output as Array<Record<string, unknown>>)[0]
      .content as Array<Record<string, unknown>>;
    expect(text[0].text).toContain("4");
  });

  test("standard Responses API input format (type:message + input_text) works", async ({
    request,
  }) => {
    const res = await postResponses(request, "/v1/unified/responses", {
      model: FAST_MODEL,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Reply with exactly: ARCHESTRA_OK",
            },
          ],
        },
      ],
      stream: false,
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    assertResponsesShape(body);
  });

  test("system instructions (instructions field) are forwarded", async ({
    request,
  }) => {
    const res = await postResponses(request, "/v1/unified/responses", {
      model: FAST_MODEL,
      instructions:
        "You are a robot. Always start your reply with 'BEEP BOOP'.",
      input: "Hello!",
      stream: false,
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    assertResponsesShape(body);
    const text = (
      (body.output as Array<Record<string, unknown>>)[0].content as Array<
        Record<string, unknown>
      >
    )[0].text as string;
    expect(text.toUpperCase()).toContain("BEEP");
  });

  test("streams SSE events for stream:true requests", async ({ request }) => {
    const res = await postResponses(request, "/v1/unified/responses", {
      model: FAST_MODEL,
      input: "Count to 3.",
      stream: true,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/event-stream");
    const body = await res.text();
    // SSE stream must contain data events
    expect(body).toContain("data:");
    // Must have a completed event
    expect(body).toContain("response.completed");
  });

  test("routes to LARGE_MODEL correctly (different model, same endpoint)", async ({
    request,
  }) => {
    const res = await postResponses(request, "/v1/unified/responses", {
      model: LARGE_MODEL,
      input: "Reply with exactly the word: LARGE",
      stream: false,
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    assertResponsesShape(body);
    expect(body.model).toBe(LARGE_MODEL);
  });

  test("returns 404 for a model not in the registry", async ({ request }) => {
    const res = await postResponses(request, "/v1/unified/responses", {
      model: "nonexistent-model-xyz-99999",
      input: "hello",
      stream: false,
    });
    expect(res.status()).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    const err = body.error as Record<string, unknown>;
    expect(typeof err.message).toBe("string");
  });

  test("returns 401 when no Authorization header is provided", async ({
    request,
  }) => {
    const res = await request.post(`${BASE}/v1/unified/responses`, {
      headers: { "Content-Type": "application/json" },
      data: { model: FAST_MODEL, input: "hello", stream: false },
    });
    expect(res.status()).toBe(401);
  });

  test("multi-turn conversation (two user messages) works", async ({
    request,
  }) => {
    const res = await postResponses(request, "/v1/unified/responses", {
      model: FAST_MODEL,
      input: [
        { role: "user", content: "My name is Alice." },
        { role: "assistant", content: "Hello Alice! Nice to meet you." },
        { role: "user", content: "What is my name?" },
      ],
      stream: false,
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    assertResponsesShape(body);
    const text = (
      (body.output as Array<Record<string, unknown>>)[0].content as Array<
        Record<string, unknown>
      >
    )[0].text as string;
    expect(text).toContain("Alice");
  });

  test("tool definition is forwarded and tool call is returned", async ({
    request,
  }) => {
    const res = await postResponses(request, "/v1/unified/responses", {
      model: FAST_MODEL,
      input: "What is the weather in Paris? Use the get_weather tool.",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get current weather for a city",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string", description: "City name" },
            },
            required: ["city"],
          },
        },
      ],
      tool_choice: "required",
      stream: false,
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const output = body.output as Array<Record<string, unknown>>;
    // Should have a function_call item in output
    const toolCall = output.find((o) => o.type === "function_call");
    expect(toolCall).toBeDefined();
    expect(toolCall?.name).toBe("get_weather");
    expect(typeof toolCall?.arguments).toBe("string");
    const args = JSON.parse(toolCall?.arguments as string) as Record<
      string,
      unknown
    >;
    expect(typeof args.city).toBe("string");
  });

  test("usage tokens are returned in response", async ({ request }) => {
    const res = await postResponses(request, "/v1/unified/responses", {
      model: FAST_MODEL,
      input: "Hello",
      stream: false,
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const usage = body.usage as Record<string, number> | undefined;
    expect(usage).toBeDefined();
    expect(usage?.input_tokens).toBeGreaterThan(0);
    expect(usage?.output_tokens).toBeGreaterThan(0);
    expect(usage?.total_tokens).toBe(
      (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    );
  });
});

// ---------------------------------------------------------------------------
// POST /v1/unified/:agentId/responses — agent-scoped
// ---------------------------------------------------------------------------

test.describe("POST /v1/unified/:agentId/responses — agent-scoped", () => {
  test("routes correctly when valid agentId is in URL", async ({ request }) => {
    test.skip(!AGENT_ID, "E2E_AGENT_ID not set — skipping agent-scoped tests");
    const res = await postResponses(
      request,
      `/v1/unified/${AGENT_ID}/responses`,
      {
        model: FAST_MODEL,
        input: "Reply with exactly: AGENT_SCOPED_OK",
        stream: false,
      },
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    assertResponsesShape(body);
  });

  test("returns 400 for a malformed (non-UUID) agentId", async ({
    request,
  }) => {
    const res = await postResponses(
      request,
      "/v1/unified/not-a-valid-uuid/responses",
      {
        model: FAST_MODEL,
        input: "hello",
        stream: false,
      },
    );
    expect([400, 404]).toContain(res.status());
  });

  test("returns 404 for a plausible but non-existent agentId UUID", async ({
    request,
  }) => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await postResponses(
      request,
      `/v1/unified/${fakeId}/responses`,
      {
        model: FAST_MODEL,
        input: "hello",
        stream: false,
      },
    );
    expect(res.status()).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/unified/:agentId/models — agent-scoped model listing
// ---------------------------------------------------------------------------

test.describe("GET /v1/unified/:agentId/models — agent-scoped", () => {
  test("returns model list for a valid agentId", async ({ request }) => {
    test.skip(!AGENT_ID, "E2E_AGENT_ID not set — skipping agent-scoped tests");
    const res = await request.get(`${BASE}/v1/unified/${AGENT_ID}/models`, {
      headers: AUTH,
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
  });
});
