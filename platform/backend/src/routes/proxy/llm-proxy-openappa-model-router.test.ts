/** OpenAPPA on Model Router routes that translate the client's wire to one
 * OpenAPPA does not read. The real route, translation, proxy handler and
 * OpenAPPA plugin run; only the native runtime and the provider's HTTP API
 * are faked. */

import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config, { parseLlmProxyPlugins, parseOpenAppaConfig } from "@/config";
import db, * as database from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import {
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import { openappaActor } from "@/openappa/actor";
import { createAppaLlmProxyPlugin } from "@/proxy/plugins/appa-plugin-archestra";
import { registerLlmProxyPlugin } from "@/proxy/plugins/registry";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import modelRouterRoutes from "./routes/model-router";

const native = vi.hoisted(() => ({
  initializeOpenappa: vi.fn(),
  dispatchHook: vi.fn(),
  loadChildReturns: vi.fn(
    async (
      _organizationId: string,
      _parentSessionId: string,
    ): Promise<
      Array<{
        childSessionId: string;
        spawnCallId?: string;
        childNativeId?: string;
        value: string;
      }>
    > => [],
  ),
  loadChildAddresses: vi.fn(async () => []),
  listBundledOpenappaBatteries: vi.fn(async () => []),
  parseOpenappaDeclarations: vi.fn(async () => ({
    include: [],
    serverAliases: [],
    credentials: [],
    routedAnnotators: [],
    runtimeCredentials: [],
    errors: [],
  })),
  validateHostedOpenappaPolicy: vi.fn(async () => []),
  composeOpenappaPolicy: vi.fn(async (input: { root: string }) => ({
    content: input.root,
    errors: [],
  })),
}));
vi.mock("@archestra/openappa-rs", () => native);
vi.mock("@/cache-manager");

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();
const geminiOrigin = "https://gemini.example.test";
const bedrockOrigin = "https://bedrock.example.test";
const geminiModel = "gemini-test-model";
const bedrockModel = "bedrock-test-model";
const spawnPrompt = "Find out why the build fails.";
/** The thought signature Gemini puts on its calls; it rides in the call id. */
const thoughtSignature = "signature-of-the-call";

describe("OpenAPPA on Model Router translated wires", () => {
  let app: FastifyInstanceWithZod;
  let agentId: string;
  let token: string;
  let userId: string;
  let events: Array<Record<string, unknown>>;
  /** The child values the runtime crossed, as it retains them. */
  let crossings: Array<{
    parentSessionId: string;
    childSessionId: string;
    spawnCallId?: string;
    childNativeId?: string;
    value: string;
  }>;
  /** The provider's answers, in order; a function answers one request. */
  let script: Array<(body: Record<string, unknown>) => ProviderTurn>;
  let providerRequests: Array<Record<string, unknown>>;
  let unregisterAppaPlugin: () => void;
  /** Whether Responses requests stream, as Kilo Code's do. */
  let stream: boolean;

  beforeEach(
    async ({
      makeAgent,
      makeLlmProviderApiKey,
      makeMember,
      makeSecret,
      makeUser,
    }) => {
      config.openappa = parseOpenAppaConfig();
      config.openappa.offerSigningSecret =
        "model-router-translated-secret-0123456789";
      await GuardrailsDeploymentModel.setEnabled(true);
      config.llmProxy.plugins = parseLlmProxyPlugins(undefined);
      unregisterAppaPlugin = registerLlmProxyPlugin(createAppaLlmProxyPlugin());
      vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
        "postgresql://test:test@localhost/test?schema=public",
      );
      config.llm.gemini.baseUrl = geminiOrigin;
      config.llm.gemini.vertexAi.enabled = false;
      config.llm.bedrock.baseUrl = bedrockOrigin;
      config.llm.bedrock.iamAuthEnabled = false;

      const agent = await makeAgent({
        name: "Model router translated",
        agentType: "agent",
      });
      agentId = agent.id;
      userId = (await makeUser()).id;
      await makeMember(userId, agent.organizationId);
      const providerKeys = [];
      for (const [provider, modelId] of [
        ["gemini", geminiModel],
        ["bedrock", bedrockModel],
      ] as const) {
        const model = await ModelModel.upsert({
          externalId: `${provider}/${modelId}`,
          provider,
          modelId,
          inputModalities: null,
          outputModalities: null,
          lastSyncedAt: new Date(),
        });
        const secret = await makeSecret({
          secret: { apiKey: `test-${provider}-key` },
        });
        const key = await makeLlmProviderApiKey(
          agent.organizationId,
          secret.id,
          { provider },
        );
        await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
          model.id,
        ]);
        providerKeys.push({ provider, providerApiKeyId: key.id });
      }
      token = (
        await VirtualApiKeyModel.create({
          name: "kilo-model-router",
          authorId: userId,
          scope: "personal",
          providerApiKeys: providerKeys,
        })
      ).value;

      stream = false;
      events = [];
      crossings = [];
      script = [];
      providerRequests = [];
      native.initializeOpenappa.mockResolvedValue(undefined);
      native.dispatchHook.mockImplementation(async (raw: string) => {
        const event = JSON.parse(raw);
        events.push(event);
        if (event.event === "session_start") {
          await db
            .insert(database.schema.openappaSessionsTable)
            .values({
              actor: openappaActor(String(event.session_id)),
              root: openappaActor(String(event.session_id)),
              organizationId: String(event.organization_id),
              callerId:
                typeof event.caller_id === "string" ? event.caller_id : null,
              sessionId: String(event.session_id),
              parentId:
                typeof event.parent_id === "string" ? event.parent_id : null,
              forkedFrom: null,
              startDecision: { decision: "ack" },
            })
            .onConflictDoNothing();
        }
        if (event.event === "tool_call")
          return JSON.stringify({
            decision: "allow_call",
            ...(event.spawn
              ? { spawn_binding: `fork:${event.operation_id}` }
              : {}),
          });
        if (event.event === "child_end") {
          if (String(event.operation_id).endsWith(":echo"))
            return JSON.stringify({ decision: "ack" });
          crossings.push({
            parentSessionId: String(event.parent_id),
            childSessionId: String(event.session_id),
            ...(event.spawn_call_id
              ? { spawnCallId: String(event.spawn_call_id) }
              : {}),
            ...(event.child_native_id
              ? { childNativeId: String(event.child_native_id) }
              : {}),
            value: String(event.output ?? ""),
          });
          return JSON.stringify({
            decision: "child_return",
            value: String(event.output ?? ""),
          });
        }
        return JSON.stringify({ decision: "ack" });
      });
      native.loadChildReturns.mockImplementation(
        async (_organizationId: string, parentSessionId: string) =>
          crossings
            .filter((crossing) => crossing.parentSessionId === parentSessionId)
            .reverse()
            .map(({ parentSessionId: _parent, ...record }) => record),
      );
      server.use(
        http.post(
          `${geminiOrigin}/v1beta/models/:action`,
          async ({ request, params }) => {
            const body = (await request.json()) as Record<string, unknown>;
            providerRequests.push(body);
            const next = script.shift();
            if (!next) throw new Error("unscripted provider request");
            const turn = next(body);
            const response = geminiResponse(turn);
            if (!String(params.action).endsWith(":streamGenerateContent"))
              return HttpResponse.json(response);
            return new HttpResponse(`data: ${JSON.stringify(response)}\n\n`, {
              headers: { "content-type": "text/event-stream" },
            });
          },
        ),
        http.post(
          `${bedrockOrigin}/model/:model/converse`,
          async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>;
            providerRequests.push(body);
            const next = script.shift();
            if (!next) throw new Error("unscripted provider request");
            return HttpResponse.json(bedrockResponse(next(body)));
          },
        ),
      );
      app = createFastifyInstance();
      await app.register(modelRouterRoutes);
    },
  );

  afterEach(async () => {
    unregisterAppaPlugin();
    vi.restoreAllMocks();
    await app.close();
  });

  /** Kilo Code's headers, as its Archestra routing plugin sends them. */
  const kiloHeaders = (session: string, parent?: string) => ({
    authorization: `Bearer ${token}`,
    "user-agent": "kilo/7.8.12",
    "x-archestra-agent-id": "kilo",
    "x-opencode-session": session,
    ...(parent ? { "x-parent-session-id": parent } : {}),
  });
  const tools = ["task", "archestra__get_remedy_plans", "archestra__yell"];

  /**
   * One Responses request from Kilo Code. A streamed answer comes back as
   * the body of its final `response.completed` event, so callers read both
   * alike.
   */
  const responses = async (params: {
    session: string;
    parent?: string;
    model?: string;
    input: unknown[];
  }) => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agentId}/responses`,
      headers: kiloHeaders(params.session, params.parent),
      payload: {
        model: params.model ?? `gemini:${geminiModel}`,
        stream,
        input: params.input,
        tools: tools.map((name) => ({
          type: "function",
          name,
          parameters: { type: "object", properties: {} },
          strict: false,
        })),
      },
    });
    if (!stream || response.statusCode !== 200) return response;
    const completed = response.body
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)))
      .find((event) => event.type === "response.completed");
    expect(completed, response.body).toBeDefined();
    return Object.assign(response, {
      body: JSON.stringify(completed.response),
    });
  };

  const chatCompletions = (params: {
    session: string;
    parent?: string;
    model: string;
    messages: unknown[];
  }) =>
    app.inject({
      method: "POST",
      url: `/v1/model-router/${agentId}/chat/completions`,
      headers: kiloHeaders(params.session, params.parent),
      payload: {
        model: params.model,
        stream: false,
        messages: params.messages,
        tools: tools.map((name) => ({
          type: "function",
          function: {
            name,
            parameters: { type: "object", properties: {} },
          },
        })),
      },
    });

  const userInput = (text: string) => ({
    role: "user",
    content: [{ type: "input_text", text }],
  });
  const outputText = (body: string) =>
    JSON.parse(body)
      .output.flatMap(
        (item: { content?: Array<{ text?: string }> }) => item.content ?? [],
      )
      .map((part: { text?: string }) => part.text ?? "")
      .join("");
  const releasedSpawn = (body: string) => {
    const call = JSON.parse(body).output.find(
      (item: { type: string; name?: string }) =>
        item.type === "function_call" && item.name === "task",
    );
    expect(call, body).toBeDefined();
    return call as { call_id: string; name: string; arguments: string };
  };
  const sessionStarts = () =>
    events.filter((event) => event.event === "session_start");
  /** The crossed child value and the display marker the parent receives. */
  const carrierFrom = (childBody: string, value: string) => {
    const code = outputText(childBody).match(
      /finished subagent (?:([A-Za-z0-9_-]+)\s+)?([0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4})/,
    );
    expect(code, childBody).not.toBeNull();
    const tag = code?.[1] ? `${code[1]} ` : "";
    return `${value}\n\n▄█▄▄▄█▄\n██▄█▄██  finished subagent ${tag}${code?.[2]}`;
  };
  const taskResult = (childId: string, text: string) =>
    `<task id="${childId}" state="completed">\n<summary>UNTRUSTED SUMMARY</summary>\n<task_result>\n${text}\n</task_result>\n</task>`;
  const forwarded = () => JSON.stringify(providerRequests);

  /**
   * The parent asks for a subagent, the subagent answers, and the parent
   * sends the subagent's result back. Returns what each side saw.
   */
  const runForegroundSubagent = async (params: {
    root: string;
    child: string;
    value: string;
    background?: boolean;
  }) => {
    script.push(
      () => ({
        call: {
          id: `call_${params.child}`,
          name: "task",
          args: {
            prompt: spawnPrompt,
            ...(params.background ? { background: true } : {}),
          },
        },
      }),
      () => ({ text: params.value }),
    );
    const parent = await responses({
      session: params.root,
      input: [userInput("Delegate the investigation")],
    });
    expect(parent.statusCode, parent.body).toBe(200);
    const spawn = releasedSpawn(parent.body);
    const markedPrompt = JSON.parse(spawn.arguments).prompt as string;
    expect(markedPrompt).toContain("[appa] delegated trajectory");
    const child = await responses({
      session: params.child,
      parent: params.root,
      input: [userInput(markedPrompt)],
    });
    expect(child.statusCode, child.body).toBe(200);
    return { spawn, child };
  };
  const spawnHistory = (spawn: { call_id: string; arguments: string }) => [
    userInput("Delegate the investigation"),
    {
      type: "function_call",
      call_id: spawn.call_id,
      name: "task",
      arguments: spawn.arguments,
    },
  ];

  test("binds the session Kilo Code names and its subagent as that session's child", async () => {
    const { child } = await runForegroundSubagent({
      root: "ses_root_a",
      child: "ses_child_a",
      value: "CHILD-ANSWER-1",
    });
    expect(outputText(child.body)).toContain("CHILD-ANSWER-1");
    const [rootStart, childStart] = sessionStarts();
    expect(rootStart.session_id).toBe(`user:${userId}|ses_root_a`);
    expect(childStart).toMatchObject({
      session_id: `user:${userId}|ses_root_a:ses_child_a`,
      parent_id: `user:${userId}|ses_root_a`,
    });
    expect(
      sessionStarts().some((event) =>
        String(event.session_id).endsWith(`@${agentId}`),
      ),
    ).toBe(false);
    // Neither marker reaches the provider through the translation.
    expect(forwarded()).not.toContain("delegated trajectory");
  });

  test.for([
    false,
    true,
  ])("admits a foreground subagent's crossed result and gives the model the crossed value (stream=%s)", async (streamed) => {
    stream = streamed;
    const { spawn, child } = await runForegroundSubagent({
      root: "ses_root_b",
      child: "ses_child_b",
      value: "CHILD-ANSWER-2",
    });
    // Gemini's call ids carry the thought signature on the client's wire.
    // The streamed Responses translation does not carry it (yet).
    if (!streamed) expect(spawn.call_id).toMatch(/^gemsig-/);
    providerRequests.length = 0;
    script.push(() => ({ text: "Parent done" }));
    const parent = await responses({
      session: "ses_root_b",
      input: [
        ...spawnHistory(spawn),
        {
          type: "function_call_output",
          call_id: spawn.call_id,
          output: taskResult(
            "ses_child_b",
            carrierFrom(child.body, "CHILD-ANSWER-2"),
          ),
        },
      ],
    });
    expect(parent.statusCode, parent.body).toBe(200);
    expect(outputText(parent.body)).toContain("Parent done");
    expect(forwarded()).toContain("CHILD-ANSWER-2");
    expect(forwarded()).not.toContain("UNTRUSTED SUMMARY");
    expect(forwarded()).not.toContain("finished subagent");
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "tool_result",
        session_id: `user:${userId}|ses_root_b`,
        spawned_id: `user:${userId}|ses_root_b:ses_child_b`,
        output: "CHILD-ANSWER-2",
      }),
    );
  });

  test("admits a background subagent's start acknowledgement and then its crossed result", async () => {
    const { spawn, child } = await runForegroundSubagent({
      root: "ses_root_c",
      child: "ses_child_c",
      value: "CHILD-ANSWER-3",
      background: true,
    });
    const acknowledgement = {
      type: "function_call_output",
      call_id: spawn.call_id,
      // Kilo Code 7.8's acknowledgement, which wraps its notice in
      // <task_result>.
      output:
        '<task id="ses_child_c" state="running">\n<summary>Background task started</summary>\n<task_result>\nThe task is working in the background. You will be notified automatically when it finishes.\n</task_result>\n</task>',
    };
    script.push(() => ({ text: "Waiting for the subagent" }));
    const waiting = await responses({
      session: "ses_root_c",
      input: [...spawnHistory(spawn), acknowledgement],
    });
    expect(waiting.statusCode, waiting.body).toBe(200);

    providerRequests.length = 0;
    script.push(() => ({ text: "Parent done" }));
    const finished = await responses({
      session: "ses_root_c",
      input: [
        ...spawnHistory(spawn),
        acknowledgement,
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Waiting for the subagent" }],
        },
        // Kilo Code sends the completion as its own part of a user message,
        // which can carry other parts beside it.
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: taskResult(
                "ses_child_c",
                carrierFrom(child.body, "CHILD-ANSWER-3"),
              ),
            },
            { type: "input_text", text: "Continue with the result." },
          ],
        },
      ],
    });
    expect(finished.statusCode, finished.body).toBe(200);
    expect(forwarded()).toContain("CHILD-ANSWER-3");
    expect(forwarded()).not.toContain("UNTRUSTED SUMMARY");
    expect(forwarded()).not.toContain("finished subagent");
  });

  test("closes a subagent that failed before its first request, and the parent goes on", async () => {
    script.push(() => ({
      call: {
        id: "call_ses_child_failed",
        name: "task",
        args: { prompt: spawnPrompt },
      },
    }));
    const parent = await responses({
      session: "ses_root_failed",
      input: [userInput("Delegate the investigation")],
    });
    expect(parent.statusCode, parent.body).toBe(200);
    const spawn = releasedSpawn(parent.body);
    // No child bound the prepared fork. The runtime closes it as failed and
    // withholds the client's text.
    const reason =
      "the spawn did not take: no prepared fork to open this child";
    const dispatch = native.dispatchHook.getMockImplementation();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      if (event.event !== "tool_result" || event.outcome !== "failure")
        return dispatch?.(raw);
      events.push(event);
      return JSON.stringify({
        decision: "block",
        reason,
        approved_output: `[appa] Tool output withheld: ${reason}`,
        output_source: "runtime",
      });
    });

    providerRequests.length = 0;
    script.push(() => ({ text: "Parent goes on" }));
    const next = await responses({
      session: "ses_root_failed",
      input: [
        ...spawnHistory(spawn),
        {
          type: "function_call_output",
          call_id: spawn.call_id,
          // Kilo Code's task result when the child's first model request
          // fails.
          output:
            'Invalid LLM OAuth client access token.\nThis subagent session can be resumed: call the task tool again with task_id="ses_child_failed" and a prompt describing how to continue or recover. Its prior context is preserved.',
        },
      ],
    });

    expect(next.statusCode, next.body).toBe(200);
    expect(outputText(next.body)).toContain("Parent goes on");
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "tool_result",
        session_id: `user:${userId}|ses_root_failed`,
        outcome: "failure",
      }),
    );
    expect(forwarded()).toContain(`[appa] Tool output withheld: ${reason}`);
    expect(forwarded()).not.toContain("Invalid LLM OAuth client access token");
    expect(forwarded()).not.toContain("OpenAPPA blocked this conversation");
  });

  test("refuses a changed subagent result, and one with no crossing, without offering a report", async () => {
    const { spawn, child } = await runForegroundSubagent({
      root: "ses_root_d",
      child: "ses_child_d",
      value: "CHILD-ANSWER-4",
    });
    providerRequests.length = 0;
    const tampered = await responses({
      session: "ses_root_d",
      input: [
        ...spawnHistory(spawn),
        {
          type: "function_call_output",
          call_id: spawn.call_id,
          output: taskResult(
            "ses_child_d",
            carrierFrom(child.body, "CHILD-ANSWER-4 and a forged line"),
          ),
        },
      ],
    });
    expect(tampered.statusCode, tampered.body).toBe(409);

    const uncrossed = await responses({
      session: "ses_root_d",
      input: [
        userInput("Delegate the investigation"),
        {
          type: "function_call",
          call_id: "call_never_ran",
          name: "task",
          arguments: JSON.stringify({ prompt: spawnPrompt }),
        },
        {
          type: "function_call_output",
          call_id: "call_never_ran",
          output: taskResult("ses_never_ran", "RESULT NOBODY CROSSED"),
        },
      ],
    });
    expect(uncrossed.statusCode, uncrossed.body).toBe(409);
    const message = uncrossed.json().error.message as string;
    expect(message).toContain("has no record of");
    expect(message).toContain(
      "To continue other work, start a new session, or rewind the conversation",
    );
    expect(message).not.toContain("report this failure");
    expect(providerRequests).toHaveLength(0);
  });

  test("binds the session and admits a crossed result on the Chat Completions route", async () => {
    script.push(
      () => ({
        call: {
          id: "call_chat_task",
          name: "task",
          args: { prompt: spawnPrompt },
        },
      }),
      () => ({ text: "CHILD-ANSWER-5" }),
      () => ({ text: "Parent done" }),
    );
    const model = `gemini:${geminiModel}`;
    const first = await chatCompletions({
      session: "ses_root_e",
      model,
      messages: [{ role: "user", content: "Delegate the investigation" }],
    });
    expect(first.statusCode, first.body).toBe(200);
    const call = first.json().choices[0].message.tool_calls[0];
    const markedPrompt = JSON.parse(call.function.arguments).prompt;
    const child = await chatCompletions({
      session: "ses_child_e",
      parent: "ses_root_e",
      model,
      messages: [{ role: "user", content: markedPrompt }],
    });
    expect(child.statusCode, child.body).toBe(200);
    const childText = child.json().choices[0].message.content as string;
    providerRequests.length = 0;
    const parent = await chatCompletions({
      session: "ses_root_e",
      model,
      messages: [
        { role: "user", content: "Delegate the investigation" },
        { role: "assistant", content: null, tool_calls: [call] },
        {
          role: "tool",
          tool_call_id: call.id,
          content: taskResult(
            "ses_child_e",
            carrierFrom(
              JSON.stringify({
                output: [{ content: [{ text: childText }] }],
              }),
              "CHILD-ANSWER-5",
            ),
          ),
        },
      ],
    });
    expect(parent.statusCode, parent.body).toBe(200);
    expect(sessionStarts()[0].session_id).toBe(`user:${userId}|ses_root_e`);
    expect(forwarded()).toContain("CHILD-ANSWER-5");
    expect(forwarded()).not.toContain("UNTRUSTED SUMMARY");
  });

  test("gives a Bedrock target the same session and subagent checks", async () => {
    script.push(() => ({ text: "Ready" }));
    const opened = await chatCompletions({
      session: "ses_root_f",
      model: `bedrock:${bedrockModel}`,
      messages: [{ role: "user", content: "Start" }],
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(sessionStarts()[0].session_id).toBe(`user:${userId}|ses_root_f`);
    providerRequests.length = 0;
    const refused = await chatCompletions({
      session: "ses_root_f",
      model: `bedrock:${bedrockModel}`,
      messages: [
        { role: "user", content: "Delegate the investigation" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_bedrock_task",
              type: "function",
              function: {
                name: "task",
                arguments: JSON.stringify({ prompt: spawnPrompt }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_bedrock_task",
          content: taskResult("ses_bedrock_child", "RESULT NOBODY CROSSED"),
        },
      ],
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.message).toContain("has no record of");
    expect(refused.json().error.message).not.toContain("report this failure");
    expect(providerRequests).toHaveLength(0);
  });
});

// ===

type ProviderTurn =
  | { text: string }
  | { call: { id: string; name: string; args: Record<string, unknown> } };

function geminiResponse(turn: ProviderTurn) {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts:
            "text" in turn
              ? [{ text: turn.text }]
              : [{ functionCall: turn.call, thoughtSignature }],
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    },
    modelVersion: geminiModel,
  };
}

function bedrockResponse(turn: ProviderTurn) {
  return {
    output: {
      message: {
        role: "assistant",
        content:
          "text" in turn
            ? [{ text: turn.text }]
            : [
                {
                  toolUse: {
                    toolUseId: turn.call.id,
                    name: turn.call.name,
                    input: turn.call.args,
                  },
                },
              ],
      },
    },
    stopReason: "text" in turn ? "end_turn" : "tool_use",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}
