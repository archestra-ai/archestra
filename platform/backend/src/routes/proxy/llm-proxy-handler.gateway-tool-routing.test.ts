/**
 * End-to-end pin for how the LLM proxy routes the tool calls of external MCP
 * clients (Claude Code, OpenCode, Codex) whose gateway tools reach the proxy
 * under client-decorated names and `run_tool` envelopes.
 *
 * Runs under both ways the proxy recognizes the gateway's tools: a label the
 * gateway's own name anchors, with no attestation (compat), and any label at
 * all, with the gateway's attestation in each description.
 *
 * Exercises the real tool identity resolution and dispatch-mode re-addressing
 * end to end: a `run_tool` dispatch is released as the model wrote it, and a
 * direct call to a tool the client never declared is re-addressed through the
 * `run_tool` the client can route.
 */
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { attestToolDescription } from "@/archestra-mcp-server/tool-attestation";
import { ModelModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import {
  type AnthropicStubOptions,
  createAnthropicTestClient,
  createOpenAiTestClient,
  type OpenAiStubOptions,
} from "@/test/llm-provider-stubs";
import type { Agent } from "@/types";
import {
  anthropicAdapterFactory,
  azureResponsesAdapterFactory,
  openAiResponsesAdapterFactory,
  openaiAdapterFactory,
} from "./adapters";
import anthropicProxyRoutes from "./routes/anthropic";
import azureProxyRoutes from "./routes/azure";
import openAiProxyRoutes from "./routes/openai";

const GATEWAY_NAME = "My Gateway";
const GITHUB_ISSUE_WRITE = "github__issue_write";

/** How the client registered the gateway, and whether its tools carry attestations. */
type Connection = { label: string; attested: boolean };
const CONNECTIONS = [
  // The gateway's own name as the label: recognized with no attestation.
  { label: "my_gateway", attested: false },
  // A label nothing anchors: recognized by the gateway's attestation alone.
  { label: "gw", attested: true },
] satisfies Connection[];

/** A Responses turn that answers with `output`. */
const responsesEnvelope = (output: Record<string, unknown>[]) => ({
  id: "resp_guardrails",
  object: "response",
  created_at: Math.floor(Date.now() / 1000),
  model: "gpt-4o",
  status: "completed",
  output,
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
});

/** The same turn as a Responses event stream: each item, then the envelope. */
async function* responsesStream(output: Record<string, unknown>[]) {
  let sequence = 0;
  for (const [index, item] of output.entries()) {
    yield {
      type: "response.output_item.added",
      output_index: index,
      sequence_number: sequence++,
      item: { ...item, arguments: "", status: "in_progress" },
    };
    yield {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: index,
      sequence_number: sequence++,
      delta: item.arguments,
    };
    yield {
      type: "response.output_item.done",
      output_index: index,
      sequence_number: sequence++,
      item,
    };
  }
  yield {
    type: "response.completed",
    sequence_number: sequence++,
    response: responsesEnvelope(output),
  };
}

/**
 * The function calls a Responses client ends up with: the output of the
 * response, or, streamed, of the last completed envelope, which is the one
 * the client keeps.
 */
const responsesCallsOf = (body: string, stream: boolean) => {
  const output = stream
    ? (body
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice("data: ".length)))
        .filter((event) => event.type === "response.completed")
        .at(-1)?.response.output ?? [])
    : (JSON.parse(body).output ?? []);
  return (
    output as Array<{
      type: string;
      name: string;
      namespace?: string;
      arguments: string;
    }>
  )
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      name: item.name,
      namespace: item.namespace,
      input: JSON.parse(item.arguments) as Record<string, unknown>,
    }));
};

describe("LLM Proxy tool-call routing for gateway-connected clients", () => {
  let app: FastifyInstance;
  let anthropicStubOptions: AnthropicStubOptions;
  let openAiStubOptions: OpenAiStubOptions;
  let responsesOutput: Record<string, unknown>[];
  let responsesRequests: unknown[];
  let proxyAgent: Agent;
  let gatewayId: string;

  beforeEach(async ({ makeAgent, makeTool, makeAgentTool }) => {
    archestraMcpBranding.syncFromOrganization(null);

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(anthropicProxyRoutes);
    await app.register(openAiProxyRoutes);
    await app.register(azureProxyRoutes);

    anthropicStubOptions = {};
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () => createAnthropicTestClient(anthropicStubOptions) as never,
    );
    openAiStubOptions = {};
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient(openAiStubOptions) as never,
    );
    responsesOutput = [];
    responsesRequests = [];
    for (const factory of [
      openAiResponsesAdapterFactory,
      azureResponsesAdapterFactory,
    ]) {
      vi.spyOn(factory, "createClient").mockImplementation(
        () =>
          ({
            responses: {
              create: async (params: { stream?: boolean }) => {
                responsesRequests.push(structuredClone(params));
                return params.stream
                  ? responsesStream(responsesOutput)
                  : responsesEnvelope(responsesOutput);
              },
            },
          }) as never,
      );
    }

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
    await ModelModel.upsert({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });

    proxyAgent = await makeAgent({ name: "Gateway Client Proxy Agent" });
    // The gateway whose client server name anchors compat resolution, and
    // whose attestations the attested connection carries.
    gatewayId = (
      await makeAgent({
        organizationId: proxyAgent.organizationId,
        agentType: "mcp_gateway",
        name: GATEWAY_NAME,
      })
    ).id;

    const githubTool = await makeTool({ name: GITHUB_ISSUE_WRITE });
    await makeAgentTool(proxyAgent.id, githubTool.id);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  /** A gateway meta-tool as the client declares it. */
  const metaTool = (
    connection: Connection,
    shortName: "run_tool" | "search_tools",
    description: string,
  ) => ({
    name: `mcp__${connection.label}__archestra__${shortName}`,
    description: connection.attested
      ? attestToolDescription({
          organizationId: proxyAgent.organizationId,
          gatewayId,
          advertisedName: `archestra__${shortName}`,
          kind: "b",
          description,
        })
      : description,
    input_schema: { type: "object", properties: {} },
  });

  const gatewayMetaTools = (connection: Connection) => [
    metaTool(connection, "run_tool", "Run a tool by name"),
    metaTool(connection, "search_tools", "Search tools"),
  ];

  /** A description carrying the gateway's attestation that it served `advertisedName`. */
  const served = (advertisedName: string, description = "Gateway tool") =>
    attestToolDescription({
      organizationId: proxyAgent.organizationId,
      gatewayId,
      advertisedName,
      kind: advertisedName.startsWith("archestra__") ? "b" : "t",
      description,
    });

  /** A tool the client declares as `name`, attested as `advertisedName` when given. */
  const declared = (name: string, advertisedName?: string) => ({
    name,
    description: advertisedName ? served(advertisedName) : "A tool",
    input_schema: { type: "object", properties: {} },
  });

  const runTool = (connection: Connection) =>
    `mcp__${connection.label}__archestra__run_tool`;

  const issueWriteDispatch = (connection: Connection) => ({
    name: runTool(connection),
    input: {
      tool_name: GITHUB_ISSUE_WRITE,
      tool_args: { method: "create", title: "hello" },
    },
  });

  const send = (params: { messages: unknown[]; tools: unknown[] }) =>
    app.inject({
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
        messages: params.messages,
        tools: params.tools,
      },
    });

  /** OpenCode over Chat Completions; tools as `declared` builds them. */
  const sendOpenCode = (params: {
    messages: unknown[];
    tools: Array<{ name: string; description?: string }>;
  }) =>
    app.inject({
      method: "POST",
      url: `/v1/openai/${proxyAgent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-test",
        "user-agent": "opencode/1.18.31",
      },
      payload: {
        model: "gpt-4o",
        stream: false,
        messages: params.messages,
        tools: params.tools.map(({ name, description }) => ({
          type: "function",
          function: {
            name,
            description,
            parameters: { type: "object", properties: {} },
          },
        })),
      },
    });

  const openCodeToolCallsOf = (body: {
    choices: Array<{
      message: {
        tool_calls?: Array<{ function: { name: string; arguments: string } }>;
      };
    }>;
  }) =>
    (body.choices[0].message.tool_calls ?? []).map((call) => ({
      name: call.function.name,
      input: JSON.parse(call.function.arguments),
    }));

  const toolUsesOf = (body: {
    content: Array<{ type: string; name?: string; input?: unknown }>;
  }) => body.content.filter((block) => block.type === "tool_use");

  describe.each(
    CONNECTIONS,
  )("under the label $label (attested: $attested)", (connection) => {
    test("releases a run_tool dispatch as the model wrote it", async () => {
      anthropicStubOptions.nonStreamingToolUse = issueWriteDispatch(connection);

      const response = await send({
        messages: [
          { role: "user", content: "File a GitHub issue titled hello" },
        ],
        tools: gatewayMetaTools(connection),
      });

      expect(response.statusCode).toBe(200);
      const toolUses = toolUsesOf(response.json());
      expect(toolUses).toHaveLength(1);
      expect(toolUses[0].name).toBe(runTool(connection));
    });

    test("re-addresses a direct call to an undeclared tool through run_tool as the client spells it", async () => {
      anthropicStubOptions.nonStreamingToolUse = {
        name: GITHUB_ISSUE_WRITE,
        input: { method: "create", title: "hello" },
      };

      const response = await send({
        messages: [
          { role: "user", content: "File a GitHub issue titled hello" },
        ],
        tools: gatewayMetaTools(connection),
      });

      expect(response.statusCode).toBe(200);
      // The client can only route the name it declared, never the platform's
      // own `archestra__run_tool`.
      expect(toolUsesOf(response.json())).toEqual([
        expect.objectContaining({
          name: runTool(connection),
          input: {
            tool_name: GITHUB_ISSUE_WRITE,
            tool_args: { method: "create", title: "hello" },
          },
        }),
      ]);
    });
  });

  // Nothing proves either spelling of run_tool is the gateway's: the marker
  // does not bind the client's label, so two spellings of one demote both.
  // The client still routes each to the real gateway, which runs the target.
  describe("with the gateway's run_tool registered under two labels", () => {
    const gateway = { label: "gw", attested: true };
    const tools = () => [
      ...gatewayMetaTools(gateway),
      ...gatewayMetaTools({ label: "archestra", attested: true }),
    ];

    test("releases a run_tool dispatch under a double registration", async () => {
      anthropicStubOptions.nonStreamingToolUse = issueWriteDispatch(gateway);

      const response = await send({
        messages: [
          { role: "user", content: "File a GitHub issue titled hello" },
        ],
        tools: tools(),
      });

      expect(response.statusCode).toBe(200);
      const toolUses = toolUsesOf(response.json());
      expect(toolUses).toHaveLength(1);
      expect(toolUses[0].name).toBe(runTool(gateway));
    });
  });

  // The model copies the client's decoration onto a name search_tools
  // returned. The attested run_tool shows what that decoration is.
  describe("with a decorated direct call to an undeclared tool", () => {
    const gateway = { label: "gw", attested: true };

    test("re-addresses it through run_tool without the decoration (Claude Code)", async () => {
      anthropicStubOptions.nonStreamingToolUse = {
        name: `mcp__gw__${GITHUB_ISSUE_WRITE}`,
        input: { method: "create", title: "hello" },
      };

      const response = await send({
        messages: [
          { role: "user", content: "File a GitHub issue titled hello" },
        ],
        tools: gatewayMetaTools(gateway),
      });

      expect(response.statusCode).toBe(200);
      expect(toolUsesOf(response.json())).toEqual([
        expect.objectContaining({
          name: runTool(gateway),
          input: {
            tool_name: GITHUB_ISSUE_WRITE,
            tool_args: { method: "create", title: "hello" },
          },
        }),
      ]);
    });

    test("re-addresses it through run_tool without the decoration (OpenCode)", async () => {
      openAiStubOptions.nonStreamingToolCalls = [
        {
          id: "call_opencode",
          name: `gw_${GITHUB_ISSUE_WRITE}`,
          arguments: JSON.stringify({ method: "create", title: "hello" }),
        },
      ];

      const response = await sendOpenCode({
        messages: [
          { role: "user", content: "File a GitHub issue titled hello" },
        ],
        tools: [
          declared("gw_archestra__run_tool", "archestra__run_tool"),
          declared("gw_archestra__search_tools", "archestra__search_tools"),
        ],
      });

      expect(response.statusCode).toBe(200);
      expect(openCodeToolCallsOf(response.json())).toEqual([
        {
          name: "gw_archestra__run_tool",
          input: {
            tool_name: GITHUB_ISSUE_WRITE,
            tool_args: { method: "create", title: "hello" },
          },
        },
      ]);
    });
  });

  // On a model with tool search, Codex declares only a client-run
  // `tool_search` and none of its MCP tools. The gateway's namespace, marked
  // descriptions included, reaches the proxy only in the search's output
  // item, which Codex puts back in the input.
  describe("Codex with tool search, under a label nothing anchors", () => {
    const member = (name: string) => ({
      type: "function",
      name,
      description: served(name),
      parameters: { type: "object", properties: {} },
    });

    const sendCodex = (params: {
      loaded: string[];
      prior: { tool: string; args: Record<string, unknown>; result: string };
      call: { name: string; args: Record<string, unknown> };
    }) => {
      responsesOutput = [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_codex",
          name: params.call.name,
          namespace: "mcp__gw",
          arguments: JSON.stringify(params.call.args),
          status: "completed",
        },
      ];
      return app.inject({
        method: "POST",
        url: `/v1/openai/${proxyAgent.id}/responses`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sk-test",
          originator: "codex_exec",
        },
        payload: {
          model: "gpt-4o",
          stream: false,
          input: [
            { role: "user", content: "Find the doc and file a GitHub issue" },
            {
              type: "tool_search_call",
              call_id: "search_1",
              execution: "client",
              arguments: { query: "github issue" },
              status: "completed",
            },
            {
              type: "tool_search_output",
              call_id: "search_1",
              execution: "client",
              status: "completed",
              tools: [
                {
                  type: "namespace",
                  name: "mcp__gw",
                  description: "Tools of the gw server",
                  tools: params.loaded.map(member),
                },
              ],
            },
            {
              type: "function_call",
              call_id: "call_prior",
              name: params.prior.tool,
              namespace: "mcp__gw",
              arguments: JSON.stringify(params.prior.args),
            },
            {
              type: "function_call_output",
              call_id: "call_prior",
              output: params.prior.result,
            },
          ],
          tools: [
            {
              type: "function",
              name: "shell",
              parameters: { type: "object", properties: {} },
            },
            { type: "tool_search", execution: "client", parameters: {} },
          ],
        },
      });
    };

    test("releases the gateway's run_tool dispatch and keeps attestations from the provider", async () => {
      const issueWrite = {
        tool_name: GITHUB_ISSUE_WRITE,
        tool_args: { method: "create", title: "hello" },
      };

      const response = await sendCodex({
        loaded: ["archestra__run_tool", "archestra__search_tools"],
        prior: {
          tool: "archestra__search_tools",
          args: { query: "github issue" },
          result: `${GITHUB_ISSUE_WRITE}: create or update an issue`,
        },
        call: { name: "archestra__run_tool", args: issueWrite },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(responsesCallsOf(response.body, false)).toEqual([
        {
          name: "archestra__run_tool",
          namespace: "mcp__gw",
          input: issueWrite,
        },
      ]);
      // Verified, then taken out of what the provider sees.
      expect(responsesRequests).toHaveLength(1);
      expect(JSON.stringify(responsesRequests)).not.toContain("[[gwa1.");
    });
  });

  // Codex declares each MCP server's tools in a `mcp__<label>` namespace and
  // calls them by bare name with the namespace beside it; the gateway's
  // attestation is keyed by that pair. Pointed at Azure Responses, it sends
  // the same wire as to OpenAI.
  describe("Codex over Azure Responses", () => {
    const member = (name: string) => ({
      type: "function",
      name,
      description: served(name),
      parameters: { type: "object", properties: {} },
    });
    const RUN_TOOL = "archestra__run_tool";
    const issueWrite = {
      tool_name: GITHUB_ISSUE_WRITE,
      tool_args: { method: "create", title: "hello" },
    };

    const sendAzure = (input: unknown[], stream: boolean) => {
      responsesOutput = [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_codex",
          name: RUN_TOOL,
          namespace: "mcp__gw",
          arguments: JSON.stringify(issueWrite),
          status: "completed",
        },
      ];
      return app.inject({
        method: "POST",
        url: `/v1/azure/${proxyAgent.id}/responses`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sk-test",
          originator: "codex_exec",
        },
        payload: {
          model: "gpt-4o",
          stream,
          input,
          tools: [
            {
              type: "namespace",
              name: "mcp__gw",
              tools: [member(RUN_TOOL), member("archestra__search_tools")],
            },
          ],
        },
      });
    };

    test.each([
      false,
      true,
    ])("releases the gateway's run_tool dispatch as the model wrote it (stream=%s)", async (stream) => {
      const response = await sendAzure(
        [{ role: "user", content: "File a GitHub issue titled hello" }],
        stream,
      );

      expect(response.statusCode, response.body).toBe(200);
      // A genuine dispatch, not a direct call to repair through run_tool.
      expect(responsesCallsOf(response.body, stream)).toEqual([
        { name: RUN_TOOL, namespace: "mcp__gw", input: issueWrite },
      ]);
    });
  });
});
