/**
 * Anthropic Messages feature pass-through.
 *
 * Claude Code treats the proxy as the Anthropic API and adds request fields,
 * response keys, and stream events over releases. Auto mode's server-side
 * classifier is the current example: the request carries a `safeguards`
 * field and the response carries the server's verdicts. A gateway that drops
 * either one makes Claude Code fall back to its own, billed, classifier
 * requests, or deny actions it got no verdict for.
 * https://code.claude.com/docs/en/llm-gateway-protocol#feature-pass-through
 *
 * These tests drive the real route, handler, SDK client and serializer, and
 * stub only the upstream HTTP call.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { anthropicVertexClient } from "@/clients/anthropic-vertex";
import config from "@/config";
import { ModelModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import anthropicProxyRoutes from "./anthropic";

const MODEL = "claude-opus-4-20250514";
const FUTURE_BETA = "future-capability-2026-10-01";

// Fields Claude Code sends that the proxy does not interpret. Each must reach
// the upstream exactly as sent.
const PASSTHROUGH_REQUEST_FIELDS = {
  safeguards: { auto_mode: { enabled: true, transcript_id: "tr_1" } },
  context_management: {
    edits: [{ type: "clear_tool_uses_20250919", keep: { value: 3 } }],
  },
  output_config: { effort: "high", task_budget: { total_tokens: 4096 } },
  metadata: { user_id: "user-1", client_hint: "cli" },
};

const SAFEGUARD_RESULTS = [{ tool_use_id: "toolu_upstream", verdict: "allow" }];

const originalVertexAiConfig = { ...config.llm.anthropic.vertexAi };

beforeEach(async () => {
  // Direct to Anthropic unless a test opts in to Vertex, whatever the local env.
  config.llm.anthropic.vertexAi.enabled = false;
  await ModelModel.create({
    externalId: `anthropic/${MODEL}`,
    provider: "anthropic",
    modelId: MODEL,
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
});

afterEach(() => {
  Object.assign(config.llm.anthropic.vertexAi, originalVertexAiConfig);
  vi.restoreAllMocks();
});

describe("Anthropic Messages feature pass-through", () => {
  test("forwards unknown request fields and anthropic-beta unchanged", async ({
    makeAgent,
  }) => {
    const upstream = stubUpstream(() => Response.json(textMessage()));
    const agent = await makeAgent({ name: "passthrough-request" });

    const response = await sendMessages(`/v1/anthropic/${agent.id}`, {
      stream: false,
    });

    expect(response.statusCode).toBe(200);
    expect(upstream.requests).toHaveLength(1);
    const [request] = upstream.requests;
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers.get("anthropic-beta")).toBe(FUTURE_BETA);
    expect(request.body).toMatchObject(PASSTHROUGH_REQUEST_FIELDS);
  });

  test("returns unknown response keys and keeps tool-use ids", async ({
    makeAgent,
  }) => {
    stubUpstream(() =>
      Response.json({
        ...textMessage(),
        content: [
          {
            type: "tool_use",
            id: "toolu_upstream",
            name: "Bash",
            input: { command: "ls" },
            caller: { type: "direct" },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          server_tool_use: { web_search_requests: 0 },
        },
        safeguard_results: SAFEGUARD_RESULTS,
      }),
    );
    const agent = await makeAgent({ name: "passthrough-response" });

    const response = await sendMessages(`/v1/anthropic/${agent.id}`, {
      stream: false,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.safeguard_results).toEqual(SAFEGUARD_RESULTS);
    expect(body.usage.server_tool_use).toEqual({ web_search_requests: 0 });
    expect(body.content).toEqual([
      {
        type: "tool_use",
        id: "toolu_upstream",
        name: "Bash",
        input: { command: "ls" },
        caller: { type: "direct" },
      },
    ]);
  });

  test("relays unknown stream events and the upstream's end-event keys", async ({
    makeAgent,
  }) => {
    const upstream = stubUpstream(() =>
      sseResponse([
        ["message_start", { type: "message_start", message: textMessage() }],
        [
          "content_block_start",
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "toolu_upstream",
              name: "Bash",
              input: {},
            },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: '{"command":"ls"}',
            },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "safeguard_result",
          {
            type: "safeguard_result",
            tool_use_id: "toolu_upstream",
            verdict: "allow",
          },
        ],
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 7 },
            safeguard_results: SAFEGUARD_RESULTS,
          },
        ],
        ["message_stop", { type: "message_stop", trace: "upstream" }],
      ]),
    );
    const agent = await makeAgent({ name: "passthrough-stream" });

    const response = await sendMessages(`/v1/anthropic/${agent.id}`, {
      stream: true,
    });

    expect(response.statusCode).toBe(200);
    expect(upstream.requests[0].body).toMatchObject({
      ...PASSTHROUGH_REQUEST_FIELDS,
      stream: true,
    });

    const events = parseSse(response.body);
    const types = events.map((event) => event.type);
    // The unknown event follows the tool call it describes and precedes the
    // end of the message.
    expect(types.indexOf("safeguard_result")).toBeGreaterThan(
      types.indexOf("content_block_stop"),
    );
    expect(types.indexOf("safeguard_result")).toBeLessThan(
      types.indexOf("message_delta"),
    );
    expect(events.find((e) => e.type === "safeguard_result")).toEqual({
      type: "safeguard_result",
      tool_use_id: "toolu_upstream",
      verdict: "allow",
    });

    const toolBlock = events.find((e) => e.type === "content_block_start");
    expect(toolBlock?.content_block).toMatchObject({ id: "toolu_upstream" });

    const messageDelta = events.find((e) => e.type === "message_delta");
    expect(messageDelta?.safeguard_results).toEqual(SAFEGUARD_RESULTS);
    expect(messageDelta?.delta).toEqual({
      stop_reason: "tool_use",
      stop_sequence: null,
    });
    expect(events.find((e) => e.type === "message_stop")).toEqual({
      type: "message_stop",
      trace: "upstream",
    });
  });

  test("still surfaces an upstream error event mid-stream", async ({
    makeAgent,
  }) => {
    stubUpstream(() =>
      sseResponse([
        ["message_start", { type: "message_start", message: textMessage() }],
        [
          "error",
          {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          },
        ],
      ]),
    );
    const agent = await makeAgent({ name: "passthrough-stream-error" });

    const response = await sendMessages(`/v1/anthropic/${agent.id}`, {
      stream: true,
    });

    expect(response.body).toContain("Overloaded");
    expect(parseSse(response.body).map((e) => e.type)).not.toContain(
      "message_stop",
    );
  });

  describe("on Vertex AI", () => {
    beforeEach(() => {
      config.llm.anthropic.vertexAi.enabled = true;
      config.llm.anthropic.vertexAi.project = "test-project";
      config.llm.anthropic.vertexAi.location = "global";
      vi.spyOn(anthropicVertexClient, "getRequestHeaders").mockResolvedValue(
        new Headers({ Authorization: "Bearer google-token" }),
      );
    });

    test("forwards the fields to streamRawPredict and relays the verdicts", async ({
      makeAgent,
    }) => {
      const upstream = stubUpstream(() =>
        sseResponse([
          ["message_start", { type: "message_start", message: textMessage() }],
          [
            "message_delta",
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 3 },
              safeguard_results: SAFEGUARD_RESULTS,
            },
          ],
          ["message_stop", { type: "message_stop" }],
        ]),
      );
      const agent = await makeAgent({ name: "passthrough-vertex" });

      const response = await sendMessages(`/v1/anthropic/${agent.id}`, {
        stream: true,
      });

      expect(response.statusCode).toBe(200);
      const [request] = upstream.requests;
      expect(request.url).toBe(
        `https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/anthropic/models/${MODEL}:streamRawPredict`,
      );
      expect(request.headers.get("anthropic-beta")).toBe(FUTURE_BETA);
      expect(request.body).toMatchObject(PASSTHROUGH_REQUEST_FIELDS);

      const messageDelta = parseSse(response.body).find(
        (e) => e.type === "message_delta",
      );
      expect(messageDelta?.safeguard_results).toEqual(SAFEGUARD_RESULTS);
    });
  });
});

// =============================================================================
// Helpers
// =============================================================================

type UpstreamRequest = {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
};

/** Answer every upstream Messages call; record what the proxy sent. */
function stubUpstream(respond: () => Response) {
  const requests: UpstreamRequest[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      headers: request.headers,
      body: (await request.json()) as Record<string, unknown>,
    });
    return respond();
  });
  return { requests };
}

async function sendMessages(prefix: string, options: { stream: boolean }) {
  const app = createApp();
  await app.register(anthropicProxyRoutes);
  try {
    return await app.inject({
      method: "POST",
      url: `${prefix}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": FUTURE_BETA,
        "x-api-key": "test-anthropic-key",
      },
      payload: {
        model: MODEL,
        max_tokens: 256,
        messages: [{ role: "user", content: "List the files." }],
        stream: options.stream,
        ...PASSTHROUGH_REQUEST_FIELDS,
      },
    });
  } finally {
    await app.close();
  }
}

function createApp(): FastifyInstance {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

function textMessage() {
  return {
    id: "msg_upstream",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  };
}

function sseResponse(events: Array<[string, unknown]>): Response {
  const body = events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}
