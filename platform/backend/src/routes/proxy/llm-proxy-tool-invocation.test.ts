/**
 * Tool-invocation policy behavior on the LLM proxy (OpenAI).
 *
 * Ported from the `llm-proxy/tool-invocation.spec.ts` e2e. Exercises the REAL
 * policy engine + DB for the two distinct policy behaviors the spec asserts:
 *
 *  1. BLOCK: an untrusted-context agent whose `read_file` tool carries a
 *     `block_always` policy for `/etc/` paths — when the provider returns a
 *     `read_file` call for `/etc/passwd`, the proxy replaces it with a refusal
 *     and persists the interaction.
 *  2. ALLOW: with no blocking policy, regular tool calls pass through alongside
 *     Archestra built-in tools (which always bypass policy evaluation).
 *
 * The e2e ran these across the full provider matrix, but the policy logic is
 * provider-agnostic (it runs on normalized tool calls); per-provider adapter
 * surfacing of tool calls and refusals is covered by
 * routes/proxy/adapters/*.test.ts. The e2e's Azure-Responses follow-up variant
 * asserts the same `block_always` behavior through the Responses request shape,
 * which those adapter tests + the block case below jointly cover.
 *
 * The provider is stubbed at the adapter-client boundary (as in
 * llm-proxy-handler.test.ts).
 */

import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { ModelModel, OrganizationModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { openaiAdapterFactory } from "./adapters";
import openAiProxyRoutes from "./routes/openai";

const READ_FILE_TOOL = {
  type: "function" as const,
  function: {
    name: "read_file",
    description: "Read a file from the filesystem",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "The path to the file to read",
        },
      },
      required: ["file_path"],
    },
  },
};

type StubToolCall = { name: string; arguments: string };

/** OpenAI client stub whose completion returns the configured tool calls. */
function createToolCallClient(getToolCalls: () => StubToolCall[]) {
  return {
    chat: {
      completions: {
        create: async () => ({
          id: "chatcmpl-test-openai",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gpt-4",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                refusal: null,
                tool_calls: getToolCalls().map((tc, i) => ({
                  id: `call_${i}`,
                  type: "function",
                  function: { name: tc.name, arguments: tc.arguments },
                })),
              },
              finish_reason: "tool_calls",
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 82, completion_tokens: 17, total_tokens: 99 },
        }),
      },
    },
  };
}

describe("LLM Proxy tool-invocation policy (OpenAI)", () => {
  let app: FastifyInstance;
  let stubToolCalls: StubToolCall[];

  beforeEach(async () => {
    vi.clearAllMocks();
    stubToolCalls = [];

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createToolCallClient(() => stubToolCalls) as never,
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

  test("blocks the read_file call on untrusted data and persists the interaction", async ({
    makeOrganization,
    makeAgent,
    makeTool,
    makeToolPolicy,
  }) => {
    // Tool invocation policies are only evaluated under restrictive global
    // policy (permissive short-circuits to allow). getGlobalToolPolicy falls
    // back to the only org in the DB for a team-less agent.
    const organization = await makeOrganization();
    await OrganizationModel.patch(organization.id, {
      globalToolPolicy: "restrictive",
    });

    // considerContextUntrusted marks the whole context untrusted, mirroring the
    // e2e setup this test blocks against.
    const agent = await makeAgent({
      name: "Tool Invocation Block Agent",
      organizationId: organization.id,
      agentType: "llm_proxy",
      considerContextUntrusted: true,
    });

    const tool = await makeTool({ name: "read_file", agentId: agent.id });
    await makeToolPolicy(tool.id, {
      conditions: [{ key: "file_path", operator: "contains", value: "/etc/" }],
      action: "block_always",
      reason: "Reading /etc/ files is not allowed for security reasons",
    });

    stubToolCalls = [
      { name: "read_file", arguments: '{"file_path":"/etc/passwd"}' },
    ];

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4",
        messages: [
          {
            role: "user",
            content:
              "UNTRUSTED_DATA: This is untrusted content from an external source",
          },
        ],
        tools: [READ_FILE_TOOL],
        stream: false,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();

    // The tool call was replaced by a refusal (mirrors the e2e's
    // assertToolCallBlocked for OpenAI-compatible providers).
    const message = body.choices[0].message;
    const refusalOrContent = message.refusal || message.content;
    expect(refusalOrContent).toBeTruthy();
    expect(refusalOrContent).toContain("read_file");
    expect(refusalOrContent).toContain(
      "Archestra LLM Proxy blocked unsafe tool call",
    );
    expect(refusalOrContent).toContain("tool call policy violated");

    // The blocked interaction was persisted with the untrusted request content.
    const interactions = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.profileId, agent.id));
    expect(interactions.length).toBeGreaterThan(0);
    expect(JSON.stringify(interactions[0].request)).toContain("UNTRUSTED_DATA");
  });

  test("passes regular and Archestra tool calls through when no policy blocks", async ({
    makeAgent,
  }) => {
    // Default org globalToolPolicy is permissive and no blocking policy exists,
    // so both the regular tool and the Archestra built-in tool pass through.
    const agent = await makeAgent({
      name: "Tool Invocation Allow Agent",
      agentType: "llm_proxy",
    });

    stubToolCalls = [
      { name: "read_file", arguments: '{"file_path":"/etc/passwd"}' },
      { name: "archestra__whoami", arguments: "{}" },
    ];

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4",
        messages: [
          { role: "user", content: "First, read /etc/passwd, then who am I" },
        ],
        tools: [READ_FILE_TOOL],
        stream: false,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const toolCalls = response.json().choices[0].message.tool_calls;
    const names = toolCalls.map(
      (tc: { function: { name: string } }) => tc.function.name,
    );
    expect(names).toContain("read_file");
    expect(names).toContain("archestra__whoami");

    const readFile = toolCalls.find(
      (tc: { function: { name: string } }) => tc.function.name === "read_file",
    );
    expect(JSON.parse(readFile.function.arguments).file_path).toBe(
      "/etc/passwd",
    );
  });
});
