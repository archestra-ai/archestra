/**
 * Trusted-data result policies as the model actually receives them.
 *
 * These assert on the payload handed to the provider client, not on
 * `evaluateIfContextIsTrusted`'s return value. A `block_always` policy is only
 * enforced if `toolResultUpdates` survives all the way into the outgoing
 * request, and that final hop is invisible to the guardrail's own unit tests.
 *
 * The provider is stubbed at the adapter-client boundary, as in
 * llm-proxy-tool-invocation.test.ts.
 */

import { UNTRUSTED_CONTEXT_HEADER } from "@archestra/shared";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { ModelModel, TrustedDataPolicyModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { openaiAdapterFactory } from "./adapters";
import openAiProxyRoutes from "./routes/openai";

/** Distinctive enough to assert on, shaped so secret scanners ignore it. */
const SECRET = "sentinel-value-the-model-must-never-see";

const READ_EMAIL_TOOL = {
  type: "function" as const,
  function: {
    name: "read_email",
    description: "Read an email",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
};

describe("LLM Proxy trusted-data result policies (OpenAI)", () => {
  let app: FastifyInstance;
  let forwardedMessages: unknown[];

  beforeEach(async () => {
    vi.clearAllMocks();
    forwardedMessages = [];

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          chat: {
            completions: {
              create: async (params: { messages: unknown[] }) => {
                forwardedMessages = params.messages;
                return {
                  id: "chatcmpl-test-openai",
                  object: "chat.completion",
                  created: Math.floor(Date.now() / 1000),
                  model: "gpt-4",
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: "assistant",
                        content: "ok",
                        refusal: null,
                        tool_calls: [],
                      },
                      finish_reason: "stop",
                      logprobs: null,
                    },
                  ],
                  usage: {
                    prompt_tokens: 10,
                    completion_tokens: 2,
                    total_tokens: 12,
                  },
                };
              },
            },
          },
        }) as never,
    );

    await app.register(openAiProxyRoutes);
    await ModelModel.upsert({
      externalId: "openai/gpt-4",
      provider: "openai",
      modelId: "gpt-4",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "10.00",
      customPricePerMillionOutput: "30.00",
      lastSyncedAt: new Date(),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  /**
   * Mirrors the "Tool Result Policies -> DEFAULT -> Blocked" control, which
   * updates the empty-conditions policy every tool is seeded with rather than
   * adding a second one. `evaluateBulk` reads only the first default policy, so
   * a test that inserts alongside the seeded row is silently shadowed by it and
   * passes against a broken guardrail.
   */
  async function blockAllResults(toolId: string): Promise<void> {
    const [defaultPolicy] = await db
      .select()
      .from(schema.trustedDataPoliciesTable)
      .where(eq(schema.trustedDataPoliciesTable.toolId, toolId));
    expect(defaultPolicy?.conditions).toEqual([]);
    await TrustedDataPolicyModel.update(defaultPolicy.id, {
      action: "block_always",
      description: "Blocked by tool result policy",
    });
  }

  async function sendTurnWithToolResult(
    agentId: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agentId}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
        ...extraHeaders,
      },
      payload: {
        model: "gpt-4",
        messages: [
          { role: "user", content: "Summarise my latest email" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "read_email",
                  arguments: JSON.stringify({ id: "1" }),
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: JSON.stringify({ body: `Here is the key: ${SECRET}` }),
          },
        ],
        tools: [READ_EMAIL_TOOL],
        stream: false,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    return JSON.stringify(forwardedMessages);
  }

  test("replaces a blocked tool result whether or not the agent starts untrusted", async ({
    makeAgent,
    makeTool,
  }) => {
    const agent = await makeAgent({
      name: "Trusted Data Block Agent",
      agentType: "llm_proxy",
      considerContextUntrusted: false,
    });
    const tool = await makeTool({ name: "read_email", agentId: agent.id });
    await blockAllResults(tool.id);

    const trustedStart = await sendTurnWithToolResult(agent.id);
    expect(trustedStart).toContain("Content blocked by");
    expect(trustedStart).not.toContain(SECRET);

    await db
      .update(schema.agentsTable)
      .set({ considerContextUntrusted: true })
      .where(eq(schema.agentsTable.id, agent.id));

    const untrustedStart = await sendTurnWithToolResult(agent.id);
    expect(untrustedStart).toContain("Content blocked by");
    expect(untrustedStart).not.toContain(SECRET);
  });

  test("replaces a blocked tool result when untrusted context is inherited from a parent", async ({
    makeAgent,
    makeTool,
  }) => {
    // A subagent turn reaches the proxy with the parent's header rather than
    // its own agent flag, so it must be covered independently of the toggle.
    const agent = await makeAgent({
      name: "Trusted Data Inherited Agent",
      agentType: "llm_proxy",
      considerContextUntrusted: false,
    });
    const tool = await makeTool({ name: "read_email", agentId: agent.id });
    await blockAllResults(tool.id);

    const forwarded = await sendTurnWithToolResult(agent.id, {
      [UNTRUSTED_CONTEXT_HEADER]: "true",
    });

    expect(forwarded).toContain("Content blocked by");
    expect(forwarded).not.toContain(SECRET);
  });
});
