/**
 * End-to-end regression pin for T-996: guardrails must fire for external MCP
 * clients (Claude Code connected via the connect page) whose tool traffic
 * reaches the proxy under client-decorated names and run_tool envelopes.
 *
 * Mirrors the captured incident request: only the gateway meta-tools are in
 * the request's tool list (decorated `mcp__<gateway>__archestra__…`), a prior
 * `run_tool`-dispatched `notion__notion-fetch` result sits in the
 * conversation (its trusted-data policy marks the context untrusted), and the
 * model responds with a `run_tool` dispatch to `github__issue_write`, whose
 * "block in sensitive context" invocation policy must block the turn.
 *
 * Deliberately does NOT mock the guardrail chain — this exercises the real
 * canonicalizer, trusted-data evaluation, and policy evaluation end to end.
 */
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { ModelModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import {
  type AnthropicStubOptions,
  createAnthropicTestClient,
} from "@/test/llm-provider-stubs";
import type { Agent } from "@/types";
import { anthropicAdapterFactory } from "./adapters";
import anthropicProxyRoutes from "./routes/anthropic";

const GATEWAY_NAME = "My Gateway";
const DECORATED_RUN_TOOL = "mcp__my_gateway__archestra__run_tool";
const DECORATED_SEARCH_TOOLS = "mcp__my_gateway__archestra__search_tools";
const NOTION_FETCH = "notion__notion-fetch";
const GITHUB_ISSUE_WRITE = "github__issue_write";

describe("LLM Proxy guardrails for gateway-connected clients (T-996)", () => {
  let app: FastifyInstance;
  let anthropicStubOptions: AnthropicStubOptions;
  let proxyAgent: Agent;

  beforeEach(
    async ({
      makeAgent,
      makeTool,
      makeAgentTool,
      makeToolPolicy,
      makeTrustedDataPolicy,
    }) => {
      archestraMcpBranding.syncFromOrganization(null);

      app = Fastify().withTypeProvider<ZodTypeProvider>();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      await app.register(anthropicProxyRoutes);

      anthropicStubOptions = {};
      vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
        () => createAnthropicTestClient(anthropicStubOptions) as never,
      );

      await ModelModel.upsert({
        externalId: "anthropic/claude-3-5-sonnet-20241022",
        provider: "anthropic",
        modelId: "claude-3-5-sonnet-20241022",
        inputModalities: null,
        outputModalities: null,
        customPricePerMillionInput: "3.00",
        customPricePerMillionOutput: "15.00",
        lastSyncedAt: new Date(),
      });

      proxyAgent = await makeAgent({ name: "T996 Proxy Agent" });
      // The gateway whose client server name anchors the canonicalizer.
      await makeAgent({
        organizationId: proxyAgent.organizationId,
        agentType: "mcp_gateway",
        name: GATEWAY_NAME,
      });

      const notionTool = await makeTool({ name: NOTION_FETCH });
      const githubTool = await makeTool({ name: GITHUB_ISSUE_WRITE });
      await makeAgentTool(proxyAgent.id, notionTool.id);
      await makeAgentTool(proxyAgent.id, githubTool.id);
      // notion-fetch results are external data; issue_write is blocked once
      // the session context is sensitive — the incident's exact config.
      await makeTrustedDataPolicy(notionTool.id, {
        conditions: [],
        action: "mark_as_untrusted",
      });
      await makeToolPolicy(githubTool.id, {
        conditions: [],
        action: "block_when_context_is_untrusted",
        reason: "No writes from a sensitive context",
      });
    },
  );

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const gatewayMetaTools = [
    {
      name: DECORATED_RUN_TOOL,
      description: "Run a tool by name",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: DECORATED_SEARCH_TOOLS,
      description: "Search tools",
      input_schema: { type: "object", properties: {} },
    },
  ];

  const conversationWithNotionFetch = [
    { role: "user", content: "Find the Notion doc and file a GitHub issue" },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_notion_fetch",
          name: DECORATED_RUN_TOOL,
          input: { tool_name: NOTION_FETCH, tool_args: { id: "hello" } },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_notion_fetch",
          content: "Notion page 'hello': some external document content",
        },
      ],
    },
  ];

  test("blocks a run_tool-dispatched sensitive write after an untrusted fetch", async () => {
    anthropicStubOptions.nonStreamingToolUse = {
      name: DECORATED_RUN_TOOL,
      input: {
        tool_name: GITHUB_ISSUE_WRITE,
        tool_args: { method: "create", title: "hello" },
      },
    };

    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${proxyAgent.id}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
      },
      payload: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: conversationWithNotionFetch,
        tools: gatewayMetaTools,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const types = body.content.map((block: { type: string }) => block.type);
    // The dispatch is discarded; the client gets only the refusal text, which
    // names the real target tool rather than the run_tool wrapper.
    expect(types).toEqual(["text"]);
    expect(body.content[0].text).toContain(GITHUB_ISSUE_WRITE);
    expect(body.stop_reason).toBe("end_turn");
  });

  test("allows the same dispatch when the context is clean", async () => {
    anthropicStubOptions.nonStreamingToolUse = {
      name: DECORATED_RUN_TOOL,
      input: {
        tool_name: GITHUB_ISSUE_WRITE,
        tool_args: { method: "create", title: "hello" },
      },
    };

    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${proxyAgent.id}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
      },
      payload: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [
          { role: "user", content: "File a GitHub issue titled hello" },
        ],
        tools: gatewayMetaTools,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const toolUses = body.content.filter(
      (block: { type: string }) => block.type === "tool_use",
    );
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe(DECORATED_RUN_TOOL);
  });
});
