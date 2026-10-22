/**
 * How an upstream failure inside an OpenAI Responses stream reaches the
 * client.
 *
 * Codex takes a failed turn from the last `response.failed` event and skips
 * `error` events. A stream that ends without that terminal looks like a
 * dropped connection, which Codex retries five times and then reports as
 * "stream disconnected" instead of the cause. Where the cause is a policy
 * block, every retry is blocked too, and the turn can never succeed.
 *
 * The upstream is scripted at the network boundary, so the real OpenAI SDK
 * parses the stream exactly as it does in production.
 */

import { CHAT_API_KEY_ID_HEADER } from "@archestra/shared";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import OpenAI from "openai";
import { afterEach, beforeEach, vi } from "vitest";
import config from "@/config";
import db from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import { ModelModel } from "@/models";
import { describe, expect, test } from "@/test";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { openAiResponsesAdapterFactory } from "./adapters/openai-responses";
import openAiProxyRoutes from "./routes/openai";

const MISALIGNMENT_ERROR = {
  type: "invalid_request_error",
  code: "misalignment_policy_violation",
  message:
    "This request was blocked by our safety systems. Reason: Potentially unintended activity.",
  misalignment: {
    error_type: "other",
    detailed_explanation: "The agent turned off a safety check.",
    steer: { message: "Follow the user's instructions." },
  },
};

const STREAM_START = [
  {
    type: "response.created",
    sequence_number: 0,
    response: {
      id: "resp_upstream",
      object: "response",
      status: "in_progress",
      model: "gpt-5.6",
      output: [],
    },
  },
  {
    type: "response.output_item.added",
    sequence_number: 1,
    output_index: 0,
    item: {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "in_progress",
      content: [],
    },
  },
  {
    type: "response.output_text.delta",
    sequence_number: 2,
    output_index: 0,
    content_index: 0,
    item_id: "msg_1",
    delta: "Working on it",
  },
];

const FAILED_TERMINAL = {
  type: "response.failed",
  sequence_number: 4,
  response: {
    id: "resp_upstream",
    object: "response",
    status: "failed",
    model: "gpt-5.6",
    output: [],
    error: MISALIGNMENT_ERROR,
    usage: null,
  },
};

const COMPLETED_TERMINAL = {
  type: "response.completed",
  sequence_number: 3,
  response: {
    id: "resp_upstream",
    object: "response",
    status: "completed",
    model: "gpt-5.6",
    output: [],
    usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
  },
};

describe("Responses upstream failures", () => {
  let app: FastifyInstance;
  let upstreamEvents: object[] = [];

  beforeEach(async () => {
    await ModelModel.create({
      externalId: "openai/gpt-5.6",
      provider: "openai",
      modelId: "gpt-5.6",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        new OpenAI({
          apiKey: "test-key",
          baseURL: "https://upstream.test/v1",
          maxRetries: 0,
          fetch: async () =>
            new Response(
              upstreamEvents
                .map(
                  (event) =>
                    `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
                )
                .join(""),
              { headers: { "content-type": "text/event-stream" } },
            ),
        }) as never,
    );

    app = createFastifyInstance();
    await app.register(openAiProxyRoutes);
  });

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
  });

  async function streamTurn(fixtures: {
    makeAgent: () => Promise<{ id: string; organizationId: string }>;
    makeMember: (userId: string, organizationId: string) => Promise<unknown>;
    makeUser: () => Promise<{ id: string }>;
  }) {
    const agent = await fixtures.makeAgent();
    const owner = await fixtures.makeUser();
    await fixtures.makeMember(owner.id, agent.organizationId);
    const passthroughToken = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: owner.id,
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "x-archestra-virtual-key": passthroughToken,
        [CHAT_API_KEY_ID_HEADER]: "",
      },
      payload: {
        model: "gpt-5.6",
        input: [{ role: "user", content: "add the check" }],
        stream: true,
      },
    });
    expect(response.statusCode).toBe(200);
    return response.body
      .split("\n")
      .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
      .map(
        (line) =>
          JSON.parse(line.slice("data: ".length)) as {
            type: string;
            delta?: string;
            error?: Record<string, unknown>;
            response?: { status?: string; error?: Record<string, unknown> };
          },
      );
  }

  const terminals = (events: Array<{ type: string }>) =>
    events.filter((event) =>
      ["response.completed", "response.failed", "response.incomplete"].includes(
        event.type,
      ),
    );

  test("a policy block the upstream reports as an error event reaches Codex as a failed turn", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    // The upstream announces the block with an `error` event before its
    // terminal; the SDK throws on that event, so the terminal is never read.
    upstreamEvents = [
      ...STREAM_START,
      { type: "error", sequence_number: 3, error: MISALIGNMENT_ERROR },
      FAILED_TERMINAL,
    ];

    const events = await streamTurn({ makeAgent, makeMember, makeUser });

    expect(events.some((event) => event.delta === "Working on it")).toBe(true);
    const [terminal] = terminals(events);
    expect(terminals(events)).toHaveLength(1);
    expect(terminal).toMatchObject({
      type: "response.failed",
      response: { status: "failed", error: MISALIGNMENT_ERROR },
    });
    // AI SDK clients read the same failure from the `error` event.
    expect(events.find((event) => event.type === "error")?.error).toMatchObject(
      MISALIGNMENT_ERROR,
    );
  });

  test("the upstream's own failure terminal reaches the client with its review details", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    upstreamEvents = [...STREAM_START, FAILED_TERMINAL];

    const events = await streamTurn({ makeAgent, makeMember, makeUser });

    expect(terminals(events)).toHaveLength(1);
    expect(terminals(events)[0]).toMatchObject({
      type: "response.failed",
      response: { error: MISALIGNMENT_ERROR },
    });
  });

  test("a stream the upstream cuts off still ends with a failure terminal", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    upstreamEvents = [...STREAM_START];

    const events = await streamTurn({ makeAgent, makeMember, makeUser });

    expect(terminals(events)).toHaveLength(1);
    expect(terminals(events)[0]).toMatchObject({
      type: "response.failed",
      response: {
        id: "resp_upstream",
        error: { code: "proxy_stream_incomplete" },
      },
    });
  });

  test("a failure after the completed terminal reached the client does not end the response again", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    // A text-only turn releases `response.completed` as it arrives; usage
    // settles only afterwards, and in enforce mode its failure still ends the
    // stream with an error.
    config.llmProxy.usageAccountingMode = "enforce";
    upstreamEvents = [...STREAM_START, COMPLETED_TERMINAL];
    await db.execute(
      sql`ALTER TABLE interaction_billing ADD CONSTRAINT reject_test_settlement CHECK (false)`,
    );
    try {
      const events = await streamTurn({ makeAgent, makeMember, makeUser });

      expect(terminals(events)).toEqual([
        expect.objectContaining({ type: "response.completed" }),
      ]);
      expect(events.at(-1)).toMatchObject({
        type: "error",
        error: { message: "Unable to settle LLM usage" },
      });
    } finally {
      await db.execute(
        sql`ALTER TABLE interaction_billing DROP CONSTRAINT reject_test_settlement`,
      );
    }
  });
});
