/**
 * Anthropic provider error relay.
 *
 * Claude Code recovers from an expired server-side thread only when the
 * proxy returns Anthropic's own 404 body, `thread_not_found` included. These
 * tests drive the real route, handler, SDK client and error boundary, and stub
 * only the upstream HTTP call.
 */

import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import config from "@/config";
import { ModelModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import anthropicProxyRoutes from "./anthropic";

const MODEL = "claude-opus-4-20250514";

const THREAD_NOT_FOUND = {
  type: "error",
  error: {
    type: "not_found_error",
    message:
      'No thread state was found for the requested `previous_message_id`. Replay the full conversation with `thread: {"type": "create"}` to start a new Thread.',
    details: { error_code: "thread_not_found" },
  },
  request_id: "req_test",
};

const originalVertexAiConfig = { ...config.llm.anthropic.vertexAi };

beforeEach(async () => {
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

describe("Anthropic provider error relay", () => {
  for (const stream of [false, true]) {
    test(`relays an expired-thread 404 unchanged (stream: ${stream})`, async ({
      makeAgent,
    }) => {
      stubUpstreamError(404, THREAD_NOT_FOUND);

      const response = await sendContinue({
        stream,
        agentId: (await makeAgent({ name: `relay-${stream}` })).id,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(THREAD_NOT_FOUND);
    });
  }

  test("relays an invalid_request_error 400 unchanged", async ({
    makeAgent,
  }) => {
    const body = {
      type: "error",
      error: { type: "invalid_request_error", message: "prompt is too long" },
    };
    stubUpstreamError(400, body);

    const response = await sendContinue({
      stream: false,
      agentId: (await makeAgent({ name: "relay" })).id,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(body);
  });

  test("relays a provider api_error 500 unchanged", async ({ makeAgent }) => {
    const body = {
      type: "error",
      error: { type: "api_error", message: "Internal server error" },
    };
    stubUpstreamError(500, body);

    const response = await sendContinue({
      stream: false,
      agentId: (await makeAgent({ name: "relay" })).id,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual(body);
  });
});

function stubUpstreamError(status: number, body: unknown) {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

async function sendContinue(options: { stream: boolean; agentId: string }) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(anthropicProxyRoutes);
  try {
    return await app.inject({
      method: "POST",
      url: `/v1/anthropic/${options.agentId}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "test-anthropic-key",
      },
      payload: {
        model: MODEL,
        max_tokens: 256,
        messages: [{ role: "user", content: "And the next one?" }],
        stream: options.stream,
        thread: { type: "continue", previous_message_id: "msg_expired" },
      },
    });
  } finally {
    await app.close();
  }
}
