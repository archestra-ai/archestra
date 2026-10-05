import { AGENT_TOOL_PREFIX, isAgentTool, slugify } from "@archestra/shared";
import { type MockInstance, vi } from "vitest";
import config, { parseLlmProxyPlugins, parseOpenAppaConfig } from "@/config";
import * as database from "@/database";
import { ModelModel } from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import {
  AppaRewriteReplay,
  captureAppaReplayRequest,
} from "@/openappa/rewrite-replay";
import {
  isIssuedRuntimeToolProof,
  signRuntimeToolProof,
} from "@/openappa/runtime-tool-claims";
import { createAppaLlmProxyPlugin } from "@/proxy/plugins/appa-plugin-archestra";
import { APPA_AUXILIARY_ANALYSIS } from "@/proxy/plugins/appa-plugin-archestra/types";
import { registerLlmProxyPlugin } from "@/proxy/plugins/registry";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  createAnthropicTestClient,
  createOpenAiTestClient,
} from "@/test/llm-provider-stubs";
import { useRouteTestApp } from "@/test/route-test-app";
import type { Agent } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import { anthropicAdapterFactory, openaiAdapterFactory } from "./adapters";
import { openAiResponsesAdapterFactory } from "./adapters/openai-responses";
import anthropicProxyRoutes from "./routes/anthropic";
import openAiProxyRoutes from "./routes/openai";

const native = await vi.hoisted(async () => {
  const { createRuntimeModule } = await import(
    "@/test/openappa-runtime-module"
  );
  return createRuntimeModule();
});
vi.mock("@archestra/openappa-rs", () => native);
vi.mock("@/cache-manager");

const SECRET = "test-runtime-proof-final-boundary-secret";
// Structured HTTP input must pass Fastify's prototype-poisoning protection.
// Own __proto__ fidelity is exercised at the raw replay boundary in unit tests.
const LITERAL =
  '{ "prompt": "\\u0061", "n":1e0, "own_key":{"kept":true}, "data":{"runtime_proof":"ordinary data"} }';
const FAMILIES = [
  "anthropic:messages",
  "openai:chatCompletions",
  "openai:responses",
] as const;
type Family = (typeof FAMILIES)[number];
type Wrapping = "direct" | "object" | "string";
const CASES = FAMILIES.flatMap((family) =>
  (["direct", "object", "string"] as const).flatMap((wrapping) =>
    [false, true].map((stream) => ({ family, wrapping, stream })),
  ),
);

describe("issued runtime proofs at the final provider boundary", () => {
  const route = useRouteTestApp(async (app) => {
    await app.register(anthropicProxyRoutes);
    await app.register(openAiProxyRoutes);
  });
  let agent: Agent;
  let sessionId: string;
  let providerRequests: unknown[];
  let providerDispatches: MockInstance[];
  let unregister: () => void;
  let originalOpenappa: typeof config.openappa;
  let originalPlugins: typeof config.llmProxy.plugins;
  let originalSecrets: typeof config.secretsManager;

  beforeEach(async ({ makeAgent, makeConversation, makeMember }) => {
    originalOpenappa = config.openappa;
    originalPlugins = config.llmProxy.plugins;
    originalSecrets = config.secretsManager;
    config.openappa = {
      ...parseOpenAppaConfig("true"),
      offerSigningSecret: SECRET,
    };
    config.secretsManager = {
      ...config.secretsManager,
      encryptionSecret: "test-runtime-proof-retained-inverse-secret",
    };
    config.llmProxy.plugins = parseLlmProxyPlugins(undefined, true);
    await GuardrailsDeploymentModel.setEnabled(true);
    unregister = registerLlmProxyPlugin(createAppaLlmProxyPlugin());
    vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
      "postgresql://test:test@localhost/test?schema=public",
    );
    agent = await makeAgent({ organizationId: route.organizationId });
    await makeMember(route.user.id, route.organizationId);
    sessionId = (
      await makeConversation(agent.id, {
        userId: route.user.id,
        organizationId: route.organizationId,
      })
    ).id;
    providerRequests = [];
    providerDispatches = [
      vi.spyOn(anthropicAdapterFactory, "execute"),
      vi.spyOn(anthropicAdapterFactory, "executeStream"),
      vi.spyOn(openaiAdapterFactory, "execute"),
      vi.spyOn(openaiAdapterFactory, "executeStream"),
      vi.spyOn(openAiResponsesAdapterFactory, "execute"),
      vi.spyOn(openAiResponsesAdapterFactory, "executeStream"),
    ];
    native.initializeOpenappa.mockResolvedValue(undefined);
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      return JSON.stringify(
        event.event === "tool_call"
          ? {
              decision: "allow_call",
              ...(event.spawn ? { spawn_binding: "fork" } : {}),
            }
          : { decision: "ack" },
      );
    });
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(() => {
      const client = createAnthropicTestClient({ includeToolUse: false });
      const create = client.messages.create;
      client.messages.create = async (request) => {
        providerRequests.push(structuredClone(request));
        return create(request);
      };
      return client as never;
    });
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(() => {
      const client = createOpenAiTestClient({ nonStreamingToolCalls: [] });
      const create = client.chat.completions.create;
      client.chat.completions.create = async (request) => {
        providerRequests.push(structuredClone(request));
        return create(request);
      };
      return client as never;
    });
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockReturnValue({
      responses: {
        create: async (request: { stream?: boolean }) => {
          providerRequests.push(structuredClone(request));
          const response = {
            id: "resp_runtime_boundary",
            object: "response",
            created_at: 1,
            model: "gpt-4.1",
            status: "completed",
            output: [],
            usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
          };
          if (!request.stream) return response;
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "response.created",
                sequence_number: 0,
                response: { ...response, status: "in_progress", output: [] },
              };
              yield {
                type: "response.completed",
                sequence_number: 1,
                response,
              };
            },
          };
        },
      },
    } as never);
    for (const [provider, modelId] of [
      ["anthropic", "claude-3-5-sonnet-20241022"],
      ["openai", "gpt-4.1"],
    ] as const) {
      await ModelModel.upsert({
        externalId: `${provider}/${modelId}`,
        provider,
        modelId,
        inputModalities: null,
        outputModalities: null,
        lastSyncedAt: new Date(),
      });
    }
  });

  afterEach(async () => {
    await drainBackgroundWork();
    unregister();
    vi.restoreAllMocks();
    config.openappa = originalOpenappa;
    config.llmProxy.plugins = originalPlugins;
    config.secretsManager = originalSecrets;
  });

  const post = async (family: Family, body: Record<string, unknown>) => {
    const payload = JSON.stringify(body);
    const response = await route.app.inject({
      method: "POST",
      url:
        family === "anthropic:messages"
          ? `/v1/anthropic/${agent.id}/v1/messages`
          : `/v1/openai/${agent.id}/${family === "openai:responses" ? "responses" : "chat/completions"}`,
      remoteAddress: "127.0.0.1",
      headers: {
        authorization: "Bearer test-key",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-archestra-source": "chat",
        "x-archestra-user-id": route.user.id,
        "x-appa-session-id": sessionId,
      },
      payload,
    });
    expect(response.body).not.toContain("FST_ERR_CTP_INVALID_JSON_BODY");
    expect(response.body).not.toContain("Body is not valid JSON");
    return response;
  };

  const expectNoProviderDispatch = () => {
    for (const dispatch of providerDispatches)
      expect(dispatch).not.toHaveBeenCalled();
    expect(providerRequests).toEqual([]);
  };

  const issuedProof = (now = 1_000) => {
    const proof = signRuntimeToolProof({
      session: {
        organization_id: "foreign-org",
        caller_id: "user:foreign-owner",
        session_id: "foreign-source",
      },
      toolCallId: "runtime_orphan",
      action: "unknown_signed_action",
      arguments: JSON.parse(LITERAL),
      spawn: true,
      secret: config.openappa.offerSigningSecret,
      now,
    });
    if (!proof) throw new Error("Missing fixture runtime proof");
    expect(
      isIssuedRuntimeToolProof({
        proof,
        secret: config.openappa.offerSigningSecret,
      }),
    ).toBe(true);
    return proof;
  };

  test.for(
    CASES,
  )("refuses an issued orphan without alias or inverse while enforcement is off: $family/$wrapping/stream=$stream", async ({
    family,
    wrapping,
    stream,
  }) => {
    await GuardrailsDeploymentModel.setEnabled(false);
    const proof = issuedProof();
    const body = requestBody({
      family,
      stream,
      call: runtimeCall({ family, wrapping, proof }),
    });
    const response = await post(family, body);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.headers["x-should-retry"]).toBe("false");
    expect(response.body).toContain("issued runtime credential");
    expect(response.body).not.toContain(proof);
    expectNoProviderDispatch();
  });

  test.for(
    FAMILIES,
  )("refuses a future-issued agent credential when OpenAPPA is disabled: %s", async (family) => {
    config.openappa.enabled = false;
    await GuardrailsDeploymentModel.setEnabled(false);
    const proof = issuedProof(Math.floor(Date.now() / 1000) + 86_400);
    const name = `${AGENT_TOOL_PREFIX}${slugify(agent.name)}`;
    expect(isAgentTool(name)).toBe(true);
    const call = runtimeCall({
      family,
      wrapping: "direct",
      proof,
      name,
    });
    const response = await post(
      family,
      requestBody({ family, stream: false, call }),
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(response.body).toContain("issued runtime credential");
    expectNoProviderDispatch();
  });

  test.for(
    FAMILIES,
  )("refuses an issued orphan after governed projection: %s", async (family) => {
    const call = runtimeCall({
      family,
      wrapping: "object",
      proof: issuedProof(),
    });
    const response = await post(
      family,
      requestBody({ family, stream: false, call }),
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(response.body).toContain("issued runtime credential");
    expectNoProviderDispatch();
  });

  test.for(
    FAMILIES,
  )("reads the executable protocol slot despite ordinary shadow fields: %s", async (family) => {
    await GuardrailsDeploymentModel.setEnabled(false);
    const call = runtimeCall({
      family,
      wrapping: "direct",
      proof: issuedProof(),
    });
    if (family === "anthropic:messages") {
      call.arguments = "ordinary non-executable shadow";
    } else if (family === "openai:responses") {
      call.type = "custom_tool_call";
      call.input = call.arguments;
      call.arguments = "ordinary non-executable shadow";
    } else {
      (call.function as Record<string, unknown>).input = "ordinary shadow";
    }
    const response = await post(
      family,
      requestBody({ family, stream: false, call }),
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(response.body).toContain("issued runtime credential");
    expectNoProviderDispatch();
  });

  test.for(
    FAMILIES,
  )("refuses a credential added after auxiliary classification: %s", async (family) => {
    let auxiliary = false;
    const proof = issuedProof();
    const call = runtimeCall({ family, wrapping: "string", proof });
    const remove = registerLlmProxyPlugin({
      id: "test-final-runtime-credential-boundary",
      onBeforeModel: async (context) => {
        auxiliary = context.resources.get(APPA_AUXILIARY_ANALYSIS) === true;
        const body = context.request as Record<string, unknown>;
        const history = requestBody({ family, stream: false, call });
        body[family === "openai:responses" ? "input" : "messages"] =
          history[family === "openai:responses" ? "input" : "messages"];
      },
    });
    try {
      const body = requestBody({ family, stream: false });
      body.tools = [];
      const response = await post(family, body);
      expect(auxiliary, response.body).toBe(true);
      expect(response.statusCode, response.body).toBe(409);
      expectNoProviderDispatch();
    } finally {
      remove();
    }
  });

  test.for(
    CASES.filter(({ stream }) => !stream),
  )("restores the durable whole-call inverse before checking credentials: $family/$wrapping", async ({
    family,
    wrapping,
  }) => {
    const warmup = await post(family, requestBody({ family, stream: false }));
    expect(warmup.statusCode, warmup.body).toBe(200);
    const original = runtimeCall({ family, wrapping });
    const client = runtimeCall({ family, wrapping, proof: issuedProof() });
    const replay = await AppaRewriteReplay.open({
      session: {
        organization_id: agent.organizationId,
        caller_id: `user:${route.user.id}`,
        session_id: sessionId,
      },
      capture: captureAppaReplayRequest({
        family,
        body: requestBody({ family, stream: false }),
      }),
      encryptedChat: { kind: "none" },
    });
    const response = (call: Record<string, unknown>) =>
      family === "anthropic:messages"
        ? { role: "assistant", content: [call] }
        : family === "openai:chatCompletions"
          ? {
              choices: [{ message: { role: "assistant", tool_calls: [call] } }],
            }
          : { output: [call] };
    await replay.recordResponse({
      source: replay.captureResponse(response(original)),
      response: response(client),
      emitted: [{ id: "runtime_orphan" }],
    });
    providerRequests.length = 0;
    for (const dispatch of providerDispatches) dispatch.mockClear();
    const result = await post(
      family,
      requestBody({ family, stream: false, call: client }),
    );
    expect(result.statusCode, result.body).toBe(200);
    expect(providerRequests).toHaveLength(1);
    expect(
      providerDispatches.reduce(
        (count, dispatch) => count + dispatch.mock.calls.length,
        0,
      ),
    ).toBe(1);
    const final = providerRequests[0] as Record<string, unknown>;
    const calls =
      family === "openai:responses"
        ? (final.input as Record<string, unknown>[])
        : (final.messages as Record<string, unknown>[]).flatMap((message) =>
            message.role === "assistant"
              ? ((family === "anthropic:messages"
                  ? message.content
                  : message.tool_calls) as Record<string, unknown>[])
              : [],
          );
    expect(
      calls.find((call) => (call.call_id ?? call.id) === "runtime_orphan"),
    ).toEqual(original);
    expect(JSON.stringify(final)).not.toContain(issuedProof());
  });

  test.for(
    FAMILIES,
  )("keeps ordinary proof slots, schemas, results, quotes, and unknown literals unchanged: %s", async (family) => {
    await GuardrailsDeploymentModel.setEnabled(false);
    const proof = issuedProof();
    const ordinary = runtimeCall({
      family,
      wrapping: "string",
      proof: "ordinary runtime_proof data",
    });
    const body = requestBody({ family, stream: false, call: ordinary });
    const quoted = JSON.stringify({ runtime_proof: proof });
    const data = {
      runtime_proof: proof,
      schema: { runtime_proof: "ordinary schema property" },
    };
    const unknown = runtimeCall({
      family,
      wrapping: "direct",
      name: "ordinary_tool",
    });
    unknown[family === "openai:responses" ? "call_id" : "id"] =
      "ordinary_unknown";
    if (family === "anthropic:messages") {
      unknown.input = { runtime_proof: proof, data };
      (body.messages as unknown[]).push({
        role: "assistant",
        content: [unknown],
      });
      (body.messages as unknown[]).push({
        role: "user",
        content: [
          { type: "text", text: quoted },
          {
            type: "tool_result",
            tool_use_id: "runtime_orphan",
            content: JSON.stringify(data),
          },
        ],
      });
    } else if (family === "openai:chatCompletions") {
      (unknown.function as Record<string, unknown>).arguments =
        "unknown plain literal arguments";
      (body.messages as unknown[]).push({
        role: "assistant",
        tool_calls: [unknown],
        content: quoted,
      });
      (body.messages as unknown[]).push({
        role: "tool",
        tool_call_id: "runtime_orphan",
        content: JSON.stringify(data),
      });
    } else {
      unknown.arguments = "unknown plain literal arguments";
      (body.input as unknown[]).push(
        unknown,
        { role: "user", content: quoted },
        {
          type: "function_call_output",
          call_id: "runtime_orphan",
          output: JSON.stringify(data),
        },
      );
    }
    body.metadata =
      family === "anthropic:messages"
        ? { user_id: quoted }
        : { runtime_proof: "ordinary metadata" };
    if (family === "openai:chatCompletions") body.user = quoted;
    const tools = body.tools as Record<string, unknown>[];
    const schema = {
      type: "object",
      properties: { runtime_proof: { type: "string", const: proof } },
    };
    if (family === "anthropic:messages") tools[0].input_schema = schema;
    else if (family === "openai:chatCompletions")
      (tools[0].function as Record<string, unknown>).parameters = schema;
    else tools[0].parameters = schema;
    const before = structuredClone(body);
    const response = await post(family, body);
    expect(response.statusCode, response.body).toBe(200);
    expect(providerRequests).toHaveLength(1);
    const final = providerRequests[0] as Record<string, unknown>;
    const field = family === "openai:responses" ? "input" : "messages";
    expect(final[field]).toEqual(before[field]);
    expect(final.tools).toEqual(before.tools);
    if (family === "openai:chatCompletions") {
      // Chat's validated schema does not forward the undeclared metadata field.
      expect(final.metadata).toBeUndefined();
      expect(final.user).toEqual(before.user);
    } else {
      expect(final.metadata).toEqual(before.metadata);
    }
  });
});

function runtimeCall(params: {
  family: Family;
  wrapping: Wrapping;
  proof?: string;
  name?: string;
}): Record<string, unknown> {
  const literal = params.proof
    ? JSON.stringify({ ...JSON.parse(LITERAL), runtime_proof: params.proof })
    : LITERAL;
  const args =
    params.wrapping === "direct"
      ? literal
      : `{ "tool_name": "archestra__start_run", "runtime_proof": "ordinary wrapper data", "tool_args": ${params.wrapping === "string" ? JSON.stringify(literal) : literal} }`;
  const name =
    params.name ??
    (params.wrapping === "direct"
      ? "archestra__start_run"
      : "archestra__run_tool");
  return params.family === "anthropic:messages"
    ? { type: "tool_use", id: "runtime_orphan", name, input: JSON.parse(args) }
    : params.family === "openai:chatCompletions"
      ? {
          type: "function",
          id: "runtime_orphan",
          function: { name, arguments: args },
        }
      : {
          type: "function_call",
          call_id: "runtime_orphan",
          name,
          arguments: args,
        };
}

function requestBody(params: {
  family: Family;
  stream: boolean;
  call?: Record<string, unknown>;
}): Record<string, unknown> {
  const declarations = [
    "archestra__start_run",
    "archestra__run_tool",
    "archestra__execute_remedy_plan",
    "archestra__get_remedy_plans",
  ];
  const tools = declarations.map((name) =>
    params.family === "anthropic:messages"
      ? {
          name,
          description: "Runtime boundary fixture",
          input_schema: { type: "object", properties: {} },
        }
      : params.family === "openai:chatCompletions"
        ? {
            type: "function",
            function: {
              name,
              description: "Runtime boundary fixture",
              parameters: { type: "object", properties: {} },
            },
          }
        : {
            type: "function",
            name,
            description: "Runtime boundary fixture",
            parameters: { type: "object", properties: {} },
          },
  );
  const messages: unknown[] = [{ role: "user", content: "Continue" }];
  if (params.call)
    messages.push(
      params.family === "anthropic:messages"
        ? { role: "assistant", content: [params.call] }
        : { role: "assistant", content: null, tool_calls: [params.call] },
    );
  return {
    model:
      params.family === "anthropic:messages"
        ? "claude-3-5-sonnet-20241022"
        : "gpt-4.1",
    stream: params.stream,
    ...(params.family === "anthropic:messages" ? { max_tokens: 1024 } : {}),
    ...(params.family === "openai:responses"
      ? {
          input: [
            { role: "user", content: "Continue" },
            ...(params.call ? [params.call] : []),
          ],
        }
      : { messages }),
    tools,
  };
}
