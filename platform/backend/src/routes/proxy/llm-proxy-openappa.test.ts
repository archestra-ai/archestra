import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractMcpHumanRuling } from "@archestra/shared";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { attestToolDescription } from "@/archestra-mcp-server/tool-attestation";
import { createChatMcpElicitationBridge } from "@/clients/chat-mcp-elicitation";
import {
  buildMcpGatewayTool,
  mcpToolToModelOutput,
} from "@/clients/chat-tool-builder";
import { internalCallHeader } from "@/clients/internal-call";
import { ToolCallRepeatTracker } from "@/clients/tool-call-repeat-tracker";
import config from "@/config";
import db, * as database from "@/database";
import { ModelModel, OpenAppaSessionModel } from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import OpenAppaUnenforcedModel from "@/models/openappa-unenforced";
import { scopedSessionId } from "@/openappa/actor";
import { mintChildReturnMarker } from "@/openappa/child-return";
import { mintDelegationMarker } from "@/openappa/delegation";
import {
  consumeHitlRuling,
  getHitlAskUserArguments,
  getHitlReview,
  getHitlReviewResult,
  peekHitlDecision,
  stageHitlReview,
} from "@/openappa/hitl-review";
import { readNotice } from "@/openappa/notice";
import * as appaService from "@/openappa/service";
import { appendSessionReceipt } from "@/openappa/session-token";
import { mintSubagentBinding } from "@/openappa/subagent-binding";
import {
  parseTrajectoryStamp,
  stampToolCallId,
} from "@/openappa/trajectory-stamp";
import { superyellSession } from "@/openappa/unenforced";
import { createAppaLlmProxyPlugin } from "@/proxy/plugins/appa-plugin-archestra";
import { registerLlmProxyPlugin } from "@/proxy/plugins/registry";
import { grokToolName } from "@/routes/mcp-gateway/grok-tool-names";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { createOpenAiTestClient } from "@/test/llm-provider-stubs";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { native } from "@/test/openappa-native-mock";
import {
  codexResponseStream,
  noticeFrom,
  useOpenAppaProxyHarness,
} from "@/test/openappa-proxy-harness";
import { drainBackgroundWork } from "@/utils/background-work";
import { openaiAdapterFactory } from "./adapters";
import { openAiResponsesAdapterFactory } from "./adapters/openai-responses";
import openAiProxyRoutes from "./routes/openai";

vi.mock(
  "@archestra/openappa-rs",
  async () => (await import("@/test/openappa-native-mock")).native,
);
vi.mock("@/cache-manager");

describe("OpenAPPA on the existing LLM proxy", () => {
  const h = useOpenAppaProxyHarness();

  describe("a waived session keeps its governed request shape", () => {
    const refusal =
      "[appa] NATIVE REFUSAL: execute_remedy_plan(offer_id: test-offer)";
    const send = (messages?: unknown[]) =>
      h.post(h.payload(false, messages), { "x-archestra-source": "api" });
    const shapeOf = (index: number) => {
      const { tools, system } = h.providerRequests[index] as {
        tools: unknown;
        system: unknown;
      };
      return { tools, system };
    };
    const toolNames = (index: number) =>
      (h.providerRequests[index] as { tools: { name: string }[] }).tools.map(
        (tool) => tool.name,
      );
    const expectSuperyelled = async () => {
      const started = h.events.find((event) => event.event === "session_start");
      expect(
        await OpenAppaUnenforcedModel.findSessions({
          organizationId: h.agent.organizationId,
          sessionIds: [String(started?.session_id)],
        }),
      ).toEqual([expect.objectContaining({ reason: "superyell" })]);
    };
    let restoreConfig: () => void;

    beforeEach(() => {
      const overrides = config.openappa.breakTheGlassOverrides;
      const yellEnabled = config.openappa.yellEnabled;
      config.openappa.breakTheGlassOverrides = {
        ...overrides,
        unapprovableBlockMode: "allow",
      };
      config.openappa.yellEnabled = false;
      restoreConfig = () => {
        config.openappa.breakTheGlassOverrides = overrides;
        config.openappa.yellEnabled = yellEnabled;
      };
    });

    afterEach(() => restoreConfig());

    test("after a tool call is waived", async () => {
      expect((await send()).statusCode).toBe(200);
      h.block = true;
      expect((await send()).statusCode).toBe(200);
      await expectSuperyelled();
      h.block = false;
      expect((await send()).statusCode).toBe(200);

      expect(toolNames(0)).toEqual([
        "get_weather",
        "archestra__execute_remedy_plan",
      ]);
      expect(shapeOf(0).system).toBeDefined();
      expect(shapeOf(2)).toEqual(shapeOf(0));

      const threadCreate = await h.post(
        { ...h.payload(false), thread: { type: "create" } },
        { "x-archestra-source": "api" },
      );
      expect(threadCreate.statusCode, threadCreate.body).toBe(200);
      expect(shapeOf(3)).toEqual(shapeOf(0));
    });

    test("not for a session that inherited its waiver and never ran governed", async () => {
      await OpenAppaUnenforcedModel.recordSession({
        organizationId: h.agent.organizationId,
        sessionId: scopedSessionId(`user:${h.userId}`, h.sessionId),
        parentId: undefined,
        reason: "superyell",
      });

      expect((await send()).statusCode).toBe(200);

      expect(h.events).toEqual([]);
      expect(toolNames(0)).toEqual([
        "get_weather",
        "archestra__execute_remedy_plan",
        "archestra__get_remedy_plans",
      ]);
      expect(shapeOf(0).system).toBeUndefined();
    });

    test("on the request whose tool result is waived", async () => {
      const first = await send();
      expect(first.statusCode, first.body).toBe(200);
      const toolUse = first
        .json()
        .content.find((item: { type: string }) => item.type === "tool_use");
      const dispatch = native.dispatchHook.getMockImplementation();
      native.dispatchHook.mockImplementation(async (raw: string) =>
        JSON.parse(raw).event === "tool_result"
          ? JSON.stringify({
              decision: "replace_output",
              feedback: refusal,
              approved_output: refusal,
              output_source: "runtime",
            })
          : dispatch?.(raw),
      );

      const second = await send([
        { role: "user", content: "Check the weather" },
        { role: "assistant", content: [toolUse] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: toolUse.id, content: "Sunny" },
          ],
        },
      ]);

      expect(second.statusCode, second.body).toBe(200);
      await expectSuperyelled();
      expect(shapeOf(1)).toEqual(shapeOf(0));
    });
  });

  test.for([
    { outcome: "review_unanswered", answer: { status: "unanswered" } },
    {
      outcome: "review_cancelled",
      answer: { status: "answered", result: { action: "cancel" } },
    },
  ] as const)("preserves Chat $outcome feedback across the bound OpenAI proxy and real Chat gateway tool", async ({
    outcome,
    answer,
  }, {
    seedAndAssignArchestraTools,
    makeConversation,
    makeUser,
    makeMember,
  }) => {
    await seedAndAssignArchestraTools(h.agent.id);
    await h.app.register(openAiProxyRoutes);
    await ModelModel.upsert({
      externalId: "openai/gpt-6-luna",
      provider: "openai",
      modelId: "gpt-6-luna",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
    const toolName = "archestra__execute_remedy_plan";
    const callId = "call_review_binding";
    const offerId = "offer-review-binding";
    let providerCalls = [
      {
        id: callId,
        name: toolName,
        arguments: JSON.stringify({
          offer_id: offerId,
          plan: "Submit for approval",
        }),
      },
    ];
    const sent: Array<
      Parameters<
        ReturnType<
          typeof createOpenAiTestClient
        >["chat"]["completions"]["create"]
      >[0]
    > = [];
    const dispatch = native.dispatchHook.getMockImplementation();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const hook = JSON.parse(raw);
      if (hook.event !== "tool_result") return dispatch?.(raw);
      h.events.push(hook);
      return JSON.stringify({
        decision: "replace_output",
        code: "unreleased_call",
        output_source: "runtime",
        approved_output:
          "[appa] Tool output withheld: this result has no record of releasing a call.",
      });
    });
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(() => {
      const provider = createOpenAiTestClient({
        nonStreamingToolCalls: providerCalls,
      });
      const create = provider.chat.completions.create;
      provider.chat.completions.create = async (params) => {
        sent.push(structuredClone(params));
        return create(params);
      };
      return provider as never;
    });
    const body = {
      model: "gpt-6-luna",
      stream: false,
      messages: [{ role: "user", content: "Review this exact call" }],
      tools: [toolName, "archestra__get_remedy_plans"].map((name) => ({
        type: "function",
        function: {
          name,
          description: name,
          parameters: { type: "object", properties: {} },
        },
      })),
    };
    const requestHeaders = {
      authorization: "Bearer test-key",
      "x-archestra-virtual-key": h.platformKey,
      "x-archestra-user-id": h.userId,
      "x-appa-session-id": h.sessionId,
      "x-archestra-source": "chat",
    };
    const submit = (
      requestBody: unknown,
      extraHeaders: Record<string, string> = {},
    ) =>
      h.app.inject({
        method: "POST",
        url: `/v1/openai/${h.agent.id}/chat/completions`,
        remoteAddress: "127.0.0.1",
        headers: {
          ...internalCallHeader(),
          ...requestHeaders,
          ...extraHeaders,
        },
        payload: requestBody as Record<string, unknown>,
      });
    const proposal = await submit(body);
    expect(proposal.statusCode, proposal.body).toBe(200);
    const call = proposal.json().choices[0].message.tool_calls[0];
    const args = JSON.parse(call.function.arguments);
    const started = h.events.find((event) => event.event === "session_start");
    expect(started).toBeDefined();
    expect(args.trajectory.session_id).toBe(started?.session_id);
    expect(args.execution.call_id).toBe(callId);
    expect(started?.caller_id).toBe(`user:${h.userId}`);
    expect(args.trajectory.session_id).toBe(h.sessionId);
    const runtimeSession = {
      organization_id: h.agent.organizationId,
      session_id: args.trajectory.session_id,
      caller_id: `user:${h.userId}`,
    };
    const loadReview = vi
      .spyOn(appaService, "loadOfferReview")
      .mockResolvedValue({
        offer_id: offerId,
        session_id: runtimeSession.session_id,
        text: "Review this call",
      });
    const executeNative = vi.spyOn(appaService, "executeRemedyByOffer");
    const elicitation = createChatMcpElicitationBridge({
      conversationId: h.sessionId,
    });
    vi.spyOn(elicitation, "elicit").mockResolvedValue(answer);
    const gatewayTool = buildMcpGatewayTool({
      mcpTool: {
        name: toolName,
        inputSchema: { type: "object", properties: {} },
      },
      ctx: {
        agentId: h.agent.id,
        agentName: h.agent.name,
        organizationId: h.agent.organizationId,
        userId: h.userId,
        conversationId: h.sessionId,
        scopeKey: h.sessionId,
        elicitation,
        mcpGwToken: {
          tokenValue: "test-token",
          tokenId: "test-token-id",
          teamId: null,
          isOrganizationToken: false,
        },
        repeatTracker: new ToolCallRepeatTracker(),
        modelAcceptsImageToolResults: false,
      },
    });
    if (!gatewayTool.execute) throw new Error("Missing Chat gateway execute");
    const rawResult = await gatewayTool.execute(args, {
      // The stamped execution ID, not a decorated host ID, binds history.
      toolCallId: "host-decorated-call",
      messages: [],
    });
    const modelOutput = mcpToolToModelOutput({ output: rawResult });
    expect(extractMcpHumanRuling(rawResult)).toBeNull();
    expect(modelOutput.type).toBe("text");
    if (modelOutput.type !== "text")
      throw new Error("Expected Chat text output");
    expect(JSON.parse(modelOutput.value)).toMatchObject({
      ok: false,
      outcome,
      offer_id: offerId,
    });
    expect(executeNative).not.toHaveBeenCalled();
    expect(loadReview).toHaveBeenCalledWith({
      organizationId: h.agent.organizationId,
      sessionId: runtimeSession.session_id,
      offerId,
    });
    expect(
      await getHitlReviewResult({ session: runtimeSession, callId, offerId }),
    ).toEqual({ outcome: outcome });
    expect(
      await getHitlReviewResult({
        session: runtimeSession,
        callId: "host-decorated-call",
        offerId,
      }),
    ).toBeUndefined();
    const closure =
      outcome === "review_unanswered" ? "unanswered" : "cancelled";
    expect(await consumeHitlRuling({ session: runtimeSession, offerId })).toBe(
      "none",
    );
    expect(
      await peekHitlDecision({ session: runtimeSession, offerId }),
    ).toEqual({ ruling: "none", closure });
    expect(
      await getHitlReview({ session: runtimeSession, offerId }),
    ).toBeUndefined();
    expect(await consumeHitlRuling({ session: runtimeSession, offerId })).toBe(
      "none",
    );
    expect(
      await stageHitlReview({
        session: runtimeSession,
        review: { offerId, text: "Review this call" },
        callId: "late-restage",
      }),
    ).toEqual({ status: "none", closure });
    expect(
      await getHitlAskUserArguments({
        session: runtimeSession,
        offerIds: [offerId],
      }),
    ).toBeUndefined();
    expect(executeNative).not.toHaveBeenCalled();
    expect(extractMcpHumanRuling(rawResult)).toBeNull();
    providerCalls = [];
    const nextBody = {
      ...body,
      messages: [
        ...body.messages,
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: callId, content: modelOutput.value },
      ],
    };
    const next = await submit(nextBody);
    expect(next.statusCode, next.body).toBe(200);
    const resultMessage = sent
      .at(-1)
      ?.messages.find((message) => message.role === "tool");
    expect(resultMessage?.content).toEqual(expect.any(String));
    const visible = JSON.parse(String(resultMessage?.content));
    expect(visible).toMatchObject({ ok: false, outcome, offer_id: offerId });
    expect(visible.instruction).toContain(
      outcome === "review_unanswered"
        ? "expired without an answer"
        : "canceled the approval review",
    );
    expect(visible.instruction).toContain("no ruling was granted");
    expect(String(resultMessage?.content)).not.toMatch(
      /withheld|cannot be reached|Authorized|Denied:/,
    );
    expect(h.events.filter((event) => event.event === "remedy")).toEqual([]);
    expect(h.events.filter((event) => event.event === "tool_result")).toEqual([
      expect.objectContaining({
        session_id: h.sessionId,
        caller_id: `user:${h.userId}`,
        tool_call_id: callId,
      }),
    ]);
    expect(executeNative).not.toHaveBeenCalled();
    const otherConversation = await makeConversation(h.agent.id, {
      userId: h.userId,
      organizationId: h.agent.organizationId,
    });
    const foreign = await submit(nextBody, {
      "x-appa-session-id": otherConversation.id,
    });
    expect(foreign.statusCode, foreign.body).toBe(200);
    const foreignResult = sent
      .at(-1)
      ?.messages.find((message) => message.role === "tool");
    expect(foreignResult?.content).toContain("withheld");
    expect(foreignResult?.content).not.toContain(outcome);
    const otherUser = await makeUser();
    await makeMember(otherUser.id, h.agent.organizationId);
    expect(
      await getHitlReviewResult({
        session: { ...runtimeSession, caller_id: `user:${otherUser.id}` },
        callId,
        offerId,
      }),
    ).toBeUndefined();
    const requestsBeforeForeignOwner = sent.length;
    const foreignOwner = await submit(nextBody, {
      "x-archestra-user-id": otherUser.id,
      "x-archestra-virtual-key": await makePassthroughCredential({
        organizationId: h.agent.organizationId,
        ownerId: otherUser.id,
      }),
    });
    expect(foreignOwner.statusCode).toBe(403);
    expect(sent).toHaveLength(requestsBeforeForeignOwner);
  });

  test("Grok's real proxy boundary returns signed deferred denial notices through use_tool", async ({
    seedAndAssignArchestraTools,
  }) => {
    await seedAndAssignArchestraTools(h.agent.id);
    await h.app.register(openAiProxyRoutes);
    await ModelModel.upsert({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
    const sent: unknown[] = [];
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(() => {
      const client = createOpenAiTestClient({
        nonStreamingToolCalls: [
          {
            id: "grok-write",
            name: "write",
            arguments:
              '{"file_path":"/synthetic/note.txt","content":"synthetic"}',
          },
        ],
      });
      const create = client.chat.completions.create;
      client.chat.completions.create = async (params) => {
        sent.push(structuredClone(params));
        return create(params);
      };
      return client as never;
    });
    const tools = ["get_remedy_plans", "execute_remedy_plan", "ask_user"].map(
      (name) => ({
        tool_name: `gateway__archestra__${name}`,
        description: attestToolDescription({
          organizationId: h.agent.organizationId,
          gatewayId: h.agent.id,
          advertisedName: `archestra__${name}`,
          kind: "b",
          description: "Synthetic gateway control",
        }),
        input_schema: { type: "object", additionalProperties: true },
      }),
    );
    h.block = true;
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/openai/${h.agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-virtual-key": h.platformKey,
        "x-archestra-agent-id": "grok-build",
        "x-grok-session-id": "grok-deferred-http",
        "x-appa-session-id": "grok-deferred-http",
        "x-grok-client-mode": "interactive",
      },
      payload: {
        model: "gpt-4o",
        stream: false,
        tools: ["write", "use_tool", "search_tool", "ask_user_question"].map(
          (name) => ({
            type: "function",
            function: { name, parameters: { type: "object" } },
          }),
        ),
        messages: [
          { role: "user", content: "Synthetic Grok request" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "grok-search",
                type: "function",
                function: {
                  name: "search_tool",
                  arguments: '{"query":"gateway remedy"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "grok-search",
            content: JSON.stringify({
              results: [{ server: "gateway", tools }],
              status: "ready",
              total_hidden_tools: 3,
              note: null,
            }),
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const calls = response.json().choices[0].message.tool_calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("use_tool");
    const wrapped = JSON.parse(calls[0].function.arguments);
    expect(wrapped.tool_name).toBe("gateway__archestra__get_remedy_plans");
    expect(
      readNotice({ callId: "grok-write", arguments: wrapped.tool_input })?.tool,
    ).toBe("write");
    expect(JSON.stringify(sent)).not.toContain("[[gwa1");
    expect(
      h.events.some(
        (event) => event.event === "tool_call" && event.tool === "Write",
      ),
    ).toBe(true);
  });

  for (const denied of [false, true]) {
    test(`Grok's real proxy boundary repairs progressive dispatch and preserves policy denial (${denied})`, async ({
      seedAndAssignArchestraTools,
    }) => {
      await seedAndAssignArchestraTools(h.agent.id);
      await h.app.register(openAiProxyRoutes);
      await ModelModel.upsert({
        externalId: "openai/gpt-4o",
        provider: "openai",
        modelId: "gpt-4o",
        inputModalities: null,
        outputModalities: null,
        lastSyncedAt: new Date(),
      });
      const input = { limit: 3 };
      vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
        () =>
          createOpenAiTestClient({
            nonStreamingToolCalls: [
              {
                id: "progressive",
                name: "use_tool",
                arguments: JSON.stringify({
                  tool_name: "archestra__list_skills",
                  tool_input: input,
                }),
              },
            ],
          }) as never,
      );
      const names = [
        "run_tool",
        "search_tools",
        "get_remedy_plans",
        "execute_remedy_plan",
        "ask_user",
      ];
      const tools = names.map((name) => ({
        tool_name: `gateway__${grokToolName(`archestra__${name}`)}`,
        description: attestToolDescription({
          organizationId: h.agent.organizationId,
          gatewayId: h.agent.id,
          advertisedName: `archestra__${name}`,
          kind: "b",
          description: "Synthetic progressive gateway",
        }),
        input_schema: { type: "object", additionalProperties: true },
      }));
      h.block = denied;
      const response = await h.app.inject({
        method: "POST",
        url: `/v1/openai/${h.agent.id}/chat/completions`,
        headers: {
          authorization: "Bearer test-key",
          "x-archestra-virtual-key": h.platformKey,
          "x-archestra-agent-id": "grok-build",
          "x-grok-session-id": `grok-progressive-${denied}`,
          "x-grok-client-mode": "interactive",
        },
        payload: {
          model: "gpt-4o",
          stream: false,
          tools: ["use_tool", "search_tool"].map((name) => ({
            type: "function",
            function: { name, parameters: { type: "object" } },
          })),
          messages: [
            { role: "user", content: "List the available skills." },
            {
              role: "assistant",
              tool_calls: [
                {
                  id: "catalog",
                  type: "function",
                  function: {
                    name: "search_tool",
                    arguments: '{"query":"gateway tools"}',
                  },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "catalog",
              content: JSON.stringify({
                results: [{ server: "gateway", tools }],
              }),
            },
          ],
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(h.events).toContainEqual(
        expect.objectContaining({
          event: "tool_call",
          tool: "archestra__list_skills",
          arguments: input,
          dispatch: `gateway__${grokToolName("archestra__run_tool")}`,
        }),
      );
      const calls = response.json().choices[0].message.tool_calls;
      expect(calls).toHaveLength(1);
      expect(calls[0].function.name).toBe("use_tool");
      const wrapped = JSON.parse(calls[0].function.arguments);
      if (denied) {
        expect(wrapped.tool_name).toBe(
          `gateway__${grokToolName("archestra__get_remedy_plans")}`,
        );
        expect(
          readNotice({ callId: "progressive", arguments: wrapped.tool_input })
            ?.tool,
        ).toBe("archestra__list_skills");
      } else {
        expect(wrapped).toEqual({
          tool_name: `gateway__${grokToolName("archestra__run_tool")}`,
          tool_input: { tool_name: "archestra__list_skills", tool_args: input },
        });
      }
    });
  }

  describe("Cursor chats", () => {
    const READ_TOOL = {
      type: "function",
      function: {
        name: "Read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    };
    // Cursor's BYOK shape: a per-device `user`, a system prompt rebuilt per
    // request, its own PascalCase tools and a flat ApplyPatch custom tool.
    const cursorBody = (messages: unknown[], system = "You are Cursor.") => ({
      model: "gpt-4o",
      stream: false,
      user: "ff9d1da0167751c3",
      messages: [{ role: "system", content: system }, ...messages],
      tools: [
        READ_TOOL,
        {
          type: "custom",
          name: "ApplyPatch",
          description: "Use this tool to edit files.",
          format: {
            type: "grammar",
            definition: "start: begin_patch hunk end_patch",
            syntax: "lark",
          },
        },
      ],
    });
    let restricted: Set<string>;

    beforeEach(async () => {
      config.openappa = {
        ...config.openappa,
        offerSigningSecret: "test-offer-signing-secret-32chars",
      };
      await h.app.register(openAiProxyRoutes);
      await ModelModel.upsert({
        externalId: "openai/gpt-4o",
        provider: "openai",
        modelId: "gpt-4o",
        inputModalities: null,
        outputModalities: null,
        lastSyncedAt: new Date(),
      });
      // A provider gives each call an id of its own.
      let calls = 0;
      vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
        () =>
          createOpenAiTestClient({
            nonStreamingToolCalls: [
              {
                id: `cursor_call_${++calls}`,
                name: "Read",
                arguments: JSON.stringify({ path: "README.md" }),
              },
            ],
          }) as never,
      );
      // The runtime's restriction: once a session is restricted, its calls
      // are denied. Other sessions are ruled as before.
      restricted = new Set();
      const rule = native.dispatchHook.getMockImplementation();
      native.dispatchHook.mockImplementation(async (raw: string) => {
        const event = JSON.parse(raw);
        if (
          event.event === "tool_call" &&
          restricted.has(String(event.session_id))
        ) {
          h.events.push(event);
          return JSON.stringify({
            decision: "deny_call",
            feedback:
              "[appa] NATIVE REFUSAL: execute_remedy_plan(offer_id: test-offer)",
          });
        }
        return rule?.(raw);
      });
    });

    const send = (body: unknown) =>
      h.app.inject({
        method: "POST",
        url: `/v1/openai/${h.agent.id}/chat/completions`,
        headers: {
          authorization: "Bearer test-key",
          "x-archestra-virtual-key": h.platformKey,
          "user-agent": "Cursor/2.3",
        },
        payload: body as Record<string, unknown>,
      });
    const lastCallSession = () =>
      String(
        h.events.findLast((event) => event.event === "tool_call")?.session_id,
      );
    const releasedCalls = (response: { json: () => unknown }) =>
      (
        response.json() as {
          choices: Array<{
            message: {
              tool_calls?: Array<{ id: string; function: { name: string } }>;
            };
          }>;
        }
      ).choices[0].message.tool_calls ?? [];

    test("two chats on one key get two roots, a retry keeps its root, a stamped turn opens the chat's own branch, and a rewritten opening forks it", async () => {
      const chat1 = [{ role: "user", content: "Fix the login bug" }];
      const first = await send(cursorBody(chat1));
      expect(first.statusCode, first.body).toBe(200);
      const root1 = lastCallSession();
      expect(root1).toMatch(new RegExp(`^user:${h.userId}\\|cursor-chat-`));
      // Cursor's per-device `user` is never the session.
      expect(root1).not.toContain("ff9d1da0167751c3");
      const [call] = releasedCalls(first);
      expect(call.function.name).toBe("Read");
      expect(parseTrajectoryStamp(call.id)?.sessionId).toBe(
        root1.slice(`user:${h.userId}|`.length),
      );

      // A retry, with Cursor's system prompt rebuilt, lands on the same root.
      const retry = await send(cursorBody(chat1, "You are Cursor. 10:02"));
      expect(retry.statusCode, retry.body).toBe(200);
      expect(lastCallSession()).toBe(root1);

      // The next turn carries the stamped call under the same opening. The
      // call's id is this chat's alone, so the chat leaves the session its
      // opening names for a fork of it, and stays there.
      const afterCall = [
        ...chat1,
        { role: "assistant", content: [], tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "# README" },
      ];
      const next = await send(cursorBody(afterCall));
      expect(next.statusCode, next.body).toBe(200);
      const branch1 = lastCallSession();
      expect(branch1).not.toBe(root1);
      expect(
        h.events.find(
          (event) =>
            event.event === "session_start" && event.session_id === branch1,
        )?.fork_of,
      ).toBe(root1);
      const [laterCall] = releasedCalls(next);
      expect(parseTrajectoryStamp(laterCall.id)?.sessionId).toBe(
        branch1.slice(`user:${h.userId}|`.length),
      );
      const third = await send(
        cursorBody([
          ...afterCall,
          { role: "assistant", content: [], tool_calls: [laterCall] },
          { role: "tool", tool_call_id: laterCall.id, content: "more" },
        ]),
      );
      expect(third.statusCode, third.body).toBe(200);
      expect(lastCallSession()).toBe(branch1);

      // A rewritten opening (a summary, an edited first message) with the
      // stamped call opens a fork of chat 1, which keeps its restrictions.
      const summarized = await send(
        cursorBody([
          { role: "user", content: "Summary: fixing the login bug" },
          { role: "assistant", content: [], tool_calls: [call] },
          { role: "tool", tool_call_id: call.id, content: "# README" },
        ]),
      );
      expect(summarized.statusCode, summarized.body).toBe(200);
      const forked = lastCallSession();
      expect(forked).not.toBe(root1);
      expect(
        h.events.find(
          (event) =>
            event.event === "session_start" && event.session_id === forked,
        )?.fork_of,
      ).toBe(root1);

      const second = await send(
        cursorBody([{ role: "user", content: "Write the release notes" }]),
      );
      expect(second.statusCode, second.body).toBe(200);
      const root2 = lastCallSession();
      expect(root2).not.toBe(root1);
      expect(
        new Set(
          h.events
            .filter((event) => event.event === "session_start")
            .map((event) => event.session_id),
        ),
      ).toEqual(new Set([root1, branch1, forked, root2]));
      expect(
        h.events.find(
          (event) =>
            event.event === "session_start" && event.session_id === root2,
        )?.fork_of,
      ).toBeUndefined();
    });

    test("a restriction in one chat does not reach another chat on the same key", async () => {
      const chat1 = [{ role: "user", content: "Fix the login bug" }];
      expect((await send(cursorBody(chat1))).statusCode).toBe(200);
      const root1 = lastCallSession();
      restricted.add(root1);

      const blocked = await send(cursorBody(chat1));
      expect(blocked.statusCode, blocked.body).toBe(200);
      expect(lastCallSession()).toBe(root1);
      expect(
        releasedCalls(blocked).some((call) => call.function.name === "Read"),
      ).toBe(false);

      const other = await send(
        cursorBody([{ role: "user", content: "Write the release notes" }]),
      );
      expect(other.statusCode, other.body).toBe(200);
      expect(lastCallSession()).not.toBe(root1);
      expect(
        releasedCalls(other).some((call) => call.function.name === "Read"),
      ).toBe(true);
    });

    test("chats with the same opening share a session only until each makes a tool call", async () => {
      const opening = [{ role: "user", content: "Fix the login bug" }];
      const one = await send(cursorBody(opening));
      const root = lastCallSession();
      const two = await send(cursorBody(opening));
      expect(lastCallSession()).toBe(root);
      const [callOne] = releasedCalls(one);
      const [callTwo] = releasedCalls(two);
      expect(callOne.id).not.toBe(callTwo.id);
      const turn = (call: { id: string }) =>
        send(
          cursorBody([
            ...opening,
            { role: "assistant", content: [], tool_calls: [call] },
            { role: "tool", tool_call_id: call.id, content: "# README" },
          ]),
        );

      expect((await turn(callOne)).statusCode).toBe(200);
      const branchOne = lastCallSession();
      expect((await turn(callTwo)).statusCode).toBe(200);
      const branchTwo = lastCallSession();
      expect(new Set([root, branchOne, branchTwo]).size).toBe(3);

      // A restriction one chat earns after its call stays in that chat.
      restricted.add(branchOne);
      const blocked = await turn(callOne);
      expect(lastCallSession()).toBe(branchOne);
      expect(
        releasedCalls(blocked).some((call) => call.function.name === "Read"),
      ).toBe(false);
      const free = await turn(callTwo);
      expect(lastCallSession()).toBe(branchTwo);
      expect(
        releasedCalls(free).some((call) => call.function.name === "Read"),
      ).toBe(true);
    });

    test("a history that mixes two chats' stamps is refused, not moved to a fresh session", async () => {
      const one = await send(
        cursorBody([{ role: "user", content: "Fix the login bug" }]),
      );
      const two = await send(
        cursorBody([{ role: "user", content: "Write the release notes" }]),
      );
      const [callOne] = releasedCalls(one);
      const [callTwo] = releasedCalls(two);
      const startsBefore = h.events.filter(
        (event) => event.event === "session_start",
      ).length;
      const mixed = await send(
        cursorBody([
          { role: "user", content: "Fix the login bug" },
          { role: "assistant", content: [], tool_calls: [callOne] },
          { role: "tool", tool_call_id: callOne.id, content: "a" },
          { role: "assistant", content: [], tool_calls: [callTwo] },
          { role: "tool", tool_call_id: callTwo.id, content: "b" },
        ]),
      );
      expect(mixed.statusCode).toBe(400);
      expect(mixed.json().error.message).toContain(
        "mixes context from unrelated sessions",
      );
      expect(
        h.events.filter((event) => event.event === "session_start"),
      ).toHaveLength(startsBefore);
    });

    test("a foreign stamp is ignored and the opening names the chat", async () => {
      const first = await send(
        cursorBody([{ role: "user", content: "Fix the login bug" }]),
      );
      const root1 = lastCallSession();
      const [call] = releasedCalls(first);
      config.openappa = {
        ...config.openappa,
        offerSigningSecret: "another-offer-signing-secret-32ch",
      };
      const next = await send(
        cursorBody([
          { role: "user", content: "Write the release notes" },
          { role: "assistant", content: [], tool_calls: [call] },
          { role: "tool", tool_call_id: call.id, content: "# README" },
        ]),
      );
      expect(next.statusCode, next.body).toBe(200);
      expect(lastCallSession()).not.toBe(root1);
      expect(lastCallSession()).toMatch(/\|cursor-chat-/);
    });
  });

  test.each([
    "deny",
    "error",
    "result",
  ] as const)("Pi %s keeps denied native calls or raw results away from execution and the provider", async (outcome) => {
    await h.app.register(openAiProxyRoutes);
    await ModelModel.upsert({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
    const sent: unknown[] = [];
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(() => {
      const client = createOpenAiTestClient({
        nonStreamingToolCalls: [
          {
            id: "pi_call",
            name: "bash",
            arguments: JSON.stringify({ command: "echo test" }),
          },
        ],
      });
      const create = client.chat.completions.create;
      client.chat.completions.create = async (params) => {
        sent.push(structuredClone(params));
        return create(params);
      };
      return client as never;
    });
    const body = {
      model: "gpt-4o",
      stream: false,
      messages: [{ role: "user", content: "Run the tool" }],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "Run a command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        },
      ],
    };
    const submit = (payload: object) =>
      h.app.inject({
        method: "POST",
        url: `/v1/openai/${h.agent.id}/chat/completions`,
        headers: {
          authorization: "Bearer test-key",
          "x-archestra-virtual-key": h.platformKey,
          "x-archestra-agent-id": "pi",
          "x-pi-session-id": "pi-regression-session",
        },
        payload,
      });
    h.block = outcome === "deny";
    h.fail = outcome === "error";
    const first = await submit(body);
    if (outcome === "error") {
      expect(first.statusCode, first.body).toBe(500);
      expect(first.body).not.toContain("private native database error");
      return;
    }
    expect(first.statusCode, first.body).toBe(200);
    const calls = first.json().choices[0].message.tool_calls ?? [];
    if (outcome === "deny") {
      expect(
        calls.some(
          (call: { function: { name: string } }) =>
            call.function.name === "bash",
        ),
      ).toBe(false);
      return;
    }
    expect(calls).toHaveLength(1);
    const dispatch = native.dispatchHook.getMockImplementation();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      if (event.event !== "tool_result") return dispatch?.(raw);
      h.events.push(event);
      return JSON.stringify({
        decision: "deny_call",
        feedback: "Tool output denied",
        approved_output: "Tool output denied",
        output_source: "runtime",
      });
    });
    const next = await submit({
      ...body,
      messages: [
        ...body.messages,
        { role: "assistant", content: null, tool_calls: calls },
        {
          role: "tool",
          tool_call_id: calls[0].id,
          content: "RAW DENIED PI RESULT",
        },
      ],
    });
    expect(next.statusCode, next.body).toBe(200);
    expect(h.events.some((event) => event.event === "tool_result")).toBe(true);
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1])).not.toContain("RAW DENIED PI RESULT");
    expect(JSON.stringify(sent[1])).toContain("Tool output denied");
  });

  test.each([
    "deny",
    "error",
    "interrupted",
  ] as const)("Pi streamed %s never releases the proposed native tool", async (outcome) => {
    await h.app.register(openAiProxyRoutes);
    await ModelModel.upsert({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () =>
        createOpenAiTestClient({
          includeToolCalls: true,
          ...(outcome === "interrupted" ? { throwAtChunk: 2 } : {}),
        }) as never,
    );
    h.block = outcome === "deny";
    h.fail = outcome === "error";
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/openai/${h.agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-virtual-key": h.platformKey,
        "x-archestra-agent-id": "pi",
        "x-pi-session-id": "pi-stream-session",
      },
      payload: {
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "Read the weather" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Read weather",
              parameters: {
                type: "object",
                properties: { location: { type: "string" } },
              },
            },
          },
        ],
      },
    });
    expect(response.body).not.toContain('"name":"get_weather"');
    expect(response.body).not.toContain("private native database error");
    if (outcome !== "interrupted")
      expect(
        h.events.some(
          (event) =>
            event.event === "tool_call" && event.tool === "get_weather",
        ),
      ).toBe(true);
  });

  test.for(
    (
      [
        { stream: false, state: "active" },
        { stream: true, state: "active" },
        { stream: true, state: "off" },
        { stream: true, state: "superyell" },
        { stream: true, state: "error" },
      ] as const
    ).flatMap((entry) => [
      { ...entry, client: "pi" },
      { ...entry, client: "grok-build" },
    ]),
  )("$client protected-session receipt reflects admission (stream=$stream, state=$state)", async ({
    stream,
    state,
    client,
  }) => {
    await h.app.register(openAiProxyRoutes);
    for (const modelId of ["gpt-5.5", "openai:gpt-6.1-sol"]) {
      await ModelModel.upsert({
        externalId: `openai/${modelId}`,
        provider: "openai",
        modelId,
        inputModalities: null,
        outputModalities: null,
        lastSyncedAt: new Date(),
      });
    }
    const output = [
      {
        id: "msg_pi_receipt",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "Hello from Pi", annotations: [] },
        ],
      },
    ];
    const sent: unknown[] = [];
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockReturnValue({
      responses: {
        create: async (params: { stream?: boolean }) => {
          sent.push(structuredClone(params));
          return params.stream
            ? codexResponseStream("resp_pi_receipt", output)
            : {
                id: "resp_pi_receipt",
                object: "response",
                created_at: 1,
                status: "completed",
                model: "gpt-5.5",
                output,
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
              };
        },
      },
    } as never);
    const nativeId = `${client}-receipt-session`;
    if (state === "off") await GuardrailsDeploymentModel.setEnabled(false);
    if (state === "superyell")
      await OpenAppaUnenforcedModel.recordSession({
        organizationId: h.agent.organizationId,
        sessionId: `user:${h.userId}|${nativeId}`,
        parentId: undefined,
        reason: "superyell",
      });
    if (state === "error")
      native.dispatchHook.mockRejectedValue(new Error("unavailable"));
    const send = (input: unknown[], model = "gpt-5.5") =>
      h.app.inject({
        method: "POST",
        url: `/v1/openai/${h.agent.id}/responses`,
        headers: {
          authorization: "Bearer test-key",
          "x-archestra-virtual-key": h.platformKey,
          "x-archestra-agent-id": client,
          ...(client === "pi"
            ? { "x-pi-session-id": nativeId }
            : {
                "x-grok-session-id": nativeId,
                "x-grok-client-mode": "interactive",
              }),
        },
        payload: {
          model,
          stream,
          input,
          tools: [
            {
              type: "function",
              name: "read",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
              },
            },
          ],
        },
      });
    const response = await send([{ role: "user", content: "Hi" }]);
    await drainBackgroundWork();
    expect(response.body.includes("protected session")).toBe(
      state === "active",
    );
    expect(response.statusCode).toBe(state === "error" ? 500 : 200);
    const sessions = await db
      .select()
      .from(database.schema.openappaSessionsTable)
      .where(
        eq(
          database.schema.openappaSessionsTable.organizationId,
          h.agent.organizationId,
        ),
      );
    expect(sessions.some((row) => row.receiptIssuedAt !== null)).toBe(
      state === "active",
    );
    if (state !== "active") return;
    const mark = response.body.match(
      /protected session ([0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4})/,
    )?.[1];
    expect(mark).toBeDefined();
    // Native resume/model changes carry the same binding. A displayed receipt
    // is historical evidence, not a persistent live-health indicator.
    const followUp = await send(
      [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: appendSessionReceipt("Hello from Pi", mark as string),
        },
        { role: "user", content: "Continue after switching models" },
      ],
      "openai:gpt-6.1-sol",
    );
    expect(followUp.statusCode, followUp.body).toBe(200);
    expect(followUp.body).not.toContain("protected session");
    expect(JSON.stringify(sent)).not.toContain("protected session");
    expect(
      new Set(
        h.events
          .filter((event) => event.event === "session_start")
          .map((event) => event.session_id),
      ),
    ).toEqual(new Set([`user:${h.userId}|${nativeId}`]));
  });

  test.for([
    "deny",
    "error",
    "result",
    "undeclared",
  ] as const)("Pi Responses %s checks native calls and excludes denied results after a model switch", async (outcome, {
    seedAndAssignArchestraTools,
  }) => {
    if (outcome === "undeclared") await seedAndAssignArchestraTools(h.agent.id);
    await h.app.register(openAiProxyRoutes);
    await ModelModel.upsert({
      externalId: "openai/gpt-5.5",
      provider: "openai",
      modelId: "gpt-5.5",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
    await ModelModel.upsert({
      externalId: "openai/openai:gpt-6.1-sol",
      provider: "openai",
      modelId: "openai:gpt-6.1-sol",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
    const sent: unknown[] = [];
    const call = {
      type: "function_call",
      id: "fc_pi",
      call_id: "call_pi_responses",
      name: "bash",
      arguments: JSON.stringify({ command: "echo test" }),
      status: "completed",
    };
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockReturnValue({
      responses: {
        create: async (params: unknown) => {
          sent.push(structuredClone(params));
          return {
            id: "resp_pi",
            object: "response",
            created_at: 1,
            status: "completed",
            model: "gpt-5.5",
            output: [call],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          };
        },
      },
    } as never);
    const input = [{ role: "user", content: "Run the tool" }];
    const send = (items: unknown[], model = "gpt-5.5") =>
      h.app.inject({
        method: "POST",
        url: `/v1/openai/${h.agent.id}/responses`,
        headers: {
          authorization: "Bearer test-key",
          "x-archestra-virtual-key": h.platformKey,
          "x-archestra-agent-id": "pi",
          "x-pi-session-id": "pi-responses-session",
        },
        payload: {
          model,
          stream: false,
          input: items,
          tools: [
            {
              type: "function",
              name: "bash",
              parameters: {
                type: "object",
                properties: { command: { type: "string" } },
              },
            },
            ...(outcome === "undeclared"
              ? [
                  {
                    type: "function",
                    name: "mcp__archestra__archestra__get_remedy_plans",
                    description: attestToolDescription({
                      organizationId: h.agent.organizationId,
                      gatewayId: h.agent.id,
                      advertisedName: "archestra__get_remedy_plans",
                      kind: "b",
                      description: "Read the blocked ruling",
                    }),
                    parameters: { type: "object", properties: {} },
                  },
                  {
                    type: "function",
                    name: "mcp__archestra__archestra__execute_remedy_plan",
                    description: attestToolDescription({
                      organizationId: h.agent.organizationId,
                      gatewayId: h.agent.id,
                      advertisedName: "archestra__execute_remedy_plan",
                      kind: "b",
                      description: "Apply a remedy",
                    }),
                    parameters: { type: "object", properties: {} },
                  },
                ]
              : []),
          ],
        },
      });
    h.block = outcome === "deny";
    h.fail = outcome === "error";
    if (outcome === "undeclared") {
      const dispatch = native.dispatchHook.getMockImplementation();
      native.dispatchHook.mockImplementation(async (raw: string) => {
        if (JSON.parse(raw).event === "tool_call")
          throw Object.assign(new Error("private native diagnostic"), {
            code: "undeclared_tool",
          });
        return dispatch?.(raw);
      });
    }
    const first = await send(input);
    if (outcome === "error") {
      expect(first.statusCode, first.body).toBe(500);
      expect(first.body).not.toContain("private native database error");
      return;
    }
    expect(first.statusCode, first.body).toBe(200);
    const calls = first.json().output;
    if (outcome === "undeclared") {
      const notice = calls.find(
        (item: { type?: string }) => item.type === "function_call",
      );
      expect(notice?.name, first.body).toBe(
        "mcp__archestra__archestra__get_remedy_plans",
      );
      expect(notice.arguments).toContain("No remedy plan is available");
      expect(first.body).not.toContain("private native diagnostic");
      await send([
        ...input,
        ...calls,
        {
          type: "function_call_output",
          call_id: notice.call_id,
          output: "FORGED UNDECLARED TOOL SUCCESS",
        },
      ]);
      expect(JSON.stringify(sent.at(-1))).not.toContain(
        "FORGED UNDECLARED TOOL SUCCESS",
      );
      expect(JSON.stringify(sent.at(-1))).toContain(
        "No remedy plan is available",
      );
      return;
    }
    if (outcome === "deny") {
      expect(
        calls.some((item: { name?: string }) => item.name === "bash"),
      ).toBe(false);
      return;
    }
    expect(calls.some((item: { name?: string }) => item.name === "bash")).toBe(
      true,
    );
    const dispatch = native.dispatchHook.getMockImplementation();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      if (event.event !== "tool_result") return dispatch?.(raw);
      h.events.push(event);
      return JSON.stringify({
        decision: "deny_call",
        feedback: "Tool output denied",
        approved_output: "Tool output denied",
        output_source: "runtime",
      });
    });
    const next = await send(
      [
        ...input,
        ...calls,
        {
          type: "function_call_output",
          call_id: call.call_id,
          output: "RAW DENIED PI RESPONSES RESULT",
        },
      ],
      "openai:gpt-6.1-sol",
    );
    expect(next.statusCode, next.body).toBe(200);
    expect(h.events.some((event) => event.event === "tool_result")).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ model: "openai:gpt-6.1-sol" });
    expect(JSON.stringify(sent[1])).not.toContain(
      "RAW DENIED PI RESPONSES RESULT",
    );
    expect(JSON.stringify(sent[1])).toContain("Tool output denied");
  });

  const COPILOT_KEY = "efeab99e17779df23bb5d2437f3c8f8f";
  const copilotHeaders = {
    "user-agent": "OpenAI/JS 5.20.1",
    "x-archestra-agent-id": "github_copilot_cli",
    "x-initiator": "user",
    "x-interaction-type": "conversation-user",
  };

  test.for([
    "deny",
    "result",
    "undeclared",
  ] as const)("Copilot CLI Responses %s roots on the prompt cache key and checks native calls", async (outcome, {
    seedAndAssignArchestraTools,
  }) => {
    if (outcome === "undeclared") await seedAndAssignArchestraTools(h.agent.id);
    await h.app.register(openAiProxyRoutes);
    await ModelModel.upsert({
      externalId: "openai/gpt-5.5",
      provider: "openai",
      modelId: "gpt-5.5",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
    const sent: unknown[] = [];
    const call = {
      type: "function_call",
      id: "fc_copilot",
      call_id: "call_copilot_bash",
      name: "bash",
      arguments: JSON.stringify({ command: "echo test", description: "echo" }),
      status: "completed",
    };
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockReturnValue({
      responses: {
        create: async (params: unknown) => {
          sent.push(structuredClone(params));
          return {
            id: "resp_copilot",
            object: "response",
            created_at: 1,
            status: "completed",
            model: "gpt-5.5",
            output: [call],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          };
        },
      },
    } as never);
    // Copilot's opening turn: a user message with its datetime preamble, no
    // session header, and the session named by prompt_cache_key only.
    const input = [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<current_datetime>2026-10-28T23:02:45.235+04:00</current_datetime>\n\nRun the tool",
          },
        ],
      },
    ];
    const send = (items: unknown[]) =>
      h.app.inject({
        method: "POST",
        url: `/v1/openai/${h.agent.id}/responses`,
        headers: {
          authorization: "Bearer test-key",
          "x-archestra-virtual-key": h.platformKey,
          ...copilotHeaders,
        },
        payload: {
          model: "gpt-5.5",
          stream: false,
          store: false,
          prompt_cache_key: COPILOT_KEY,
          parallel_tool_calls: true,
          input: items,
          tools: [
            {
              type: "function",
              name: "bash",
              parameters: {
                type: "object",
                properties: {
                  command: { type: "string" },
                  description: { type: "string" },
                },
              },
            },
            ...(outcome === "undeclared"
              ? [
                  {
                    type: "function",
                    // Copilot spells an MCP tool <server>-<advertised name>.
                    name: "prod_gateway-archestra__get_remedy_plans",
                    description: attestToolDescription({
                      organizationId: h.agent.organizationId,
                      gatewayId: h.agent.id,
                      advertisedName: "archestra__get_remedy_plans",
                      kind: "b",
                      description: "Read the blocked ruling",
                    }),
                    parameters: { type: "object", properties: {} },
                  },
                  {
                    type: "function",
                    name: "prod_gateway-archestra__execute_remedy_plan",
                    description: attestToolDescription({
                      organizationId: h.agent.organizationId,
                      gatewayId: h.agent.id,
                      advertisedName: "archestra__execute_remedy_plan",
                      kind: "b",
                      description: "Apply a remedy",
                    }),
                    parameters: { type: "object", properties: {} },
                  },
                ]
              : []),
          ],
        },
      });
    h.block = outcome === "deny";
    if (outcome === "undeclared") {
      const dispatch = native.dispatchHook.getMockImplementation();
      native.dispatchHook.mockImplementation(async (raw: string) => {
        if (JSON.parse(raw).event === "tool_call")
          throw Object.assign(new Error("private native diagnostic"), {
            code: "undeclared_tool",
          });
        return dispatch?.(raw);
      });
    }
    const first = await send(input);
    expect(first.statusCode, first.body).toBe(200);
    // The root is the Copilot session, not a per-request session.
    const started = h.events.filter((event) => event.event === "session_start");
    expect(started).toHaveLength(1);
    expect(String(started[0].session_id).endsWith(COPILOT_KEY)).toBe(true);
    expect(started[0].parent_id ?? null).toBeNull();
    const calls = first.json().output;
    if (outcome === "undeclared") {
      const notice = calls.find(
        (item: { type?: string }) => item.type === "function_call",
      );
      expect(notice?.name, first.body).toBe(
        "prod_gateway-archestra__get_remedy_plans",
      );
      expect(notice.arguments).toContain("No remedy plan is available");
      expect(first.body).not.toContain("private native diagnostic");
      return;
    }
    if (outcome === "deny") {
      expect(
        calls.some((item: { name?: string }) => item.name === "bash"),
      ).toBe(false);
      return;
    }
    expect(calls.some((item: { name?: string }) => item.name === "bash")).toBe(
      true,
    );
    const dispatch = native.dispatchHook.getMockImplementation();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      if (event.event !== "tool_result") return dispatch?.(raw);
      h.events.push(event);
      return JSON.stringify({
        decision: "deny_call",
        feedback: "Tool output denied",
        approved_output: "Tool output denied",
        output_source: "runtime",
      });
    });
    // The continuation replays the stamped call and its result, as Copilot does.
    const next = await send([
      ...input,
      ...calls,
      {
        type: "function_call_output",
        call_id: call.call_id,
        output:
          "RAW DENIED COPILOT RESULT\n<shellId: 0 completed with exit code 0>",
      },
    ]);
    expect(next.statusCode, next.body).toBe(200);
    expect(h.events.some((event) => event.event === "tool_result")).toBe(true);
    // The continuation stays on the same root: no session opens under another id.
    for (const event of h.events.filter((e) => e.event === "session_start")) {
      expect(String(event.session_id).endsWith(COPILOT_KEY)).toBe(true);
    }
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1])).not.toContain("RAW DENIED COPILOT RESULT");
    expect(JSON.stringify(sent[1])).toContain("Tool output denied");
  });

  test.for([
    { wire: "responses", restart: false },
    { wire: "responses", restart: true },
    { wire: "anthropic", restart: false },
    { wire: "anthropic", restart: true },
  ] as const)("delivers a waived child's withdrawal to a $wire provider continue (restart=$restart)", async ({
    wire,
    restart,
  }) => {
    config.openappa.offerSigningSecret = "synthetic-waived-child-secret";
    const binding = mintSubagentBinding({
      agentId: h.agent.id,
      parent: {
        organization_id: h.agent.organizationId,
        caller_id: `user:${h.userId}`,
        session_id: `user:${h.userId}|parent-continue`,
      },
      spawnCallId: "spawn-continue",
    });
    const priorContract = "Your final message must be empty.";
    if (wire === "responses") {
      await h.app.register(openAiProxyRoutes);
      await ModelModel.upsert({
        externalId: "openai/gpt-5.5",
        provider: "openai",
        modelId: "gpt-5.5",
        inputModalities: null,
        outputModalities: null,
        lastSyncedAt: new Date(),
      });
      vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockReturnValue({
        responses: {
          create: async (request: unknown) => {
            h.providerRequests.push(structuredClone(request));
            return {
              id: "resp_child_continue",
              object: "response",
              created_at: 1,
              status: "completed",
              model: "gpt-5.5",
              output: [
                {
                  type: "function_call",
                  call_id: "call_weather_continue",
                  name: "get_weather",
                  arguments: '{"location":"SF"}',
                },
              ],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            };
          },
        },
      } as never);
    }
    const send = (continuing: boolean) =>
      h.app.inject({
        method: "POST",
        url:
          wire === "responses" ? `/v1/openai/${h.agent.id}/responses` : h.url(),
        headers: {
          ...internalCallHeader(),
          ...h.headers(),
          "x-archestra-source": "api",
          "x-archestra-appa-subagent": binding.token,
          ...(wire === "responses" ? { authorization: "Bearer test-key" } : {}),
        },
        payload:
          wire === "responses"
            ? {
                model: "gpt-5.5",
                stream: false,
                input: [
                  {
                    role: "user",
                    content: continuing
                      ? "The command finished."
                      : priorContract,
                  },
                ],
                ...(continuing
                  ? { previous_response_id: "resp_child_continue" }
                  : {}),
                tools: [
                  {
                    type: "function",
                    name: "get_weather",
                    parameters: { type: "object", properties: {} },
                  },
                ],
              }
            : {
                ...h.payload(false),
                ...(continuing
                  ? {
                      thread: {
                        type: "continue",
                        previous_message_id: "msg_child_continue",
                      },
                    }
                  : { system: priorContract, thread: { type: "create" } }),
                messages: [
                  {
                    role: "user",
                    content: continuing
                      ? "The command finished."
                      : "Start the task.",
                  },
                ],
              },
      });
    const opened = await send(false);
    expect(opened.statusCode, opened.body).toBe(200);
    expect(JSON.stringify(h.providerRequests[0])).toContain(priorContract);
    expect(
      await OpenAppaSessionModel.find({
        organizationId: h.agent.organizationId,
        sessionId: binding.session.session_id,
      }),
    ).not.toBeNull();
    await superyellSession(binding.session);
    if (restart) {
      h.unregisterAppaPlugin();
      h.unregisterAppaPlugin = registerLlmProxyPlugin(
        createAppaLlmProxyPlugin(),
      );
    }
    h.providerRequests.length = 0;
    h.events.length = 0;
    const continued = await send(true);
    expect(continued.statusCode, continued.body).toBe(200);
    expect(h.providerRequests).toHaveLength(1);
    expect(JSON.stringify(h.providerRequests[0])).toContain(
      "withdrawn its earlier protected-return instructions",
    );
    expect(JSON.stringify(h.providerRequests[0])).toContain(
      "The command finished.",
    );
    expect(h.providerRequests[0]).toMatchObject(
      wire === "responses"
        ? { previous_response_id: "resp_child_continue" }
        : {
            thread: {
              type: "continue",
              previous_message_id: "msg_child_continue",
            },
          },
    );
    expect(h.events).toEqual([]);
  });

  test("Codex child history binds to its parent before root fork tracing", async () => {
    config.openappa.offerSigningSecret = "synthetic-codex-admission-secret";
    await h.app.register(openAiProxyRoutes);
    await ModelModel.upsert({
      externalId: "openai/gpt-5.5",
      provider: "openai",
      modelId: "gpt-5.5",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
    const sent: unknown[] = [];
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockReturnValue({
      responses: {
        create: async (params: unknown) => {
          sent.push(structuredClone(params));
          return {
            id: "resp_codex_child",
            object: "response",
            created_at: 1,
            status: "completed",
            model: "gpt-5.5",
            output: [
              {
                type: "function_call",
                call_id: "call_read",
                name: "read_file",
                arguments: '{"target_file":"synthetic.txt"}',
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          };
        },
      },
    } as never);
    const parent = "00000000-0000-4000-8000-000000000010";
    const child = "00000000-0000-4000-8000-000000000011";
    const prompt = "Read the synthetic file";
    const marker = mintDelegationMarker({
      organizationId: h.agent.organizationId,
      callerId: `user:${h.userId}`,
      parentId: parent,
      spawnerNativeId: parent,
      prompt,
      spawnCallId: "call_spawn",
    });
    // A native child can replay stamped context even though its bare CLI ID
    // has never opened a root: its governed ID is parent:child.
    const callId = stampToolCallId({
      callId: "call_title",
      sessionId: child,
      organizationId: h.agent.organizationId,
      callerId: `user:${h.userId}`,
      secret: config.openappa.offerSigningSecret,
    });
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/openai/${h.agent.id}/responses`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-virtual-key": h.platformKey,
        originator: "codex_cli_rs",
        "session-id": child,
        "x-codex-turn-metadata": JSON.stringify({
          parent_thread_id: parent,
          thread_id: child,
        }),
      },
      payload: {
        model: "gpt-5.5",
        stream: false,
        input: [
          {
            role: "user",
            content: `${prompt}\n\n${marker}`,
          },
          {
            type: "function_call",
            call_id: callId,
            name: "session_title",
            arguments: '{"title":"Synthetic child"}',
          },
          {
            type: "function_call_output",
            call_id: callId,
            output: "Title set",
          },
        ],
        tools: [
          {
            type: "function",
            name: "read_file",
            parameters: {
              type: "object",
              properties: { target_file: { type: "string" } },
            },
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(sent).toHaveLength(1);
    expect(h.events).toContainEqual(
      expect.objectContaining({
        event: "session_start",
        session_id: `user:${h.userId}|${parent}:${child}`,
        parent_id: `user:${h.userId}|${parent}`,
      }),
    );
    expect(
      h.events
        .filter((event) => event.event === "session_start")
        .every((event) => event.fork_of === undefined),
    ).toBe(true);
  });

  test.each([
    "valid",
    "changed",
    "missing",
  ] as const)("Grok child history uses its signed spawn before root fork tracing (marker=%s)", async (proof) => {
    config.openappa.offerSigningSecret = "synthetic-grok-admission-secret";
    await h.app.register(openAiProxyRoutes);
    await ModelModel.upsert({
      externalId: "openai/gpt-5.5",
      provider: "openai",
      modelId: "gpt-5.5",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
    const sent: unknown[] = [];
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockReturnValue({
      responses: {
        create: async (params: unknown) => {
          sent.push(structuredClone(params));
          return {
            id: "resp_grok_child",
            object: "response",
            created_at: 1,
            status: "completed",
            model: "gpt-5.5",
            output: [
              {
                type: "function_call",
                call_id: "call_read",
                name: "read_file",
                arguments: '{"target_file":"synthetic.txt"}',
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          };
        },
      },
    } as never);
    const parent = "00000000-0000-4000-8000-000000000010";
    const child = "00000000-0000-4000-8000-000000000011";
    const prompt = "Read the synthetic file";
    const marker = mintDelegationMarker({
      organizationId: h.agent.organizationId,
      callerId: `user:${h.userId}`,
      parentId: parent,
      spawnerNativeId: parent,
      prompt,
      spawnCallId: "call_spawn",
    });
    // A native child can replay stamped context even though its bare CLI ID
    // has never opened a root: its governed ID is parent:child.
    const callId = stampToolCallId({
      callId: "call_title",
      sessionId: child,
      organizationId: h.agent.organizationId,
      callerId: `user:${h.userId}`,
      secret: config.openappa.offerSigningSecret,
    });
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/openai/${h.agent.id}/responses`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-virtual-key": h.platformKey,
        "x-grok-client-identifier": "grok-pager",
        "x-grok-session-id": child,
      },
      payload: {
        model: "gpt-5.5",
        stream: false,
        input: [
          {
            role: "user",
            content:
              proof === "missing"
                ? prompt
                : `${proof === "changed" ? "Changed prompt" : prompt}\n\n${marker}`,
          },
          {
            type: "function_call",
            call_id: callId,
            name: "session_title",
            arguments: '{"title":"Synthetic child"}',
          },
          {
            type: "function_call_output",
            call_id: callId,
            output: "Title set",
          },
        ],
        tools: [
          {
            type: "function",
            name: "read_file",
            parameters: {
              type: "object",
              properties: { target_file: { type: "string" } },
            },
          },
        ],
      },
    });
    if (proof !== "valid") {
      expect(response.statusCode, response.body).toBe(
        proof === "changed" ? 409 : 400,
      );
      expect(sent).toHaveLength(0);
      expect(h.events.some((event) => event.event === "session_start")).toBe(
        false,
      );
      return;
    }
    expect(response.statusCode, response.body).toBe(200);
    expect(sent).toHaveLength(1);
    expect(h.events).toContainEqual(
      expect.objectContaining({
        event: "session_start",
        session_id: `user:${h.userId}|${parent}:${child}`,
        parent_id: `user:${h.userId}|${parent}`,
      }),
    );
    expect(
      h.events
        .filter((event) => event.event === "session_start")
        .every((event) => event.fork_of === undefined),
    ).toBe(true);
  });

  test.for(
    [false, true].flatMap((stream) =>
      [false, true].flatMap((siblings) =>
        ["unknown", "foreign-parent"].map((source) => ({
          stream,
          siblings,
          source,
        })),
      ),
    ),
  )("Grok completes an unverified resume refusal without stream errors (stream=$stream, siblings=$siblings, source=$source)", async ({
    stream,
    siblings,
    source,
  }) => {
    config.openappa.offerSigningSecret = "synthetic-grok-resume-refusal-secret";
    await h.app.register(openAiProxyRoutes);
    await ModelModel.upsert({
      externalId: "openai/gpt-5.5",
      provider: "openai",
      modelId: "gpt-5.5",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
    const nativeId = "grok-refused-resume";
    const sourceId = "00000000-0000-4000-8000-000000000001";
    native.loadChildReturns.mockImplementation(async (_organization, parent) =>
      source === "foreign-parent" && parent === `user:${h.userId}|foreign-root`
        ? [
            {
              childSessionId: `user:${h.userId}|foreign-root:${sourceId}`,
              childNativeId: sourceId,
              spawnCallId: "foreign-spawn",
              value: "FOREIGN_CHILD",
            },
          ]
        : [],
    );
    const preface =
      source === "unknown"
        ? `I will attempt the requested resume once.${siblings ? "\n" : ""}`
        : siblings
          ? ""
          : "I will attempt the requested resume once.\n\n";
    const message = {
      id: "msg_resume_attempt",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: preface,
          annotations: [],
        },
      ],
    };
    const output = [
      message,
      ...(siblings
        ? [
            {
              id: "fc_read_before_resume",
              type: "function_call",
              call_id: "read-before-resume",
              name: "read_file",
              arguments: '{"target_file":"synthetic.txt"}',
              status: "completed",
            },
          ]
        : []),
      {
        id: "fc_refused_resume",
        type: "function_call",
        call_id: "refused-resume",
        name: "spawn_subagent",
        arguments: JSON.stringify({
          resume_from: sourceId,
          background: false,
          prompt: "Reply exactly UNKNOWN_SOURCE.",
        }),
        status: "completed",
      },
    ];
    let upstreamRequests = 0;
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockReturnValue({
      responses: {
        create: async () => {
          upstreamRequests++;
          return stream
            ? {
                async *[Symbol.asyncIterator]() {
                  for await (const event of codexResponseStream(
                    "resp_refused_resume",
                    output,
                  )) {
                    yield "response" in event
                      ? {
                          ...event,
                          response: { created_at: 1, ...event.response },
                        }
                      : event;
                  }
                },
              }
            : {
                id: "resp_refused_resume",
                object: "response",
                created_at: 1,
                status: "completed",
                model: "gpt-5.5",
                output,
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
              };
        },
      },
    } as never);
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/openai/${h.agent.id}/responses`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-virtual-key": h.platformKey,
        "x-grok-client-identifier": "grok-pager",
        "x-grok-session-id": nativeId,
      },
      payload: {
        model: "gpt-5.5",
        stream,
        input: [
          {
            role: "user",
            content: "Attempt this source once and stop if refused.",
          },
        ],
        tools: ["spawn_subagent", "read_file"].map((name) => ({
          type: "function",
          name,
          parameters: { type: "object", additionalProperties: true },
        })),
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    let completed: {
      status?: string;
      output?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
    };
    if (stream) {
      const frames = response.body
        .split("\n")
        .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
        .map((line) => JSON.parse(line.slice(6)));
      expect(
        frames.some((frame) =>
          ["error", "response.failed", "response.incomplete"].includes(
            frame.type,
          ),
        ),
      ).toBe(false);
      expect(
        frames.filter((frame) => frame.type === "response.completed"),
      ).toHaveLength(1);
      completed = frames.findLast(
        (frame) => frame.type === "response.completed",
      ).response;
      const streamedText = frames
        .filter((frame) => frame.type === "response.output_text.delta")
        .map((frame) => frame.delta)
        .join("");
      if (preface) {
        expect(streamedText).toContain(
          "I will attempt the requested resume once.\n\nOpenAPPA",
        );
      } else {
        expect(streamedText).not.toContain("resume once.");
        expect(streamedText).not.toContain("\n\n\n");
      }
    } else completed = response.json();
    expect(completed.status).toBe("completed");
    expect(
      completed.output?.some((item) => item.type === "function_call"),
    ).toBe(false);
    const text = completed.output
      ?.flatMap((item) => item.content?.map((part) => part.text ?? "") ?? [])
      .join("\n");
    expect(text).toContain("could not verify this Grok resume source");
    expect(text).toContain("no child was started");
    expect(text).not.toContain("Start a fresh subagent instead");
    expect(upstreamRequests).toBe(1);
    expect(native.loadChildReturns).toHaveBeenCalledWith(
      h.agent.organizationId,
      `user:${h.userId}|${nativeId}`,
      undefined,
    );
    expect(
      h.events
        .filter((event) => event.event === "cancel_call")
        .map((event) => event.tool_call_id)
        .sort(),
    ).toEqual(
      [...(siblings ? ["read-before-resume"] : []), "refused-resume"].sort(),
    );
    expect(h.events.some((event) => event.event === "child_address")).toBe(
      false,
    );
    expect(
      h.events.some(
        (event) => event.event === "session_start" && event.parent_id,
      ),
    ).toBe(false);
    if (
      stream &&
      !siblings &&
      source === "unknown" &&
      process.env.ARCHESTRA_GROK_TEST_BINARY
    ) {
      const home = await mkdtemp(path.join(tmpdir(), "grok-resume-refusal-"));
      const authPath = path.join(home, "synthetic-auth.json");
      await mkdir(path.join(home, "native"));
      await writeFile(
        authPath,
        JSON.stringify({
          "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
            key: "synthetic-access",
            auth_mode: "oidc",
            oidc_issuer: "https://auth.x.ai",
            oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
            user_id: "synthetic",
            expires_at: "2099-01-01T00:00:00Z",
            create_time: new Date().toISOString(),
          },
        }),
      );
      let mainRequests = 0;
      const nativeSessions = new Set<string>();
      const bridgeFailures: unknown[] = [];
      const bridge = createServer(async (request, reply) => {
        try {
          if (request.method === "GET") {
            reply.setHeader("content-type", "application/json");
            reply.end(
              JSON.stringify({
                default_model: "gpt-5.5",
                data: [
                  { id: "gpt-5.5", model: "gpt-5.5", api_backend: "responses" },
                ],
              }),
            );
            return;
          }
          let raw = "";
          for await (const chunk of request) raw += chunk;
          const sid = String(request.headers["x-grok-session-id"] ?? "");
          if (
            !sid ||
            String(request.headers["x-grok-conv-id"] ?? "").startsWith(
              "turn-summary-",
            )
          ) {
            reply.setHeader("content-type", "text/event-stream");
            reply.end(
              `data: ${JSON.stringify({
                type: "response.completed",
                sequence_number: 1,
                response: {
                  id: "resp_title",
                  object: "response",
                  status: "completed",
                  output: [
                    {
                      ...message,
                      content: [
                        {
                          type: "output_text",
                          text: "Synthetic refusal test",
                          annotations: [],
                        },
                      ],
                    },
                  ],
                },
              })}\n\n`,
            );
            return;
          }
          mainRequests++;
          nativeSessions.add(sid);
          const result = await h.app.inject({
            method: "POST",
            url: `/v1/openai/${h.agent.id}/responses`,
            headers: {
              authorization: "Bearer test-key",
              "x-archestra-virtual-key": h.platformKey,
              "x-grok-client-identifier": "grok-shell",
              "x-grok-session-id": sid,
            },
            payload: JSON.parse(raw),
          });
          reply.writeHead(result.statusCode, {
            "content-type":
              result.headers["content-type"] ?? "text/event-stream",
          });
          reply.end(result.body);
        } catch (error) {
          bridgeFailures.push(error);
          reply.writeHead(500).end("Synthetic bridge failed");
        }
      });
      await new Promise<void>((resolve) =>
        bridge.listen(0, "127.0.0.1", resolve),
      );
      let child: ReturnType<typeof spawn> | undefined;
      try {
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !/^(GROK_|XAI_)/.test(key),
          ),
        );
        Object.assign(env, {
          HOME: home,
          GROK_HOME: path.join(home, "native"),
          GROK_AUTH_PATH: authPath,
          GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${(bridge.address() as { port: number }).port}`,
          GROK_DISABLE_AUTOUPDATER: "1",
          GROK_TELEMETRY_ENABLED: "0",
          GROK_DISABLE_API_KEY_AUTH: "1",
          NO_PROXY: "127.0.0.1",
        });
        const result = await new Promise<{
          code: number | null;
          stdout: string;
          stderr: string;
        }>((resolve, reject) => {
          child = spawn(
            process.env.ARCHESTRA_GROK_TEST_BINARY as string,
            [
              "--permission-mode=bypassPermissions",
              "-m",
              "gpt-5.5",
              "-p",
              "Attempt one unknown native resume and stop if refused.",
              "--output-format=json",
              "--max-turns",
              "2",
            ],
            { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] },
          );
          let stdout = "",
            stderr = "";
          child.stdout?.on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr?.on("data", (chunk) => {
            stderr += chunk;
          });
          const timer = setTimeout(() => child?.kill("SIGKILL"), 15000);
          child.once("error", reject);
          child.once("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
          });
        });
        expect(bridgeFailures).toEqual([]);
        expect(result.code, result.stderr.slice(-1500)).toBe(0);
        expect(result.stdout).toContain("no child was started");
        expect(mainRequests).toBe(1);
        expect(nativeSessions.size).toBe(1);
      } finally {
        child?.kill("SIGTERM");
        bridge.closeAllConnections();
        await new Promise<void>((resolve) => bridge.close(() => resolve()));
        await rm(home, { recursive: true, force: true });
      }
    }
  });

  test("Copilot CLI subagents bind through the task prompt's delegation marker and are refused without one", async () => {
    config.openappa.offerSigningSecret = "copilot-subagent-marker-test";
    await h.app.register(openAiProxyRoutes);
    await ModelModel.upsert({
      externalId: "openai/gpt-5.5",
      provider: "openai",
      modelId: "gpt-5.5",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockReturnValue({
      responses: {
        create: async () => ({
          id: "resp_copilot_child",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-5.5",
          output: [
            {
              id: "msg_child",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "child done", annotations: [] },
              ],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
      },
    } as never);
    const prompt = "Say hi from the child";
    const marker = mintDelegationMarker({
      organizationId: h.agent.organizationId,
      callerId: `user:${h.userId}`,
      parentId: COPILOT_KEY,
      spawnerNativeId: COPILOT_KEY,
      prompt,
      spawnCallId: "call_spawn",
    });
    const send = (opening: string, subagent: boolean) =>
      h.app.inject({
        method: "POST",
        url: `/v1/openai/${h.agent.id}/responses`,
        headers: {
          authorization: "Bearer test-key",
          "x-archestra-virtual-key": h.platformKey,
          ...copilotHeaders,
          ...(subagent
            ? {
                "x-initiator": "agent",
                "x-interaction-type": "conversation-subagent",
              }
            : {}),
        },
        payload: {
          model: "gpt-5.5",
          stream: false,
          store: false,
          // Copilot's subagents share the parent's key and carry no id of their own.
          prompt_cache_key: COPILOT_KEY,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `<current_datetime>2026-10-28T23:02:45.311+04:00</current_datetime>\n\n${opening}`,
                },
              ],
            },
          ],
          tools: [
            {
              type: "function",
              name: "bash",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      });
    const child = await send(`${prompt}\n\n${marker}`, true);
    expect(child.statusCode, child.body).toBe(200);
    const childStart = h.events.find(
      (event) =>
        event.event === "session_start" &&
        String(event.session_id).endsWith(`${COPILOT_KEY}:call_spawn`),
    );
    expect(childStart, JSON.stringify(h.events)).toBeDefined();
    expect(String(childStart?.parent_id).endsWith(COPILOT_KEY)).toBe(true);

    const unmarked = await send(prompt, true);
    expect(unmarked.statusCode, unmarked.body).toBe(400);
    expect(unmarked.body).toContain(
      "carries no delegation marker from a task call",
    );

    // The parent's own turn with the same key stays a root.
    h.events.length = 0;
    const parent = await send("Delegate", false);
    expect(parent.statusCode, parent.body).toBe(200);
    const parentStart = h.events.find(
      (event) => event.event === "session_start",
    );
    expect(String(parentStart?.session_id).endsWith(COPILOT_KEY)).toBe(true);
    expect(parentStart?.parent_id ?? null).toBeNull();
  });

  test("Copilot CLI reads a governed background agent's return with a read_agent call it made itself", async () => {
    config.openappa.offerSigningSecret = "copilot-read-agent-test";
    await h.app.register(openAiProxyRoutes);
    await ModelModel.upsert({
      externalId: "openai/gpt-5.5",
      provider: "openai",
      modelId: "gpt-5.5",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
    const sent: unknown[] = [];
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockReturnValue({
      responses: {
        create: async (params: unknown) => {
          sent.push(structuredClone(params));
          return {
            id: "resp_copilot_parent",
            object: "response",
            created_at: 1,
            status: "completed",
            model: "gpt-5.5",
            output: [
              {
                id: "msg_parent",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: "It ran in the lab.",
                    annotations: [],
                  },
                ],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          };
        },
      },
    } as never);
    const value = "C:\\Users\\mark\\appa-root-flow\\lab";
    const agentId = "5ef9a71d-f2c6-47f4-abe6-3d0adb3141ef";
    // Copilot makes this call itself when it announces the agent is idle.
    const readCall = "d2a07213-03ad-49a9-a289-6acec57aba87";
    const prompt = "Run pwd and report it.";
    const parent = `user:${h.userId}|${COPILOT_KEY}`;
    const marker = mintDelegationMarker({
      organizationId: h.agent.organizationId,
      callerId: `user:${h.userId}`,
      parentId: COPILOT_KEY,
      spawnerNativeId: COPILOT_KEY,
      prompt,
      spawnCallId: "call_spawn",
    });
    // The child ran through the proxy and crossed its return. Copilot's
    // subagents report no id of their own.
    native.loadChildReturns.mockImplementation(
      async (_organizationId: string, parentSessionId: string) =>
        parentSessionId === parent
          ? [
              {
                childSessionId: `${parent}:call_spawn`,
                spawnCallId: "call_spawn",
                value,
              },
            ]
          : [],
    );
    const defaultDispatch = native.dispatchHook.getMockImplementation();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      if (event.event === "tool_result" && event.spawned_id) {
        h.events.push(event);
        return JSON.stringify({ decision: "ack" });
      }
      // The runtime released no read_agent call, as for the real binding.
      if (event.event === "tool_result" && event.tool_call_id === readCall) {
        h.events.push(event);
        return JSON.stringify({
          decision: "replace_output",
          code: "unreleased_call",
          output_source: "runtime",
          approved_output:
            "[appa] Tool output withheld: this result has no record of releasing a call.",
        });
      }
      if (!defaultDispatch) throw new Error("missing native mock");
      return defaultDispatch(raw);
    });
    h.events.length = 0;

    const response = await h.app.inject({
      method: "POST",
      url: `/v1/openai/${h.agent.id}/responses`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-virtual-key": h.platformKey,
        ...copilotHeaders,
      },
      payload: {
        model: "gpt-5.5",
        stream: false,
        store: false,
        prompt_cache_key: COPILOT_KEY,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<current_datetime>2026-11-01T00:43:06.768+04:00</current_datetime>\n\nStart a subagent in the background that runs pwd, then read its result.",
              },
            ],
          },
          {
            type: "function_call",
            id: "fc_spawn",
            call_id: "call_spawn",
            name: "task",
            status: "completed",
            arguments: JSON.stringify({
              agent_type: "task",
              description: "Run pwd",
              mode: "background",
              name: "pwd-runner",
              prompt: `${prompt}\n\n${marker}`,
              model: "archestra/gpt-5.5",
            }),
          },
          {
            type: "function_call_output",
            call_id: "call_spawn",
            output: `Agent started in background with agent_id: ${agentId}. You'll be notified when it completes.`,
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Waiting for it." }],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: '<system_notification>\nAgent "pwd-runner" (task) has finished processing and is now idle.\n</system_notification>',
              },
            ],
          },
          {
            type: "function_call",
            id: "fc_read",
            call_id: readCall,
            name: "read_agent",
            status: "completed",
            arguments: JSON.stringify({ agent_id: agentId, since_turn: 0 }),
          },
          {
            type: "function_call_output",
            call_id: readCall,
            output: `Agent is idle (waiting for messages). agent_id: ${agentId}, agent_type: task, status: idle, description: Run pwd, elapsed: 3s, total_turns: 1\n\n[Turn 0]\n${value}\n\n${mintChildReturnMarker(
              {
                organizationId: h.agent.organizationId,
                callerId: `user:${h.userId}`,
                parentId: parent,
                childId: `${parent}:call_spawn`,
                spawnCallId: "call_spawn",
                value,
              },
            )}`,
          },
        ],
        tools: [
          {
            type: "function",
            name: "task",
            parameters: {
              type: "object",
              properties: { prompt: { type: "string" } },
            },
          },
          {
            type: "function",
            name: "read_agent",
            parameters: {
              type: "object",
              properties: { agent_id: { type: "string" } },
            },
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain("OpenAPPA blocked");
    expect(sent).toHaveLength(1);
    const upstream = (sent[0] as { input: Array<Record<string, unknown>> })
      .input;
    // The model reads the verified return, without the client's status line.
    expect(
      upstream.find(
        (item) =>
          item.type === "function_call_output" && item.call_id === readCall,
      )?.output,
    ).toBe(value);
    expect(JSON.stringify(upstream)).not.toContain("finished subagent");
    expect(
      h.events
        .filter((event) => event.spawned_id)
        .map((event) => event.tool_call_id),
    ).toEqual(["call_spawn"]);
  });

  describe("Copilot CLI background agents across a turn", () => {
    const value = "C:\\Users\\mark\\appa-root-flow\\lab";
    const agentId = "23ec0773-4acb-4200-92a9-4e643870c94d";
    // Copilot makes this call itself when it announces the agent is idle.
    const readCall = "c613c943-fe02-4c1c-9c4c-2f6f0ad0a9d1";
    const prompt = "Run pwd and report it.";
    const OUTCOME_MISMATCH =
      "this outcome does not match the open dispatch; it is not reported";
    /**
     * Spawn calls the stand-in runtime holds open, those whose subagent
     * started, and those it closed.
     */
    let open: Set<string>;
    let started: Set<string>;
    let closed: Set<string>;
    let sent: Array<{ input: Array<Record<string, unknown>> }>;
    const intrinsicReadCalls = new Set<string>();

    const parent = () => `user:${h.userId}|${COPILOT_KEY}`;
    const launched = () => [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<current_datetime>2026-11-01T02:57:47.037+04:00</current_datetime>\n\nStart a subagent in the background with the task tool that runs pwd, then read its result with read_agent.",
          },
        ],
      },
      {
        type: "function_call",
        id: "fc_spawn",
        call_id: "call_spawn",
        name: "task",
        status: "completed",
        arguments: JSON.stringify({
          agent_type: "task",
          description: "Print current working directory",
          mode: "background",
          name: "pwd-agent",
          prompt: `${prompt}\n\n${mintDelegationMarker({
            organizationId: h.agent.organizationId,
            callerId: `user:${h.userId}`,
            parentId: COPILOT_KEY,
            spawnerNativeId: COPILOT_KEY,
            prompt,
            spawnCallId: "call_spawn",
          })}`,
          model: "archestra/gpt-5.5",
        }),
      },
      {
        type: "function_call_output",
        call_id: "call_spawn",
        output: `Agent started in background with agent_id: ${agentId}. You'll be notified when it completes. Tell the user you're waiting and end your response, or continue unrelated work until notified.`,
      },
    ];
    const reported = () => [
      ...launched(),
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "The background subagent has started; I'm waiting for its result.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: '<system_notification>\nAgent "pwd-agent" (task) has finished processing and is now idle.\n</system_notification>',
          },
        ],
      },
      {
        type: "function_call",
        id: "fc_read",
        call_id: readCall,
        name: "read_agent",
        status: "completed",
        arguments: JSON.stringify({ agent_id: agentId, since_turn: 0 }),
      },
      {
        type: "function_call_output",
        call_id: readCall,
        output: `Agent is idle (waiting for messages). agent_id: ${agentId}, agent_type: task, status: idle, description: Print current working directory, elapsed: 5s, total_turns: 1, model: archestra/gpt-5.5\n\n[Turn 0]\n${value}\n\n${mintChildReturnMarker(
          {
            organizationId: h.agent.organizationId,
            callerId: `user:${h.userId}`,
            parentId: parent(),
            childId: `${parent()}:call_spawn`,
            spawnCallId: "call_spawn",
            value,
          },
        )}`,
      },
    ];
    const send = (input: unknown[]) => {
      for (const call of input as Array<{
        type?: string;
        name?: string;
        call_id?: string;
      }>) {
        if (
          call.type === "function_call" &&
          call.name === "read_agent" &&
          call.call_id
        )
          intrinsicReadCalls.add(call.call_id);
      }
      return h.app.inject({
        method: "POST",
        url: `/v1/openai/${h.agent.id}/responses`,
        headers: {
          authorization: "Bearer test-key",
          "x-archestra-virtual-key": h.platformKey,
          ...copilotHeaders,
        },
        payload: {
          model: "gpt-5.5",
          stream: false,
          store: false,
          prompt_cache_key: COPILOT_KEY,
          input,
          tools: [
            {
              type: "function",
              name: "task",
              parameters: {
                type: "object",
                properties: { prompt: { type: "string" } },
              },
            },
            {
              type: "function",
              name: "read_agent",
              parameters: {
                type: "object",
                properties: { agent_id: { type: "string" } },
              },
            },
            // The gateway's remedy tools: with them the proxy governs the
            // session's turns, and ends a turn the model closes.
            ...(
              [
                ["archestra__get_remedy_plans", "Read the blocked ruling"],
                ["archestra__execute_remedy_plan", "Apply a remedy"],
              ] as const
            ).map(([advertisedName, description]) => ({
              type: "function",
              // Copilot spells an MCP tool <server>-<advertised name>.
              name: `prod_gateway-${advertisedName}`,
              description: attestToolDescription({
                organizationId: h.agent.organizationId,
                gatewayId: h.agent.id,
                advertisedName,
                kind: "b",
                description,
              }),
              parameters: { type: "object", properties: {} },
            })),
          ],
        },
      });
    };
    const readOutput = () =>
      sent
        .at(-1)
        ?.input.find(
          (item) =>
            item.type === "function_call_output" && item.call_id === readCall,
        )?.output;
    const readAgain = (
      input: unknown[],
      {
        callId = "call_reread",
        childId = agentId,
        output = (reported().at(-1) as { output: string }).output,
      }: { callId?: string; childId?: string; output?: string } = {},
    ) => [
      ...input,
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: `The agent reported ${value}.` },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Read the background agent's result again.",
          },
        ],
      },
      {
        type: "function_call",
        id: `fc_${callId}`,
        call_id: callId,
        name: "read_agent",
        status: "completed",
        arguments: JSON.stringify({ agent_id: childId }),
      },
      { type: "function_call_output", call_id: callId, output },
    ];

    beforeEach(async ({ seedAndAssignArchestraTools }) => {
      await seedAndAssignArchestraTools(h.agent.id);
      config.openappa.offerSigningSecret = "copilot-background-turn-test";
      await h.app.register(openAiProxyRoutes);
      await ModelModel.upsert({
        externalId: "openai/gpt-5.5",
        provider: "openai",
        modelId: "gpt-5.5",
        inputModalities: null,
        outputModalities: null,
        lastSyncedAt: new Date(),
      });
      sent = [];
      intrinsicReadCalls.clear();
      vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockReturnValue({
        responses: {
          create: async (params: unknown) => {
            sent.push(structuredClone(params) as (typeof sent)[number]);
            return {
              id: "resp_copilot_parent",
              object: "response",
              created_at: 1,
              status: "completed",
              model: "gpt-5.5",
              output: [
                {
                  id: "msg_parent",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    { type: "output_text", text: "Done.", annotations: [] },
                  ],
                },
              ],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            };
          },
        },
      } as never);
      // The child ran through the proxy and crossed its return.
      native.loadChildReturns.mockImplementation(
        async (_organizationId: string, parentSessionId: string) =>
          parentSessionId === parent()
            ? [
                {
                  childSessionId: `${parent()}:call_spawn`,
                  spawnCallId: "call_spawn",
                  value,
                },
              ]
            : [],
      );
      // As appa-runtime's on_turn_end does, a turn end closes the calls still
      // open but a spawn whose subagent started, which stays open for its
      // result. A later report against a closed call is refused, as
      // decide_outcome does.
      open = new Set(["call_spawn"]);
      started = new Set(["call_spawn"]);
      closed = new Set();
      const defaultDispatch = native.dispatchHook.getMockImplementation();
      native.dispatchHook.mockImplementation(async (raw: string) => {
        const event = JSON.parse(raw);
        if (event.event === "turn_end") {
          h.events.push(event);
          for (const id of open) {
            if (started.has(id)) continue;
            closed.add(id);
            open.delete(id);
          }
          return JSON.stringify({ decision: "ack" });
        }
        if (event.event === "tool_result" && event.spawned_id) {
          h.events.push(event);
          if (closed.has(event.tool_call_id)) {
            return JSON.stringify({
              decision: "block",
              reason: OUTCOME_MISMATCH,
              output_source: "runtime",
              approved_output: `[appa] Tool output withheld: ${OUTCOME_MISMATCH}`,
            });
          }
          open.delete(event.tool_call_id);
          return JSON.stringify({ decision: "ack" });
        }
        // The runtime released no read_agent call, as for the real binding.
        if (
          event.event === "tool_result" &&
          intrinsicReadCalls.has(event.tool_call_id)
        ) {
          h.events.push(event);
          return JSON.stringify({
            decision: "replace_output",
            code: "unreleased_call",
            output_source: "runtime",
            approved_output:
              "[appa] Tool output withheld: this result has no record of releasing a call.",
          });
        }
        if (!defaultDispatch) throw new Error("missing native mock");
        return defaultDispatch(raw);
      });
      h.events.length = 0;
    });

    test("keeps the turn open until the agent's return arrives, so the return is reported", async () => {
      // The model tells the user it waits and ends its response.
      const waiting = await send(launched());
      expect(waiting.statusCode, waiting.body).toBe(200);
      expect(h.events.filter((event) => event.event === "turn_end")).toEqual(
        [],
      );
      expect(open.has("call_spawn")).toBe(true);

      // Copilot comes back by itself with its read_agent report.
      const returned = await send(reported());
      expect(returned.statusCode, returned.body).toBe(200);
      expect(readOutput()).toBe(value);
      expect(JSON.stringify(sent.at(-1))).not.toContain("finished subagent");
      const order = h.events.flatMap((event) =>
        event.event === "turn_end"
          ? ["turn_end"]
          : event.event === "tool_result" && event.spawned_id
            ? [`return:${event.tool_call_id}`]
            : [],
      );
      // The return is reported against the open spawn, then the turn ends.
      expect(order).toEqual(["return:call_spawn", "turn_end"]);
    });

    test("holds only the turn that answers the launch, so an agent that never reports holds nothing later", async () => {
      const waiting = await send(launched());
      expect(waiting.statusCode, waiting.body).toBe(200);
      expect(h.events.filter((event) => event.event === "turn_end")).toEqual(
        [],
      );

      // The person moves on; the agent is cancelled and never reported.
      const later = await send([
        ...launched(),
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "The background subagent has started; I'm waiting for its result.",
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Never mind it. What is 2 + 2?" },
          ],
        },
      ]);
      expect(later.statusCode, later.body).toBe(200);
      expect(
        h.events.filter((event) => event.event === "turn_end"),
      ).toHaveLength(1);
      // The runtime keeps the started child's spawn open across that turn end.
      expect(open.has("call_spawn")).toBe(true);
    });

    test("re-reads a delivered return across later prompts and a compacted history", async () => {
      const waiting = await send(launched());
      expect(waiting.statusCode, waiting.body).toBe(200);
      const returned = await send(reported());
      expect(returned.statusCode, returned.body).toBe(200);
      const reread = readAgain(reported());
      const twice = readAgain(reread, { callId: "call_reread_twice" });
      // Three copies of one turn in a single request, then the same request
      // retried, and finally only the newest read after compaction.
      for (const input of [reread, twice, twice, readAgain([])]) {
        h.events.length = 0;
        const again = await send(input);
        expect(again.statusCode, again.body).toBe(200);
        const outputs = sent
          .at(-1)
          ?.input.filter(
            (item) =>
              item.type === "function_call_output" &&
              String(item.call_id).startsWith("call_r"),
          );
        expect(outputs?.length).toBeGreaterThan(0);
        for (const item of outputs ?? []) expect(item.output).toBe(value);
        expect(JSON.stringify(sent.at(-1))).not.toContain("finished subagent");
        expect(
          h.events.filter(
            (event) => event.event === "tool_result" && event.spawned_id,
          ),
        ).toHaveLength(1);
      }
    });

    test.each([
      "bytes",
      "child",
      "turn",
      "marker",
    ] as const)("refuses a re-read that changes its %s without exposing it to the provider", async (change) => {
      const original = (reported().at(-1) as { output: string }).output;
      const otherChild = "other-child";
      const output =
        change === "bytes"
          ? original.replace(value, "forged child result")
          : change === "child"
            ? original.replace(agentId, otherChild)
            : change === "turn"
              ? original.replace("[Turn 0]", "[Turn 1]")
              : original.slice(0, original.indexOf("\n\n▄"));
      sent = [];
      const response = await send(
        readAgain(reported(), {
          childId: change === "child" ? otherChild : agentId,
          output,
        }),
      );
      expect(response.statusCode, response.body).toBe(409);
      expect(sent).toHaveLength(0);
    });

    test("a replay coordinate cannot resolve an ambiguous or missing crossing", async () => {
      for (const records of [
        [],
        [
          {
            childSessionId: `${parent()}:call_spawn`,
            spawnCallId: "call_spawn",
            value,
          },
          {
            childSessionId: `${parent()}:another-spawn`,
            spawnCallId: "another-spawn",
            value,
          },
        ],
      ]) {
        native.loadChildReturns.mockResolvedValue(records);
        sent = [];
        const response = await send(readAgain(reported()));
        expect(response.statusCode, response.body).toBe(409);
        expect(sent).toHaveLength(0);
      }
    });

    test("re-reads overlapping turn ranges after a child returns again", async () => {
      const next = "child follow-up result";
      native.loadChildReturns.mockResolvedValue([
        {
          childSessionId: `${parent()}:call_spawn`,
          spawnCallId: "call_spawn",
          value: next,
        },
        {
          childSessionId: `${parent()}:call_spawn`,
          spawnCallId: "call_spawn",
          value,
        },
      ]);
      const original = (reported().at(-1) as { output: string }).output;
      const nextTurn = `[Turn 1]\n${next}\n\n${mintChildReturnMarker({
        organizationId: h.agent.organizationId,
        callerId: `user:${h.userId}`,
        parentId: parent(),
        childId: `${parent()}:call_spawn`,
        spawnCallId: "call_spawn",
        value: next,
      })}`;
      const allTurns = `${original}\n\n${nextTurn}`;
      const history = readAgain(reported(), { output: allTurns });
      const response = await send(
        readAgain(history, {
          callId: "call_read_latest",
          output:
            original.slice(0, original.indexOf("\n\n[Turn")) +
            "\n\n" +
            nextTurn,
        }),
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(
        sent
          .at(-1)
          ?.input.find(
            (item) =>
              item.type === "function_call_output" &&
              item.call_id === "call_reread",
          )?.output,
      ).toBe(`[Turn 0]\n${value}\n\n[Turn 1]\n${next}`);
      expect(
        sent
          .at(-1)
          ?.input.find(
            (item) =>
              item.type === "function_call_output" &&
              item.call_id === "call_read_latest",
          )?.output,
      ).toBe(next);
    });

    test.each([
      "same bytes",
      "empty",
    ] as const)("preserves both turns when a later return has %s", async (kind) => {
      const next = kind === "same bytes" ? value : "";
      const crossing = {
        childSessionId: `${parent()}:call_spawn`,
        spawnCallId: "call_spawn",
        value,
      };
      native.loadChildReturns.mockResolvedValue(
        kind === "same bytes" ? [crossing, crossing] : [crossing],
      );
      const original = (reported().at(-1) as { output: string }).output;
      const output = `${original}\n\n[Turn 1]\n${next}\n\n${mintChildReturnMarker(
        {
          organizationId: h.agent.organizationId,
          callerId: `user:${h.userId}`,
          parentId: parent(),
          childId: `${parent()}:call_spawn`,
          spawnCallId: "call_spawn",
          value: next,
        },
      )}`;
      const response = await send(readAgain(reported(), { output }));
      expect(response.statusCode, response.body).toBe(200);
      expect(
        sent
          .at(-1)
          ?.input.find(
            (item) =>
              item.type === "function_call_output" &&
              item.call_id === "call_reread",
          )?.output,
      ).toBe(`[Turn 0]\n${value}\n\n[Turn 1]\n${next}`);
    });

    test("waives a background return whose spawn call closed and keeps its original output", async () => {
      const overrides = config.openappa.breakTheGlassOverrides;
      const yellEnabled = config.openappa.yellEnabled;
      config.openappa.breakTheGlassOverrides = {
        ...overrides,
        unapprovableBlockMode: "allow",
      };
      config.openappa.yellEnabled = false;
      open.clear();
      started.clear();
      closed.add("call_spawn");
      try {
        const response = await send(reported());
        expect(response.statusCode, response.body).toBe(200);
        expect(h.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: "tool_result",
              tool_call_id: "call_spawn",
              spawned_id: `${parent()}:call_spawn`,
            }),
          ]),
        );
        expect(readOutput()).toContain(value);
        expect(readOutput()).not.toContain("Tool output withheld");
        expect(
          await OpenAppaUnenforcedModel.findSessions({
            organizationId: h.agent.organizationId,
            sessionIds: [parent()],
          }),
        ).toEqual([expect.objectContaining({ reason: "superyell" })]);
        const again = await send(reported());
        expect(again.statusCode, again.body).toBe(200);
        expect(readOutput()).toContain(value);
      } finally {
        config.openappa.breakTheGlassOverrides = overrides;
        config.openappa.yellEnabled = yellEnabled;
      }
    });

    test("withholds a return its spawn call no longer takes, and the session goes on", async () => {
      // A new prompt's first call settled the turn before the subagent
      // started, so the runtime closed the spawn.
      open.clear();
      started.clear();
      closed.add("call_spawn");

      for (const attempt of [1, 2]) {
        const response = await send(reported());
        expect(
          response.statusCode,
          `attempt ${attempt}: ${response.body}`,
        ).toBe(200);
        expect(readOutput()).toBe(
          "[appa] Tool output withheld: this subagent returned after its call was closed, so its result does not reach this session. Start the subagent again if you still need it.",
        );
        expect(JSON.stringify(sent.at(-1))).not.toContain(value);
      }
    });
  });

  test.each([
    true,
    false,
  ])("forwards Claude's provider-hosted advisor without treating it as a client call (stream=%s)", async (stream) => {
    h.options = { includeToolUse: false };
    const body = h.payload(stream);
    const response = await h.post({
      ...body,
      tools: [
        ...body.tools,
        { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-8" },
      ],
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(JSON.stringify(h.providerRequests)).toContain("advisor_20260301");
    expect(h.events.filter((event) => event.event === "tool_call")).toEqual([]);
  });

  test.each([
    true,
    false,
  ])("a denied call reaches the client as a denial notice, with no extra provider request (stream=%s)", async (stream) => {
    h.block = true;

    const response = await h.post(h.payload(stream));

    expect(response.statusCode, response.body).toBe(200);
    const notice = noticeFrom(response.body, stream);
    // Same position, same provider call id: the client runs the notice where
    // the model's own call stood, and the transcript shows what was blocked.
    expect(notice.name).toBe("archestra__get_remedy_plans");
    expect(notice.id).toBe("toolu_test_weather");
    expect(notice.input.tool).toBe("get_weather");
    // The notice preserves the model argument bytes; the stub streams a fuller
    // argument set than it returns whole.
    expect(notice.input.arguments).toBe(
      stream
        ? JSON.stringify({ location: "San Francisco", unit: "fahrenheit" })
        : JSON.stringify({ location: "SF" }),
    );
    // The ruling travels in the clear, where a client-side judge can read it.
    expect(notice.input.ruling).toBe(
      "[appa] NATIVE REFUSAL: execute_remedy_plan(offer_id: test-offer)",
    );
    expect(notice.input.notice).toEqual({
      v: 1,
      call_id: notice.id,
    });
    // A denial costs no second call to the provider.
    expect(h.providerRequests).toHaveLength(1);
    expect(
      h.events.filter((event) => event.event === "tool_call"),
    ).toHaveLength(1);
  });

  /** A session that declares the run_tool dispatch surface beside the APPA pair. */
  const dispatchPayload = (
    stream: boolean,
    messages: unknown[] = [{ role: "user", content: "List my meetings" }],
  ) => {
    const body = h.payload(stream, messages);
    body.tools.push({
      name: "archestra__run_tool",
      description: "Dispatch a tool by name",
      input_schema: { type: "object", properties: {} },
    });
    return body;
  };
  const dispatchCall = {
    name: "archestra__run_tool",
    input: { tool_name: "grain__list_meetings", tool_args: { limit: 5 } },
  };

  test.each([
    true,
    false,
  ])("a denied run_tool dispatch reaches the client as a notice naming the target tool (stream=%s)", async (stream) => {
    h.block = true;
    h.options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: dispatchCall,
      streamingToolUse: dispatchCall,
    };

    const response = await h.post(dispatchPayload(stream));

    expect(response.statusCode, response.body).toBe(200);
    // The runtime ruled on the dispatch's target — exact name and the target's
    // own arguments — so named rules, annotator bindings, and the wildcard
    // catch-all all apply to the tool that will actually execute.
    expect(h.events.filter((event) => event.event === "tool_call")).toEqual([
      expect.objectContaining({
        tool: "grain__list_meetings",
        arguments: { limit: 5 },
      }),
    ]);
    const notice = noticeFrom(response.body, stream);
    expect(notice.name).toBe("archestra__get_remedy_plans");
    // The notice names the policy target; its ruling explains that the
    // dispatch already used the wrapper, so another route is not a remedy.
    expect(notice.input.tool).toBe("grain__list_meetings");
    expect(notice.input.arguments).toBe(JSON.stringify({ limit: 5 }));
    expect(notice.input.ruling).toMatch(
      /^\[appa\] NATIVE REFUSAL: execute_remedy_plan\(offer_id: test-offer\)/,
    );
    expect(notice.input.ruling).toContain(
      'already went through the run_tool wrapper "archestra__run_tool"',
    );
    expect(notice.input.ruling).toContain(
      'tool_name targeting "grain__list_meetings"',
    );
    expect(notice.input.ruling).not.toContain("STOP this blocked action");
    expect(notice.input.notice).toEqual({
      v: 1,
      call_id: notice.id,
    });
    expect(h.providerRequests).toHaveLength(1);
  });

  test("restores a denied dispatch as the target call and its ruling on the next request", async () => {
    h.block = true;
    h.options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: dispatchCall,
      streamingToolUse: dispatchCall,
    };
    const first = await h.post(dispatchPayload(false));
    const notice = noticeFrom(first.body, false);
    h.block = false;

    const second = await h.post(
      dispatchPayload(false, [
        { role: "user", content: "List my meetings" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: notice.id,
              name: "archestra__get_remedy_plans",
              input: notice.input,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: notice.id,
              content: "rendered for the user",
            },
          ],
        },
      ]),
    );

    expect(second.statusCode, second.body).toBe(200);
    const sent = h.providerRequests.at(-1) as {
      messages: { role: string; content: Record<string, unknown>[] }[];
    };
    // History still records the policy target, while the authoritative ruling
    // retains the explanation that the wrapper was already checked.
    expect(sent.messages[1].content[0]).toEqual({
      type: "tool_use",
      id: notice.id,
      name: "grain__list_meetings",
      input: { limit: 5 },
    });
    expect(sent.messages[2].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: notice.id,
      is_error: true,
      content: expect.stringMatching(
        /^\[appa\] NATIVE REFUSAL: execute_remedy_plan\(offer_id: test-offer\)/,
      ),
    });
    expect(sent.messages[2].content[0].content).toContain(
      'already went through the run_tool wrapper "archestra__run_tool"',
    );
    expect(sent.messages[2].content[0].content).not.toContain(
      "STOP this blocked action",
    );
  });

  test("releases the retried dispatch as the wrapper after the remedy, still ruled on as the target", async () => {
    h.block = true;
    h.options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: dispatchCall,
      streamingToolUse: dispatchCall,
    };
    const first = await h.post(dispatchPayload(false));
    const notice = noticeFrom(first.body, false);
    h.block = false;

    // The model spends the offer through the control tool.
    const control = {
      name: "archestra__execute_remedy_plan",
      input: { offer_id: "test-offer" },
    };
    h.options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: control,
      streamingToolUse: control,
    };
    const remedyResponse = await h.post(
      dispatchPayload(false, [
        { role: "user", content: "List my meetings" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: notice.id,
              name: "archestra__get_remedy_plans",
              input: notice.input,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: notice.id,
              content: "rendered for the user",
            },
          ],
        },
      ]),
    );
    const remedy = noticeFrom(remedyResponse.body, false);
    expect(remedy.name).toBe("archestra__execute_remedy_plan");

    // The model retries the same envelope; the acceptance has narrowed the
    // session, so the runtime releases it this time.
    h.options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: dispatchCall,
      streamingToolUse: dispatchCall,
    };
    const retry = await h.post(
      dispatchPayload(false, [
        { role: "user", content: "List my meetings" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: notice.id,
              name: "archestra__get_remedy_plans",
              input: notice.input,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: notice.id,
              content: "rendered for the user",
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", ...remedy }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: remedy.id,
              content: "Applied",
            },
          ],
        },
      ]),
    );

    expect(retry.statusCode, retry.body).toBe(200);
    const released = noticeFrom(retry.body, false);
    // The client receives the wrapper it can execute — never the unwrapped
    // target, which it may not even have declared.
    expect(released.name).toBe("archestra__run_tool");
    expect(released.input).toEqual(dispatchCall.input);
    // Both evaluations named the target to the runtime: the denial and the
    // release after the remedy.
    expect(h.events.filter((event) => event.event === "tool_call")).toEqual([
      expect.objectContaining({
        tool: "grain__list_meetings",
        dispatch: "archestra__run_tool",
      }),
      expect.objectContaining({
        tool: "grain__list_meetings",
        dispatch: "archestra__run_tool",
      }),
    ]);
  });

  test("restores the denied call and its ruling on the client's next request", async () => {
    h.block = true;
    const first = await h.post(h.payload(false));
    const notice = noticeFrom(first.body, false);
    h.block = false;

    const second = await h.post(
      h.payload(false, [
        { role: "user", content: "Check the weather" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: notice.id,
              name: "archestra__get_remedy_plans",
              input: notice.input,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: notice.id,
              content: "rendered for the user",
            },
          ],
        },
      ]),
    );

    expect(second.statusCode, second.body).toBe(200);
    const sent = h.providerRequests.at(-1) as {
      messages: { role: string; content: Record<string, unknown>[] }[];
      tools: { name: string }[];
    };
    // The provider is shown the call the model actually made, and APPA's ruling
    // as its result — never the proxy's own notice tool.
    expect(sent.messages[1].content[0]).toEqual({
      type: "tool_use",
      id: notice.id,
      name: "get_weather",
      input: { location: "SF" },
    });
    expect(sent.messages[2].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: notice.id,
      is_error: true,
      content:
        "[appa] NATIVE REFUSAL: execute_remedy_plan(offer_id: test-offer)",
    });
    expect(sent.tools.map((declared) => declared.name)).not.toContain(
      "archestra__get_remedy_plans",
    );
  });

  test("answers the notice of a call whose annotator gave no answer itself, and never rules on that call as one that ran", async () => {
    h.unruled = "get_weather";
    const first = await h.post(h.payload(false));
    const notice = noticeFrom(first.body, false);
    h.unruled = undefined;
    const before = h.events.length;

    const second = await h.post(
      h.payload(false, [
        { role: "user", content: "Check the weather" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: notice.id,
              name: "archestra__get_remedy_plans",
              input: notice.input,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: notice.id,
              content: "client text in place of the notice",
            },
          ],
        },
      ]),
    );

    expect(second.statusCode, second.body).toBe(200);
    // Only the notice ran. Reporting its result would make the runtime rule on
    // the call after the fact and ask the annotator that just failed again.
    expect(
      h.events
        .slice(before)
        .filter(
          (event) =>
            event.event === "tool_result" && event.tool_call_id === notice.id,
        ),
    ).toEqual([]);
    const sent = h.providerRequests.at(-1) as {
      messages: { role: string; content: Record<string, unknown>[] }[];
    };
    expect(sent.messages[1].content[0]).toEqual({
      type: "tool_use",
      id: notice.id,
      name: "get_weather",
      input: { location: "SF" },
    });
    expect(sent.messages[2].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: notice.id,
      content: expect.stringContaining(
        'its annotator "archestra.tool-call" did not answer in time. The call did not run.',
      ),
    });
  });

  test.each([
    false,
    true,
  ])("stamps and restores the model's remedy call through the real adapter (stream=%s)", async (stream) => {
    const control = {
      name: "archestra__execute_remedy_plan",
      input: { offer_id: "test-offer" },
    };
    h.options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: control,
      streamingToolUse: control,
    };

    const response = await h.post(h.payload(stream));

    expect(response.statusCode, response.body).toBe(200);
    const released = noticeFrom(response.body, stream);
    // The client executes it against the gateway, which dispatches the one
    // control ToolCall. A second one here would vouch the offer twice.
    expect(released).toMatchObject({
      name: "archestra__execute_remedy_plan",
      input: {
        offer_id: "test-offer",
        trajectory: { v: 1, session_id: h.sessionId },
        execution: {
          v: 1,
          kind: "appa_remedy",
          call_id: released.id,
          tool_name: control.name,
          original_arguments: JSON.stringify(control.input),
        },
      },
    });
    expect(released.input.trajectory).not.toHaveProperty("parent_id");
    expect(h.events.filter((event) => event.event === "tool_call")).toEqual([]);

    h.options = {};
    const followup = await h.post(
      h.payload(false, [
        { role: "user", content: "Apply the offered remedy" },
        {
          role: "assistant",
          content: [{ type: "tool_use", ...released }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: released.id,
              content: "Applied",
            },
          ],
        },
      ]),
    );
    expect(followup.statusCode, followup.body).toBe(200);
    expect(h.providerRequests.at(-1)).toMatchObject({
      messages: [
        expect.any(Object),
        {
          role: "assistant",
          content: [{ type: "tool_use", id: released.id, ...control }],
        },
        expect.any(Object),
      ],
    });
    expect(JSON.stringify(h.providerRequests.at(-1))).not.toContain(
      '"execution"',
    );
    expect(JSON.stringify(h.providerRequests.at(-1))).not.toContain(
      '"trajectory"',
    );
  });

  test.each([
    false,
    true,
  ])("re-emits an in-place rewrite so the client receives the policy-checked arguments (stream=%s)", async (stream) => {
    const unregister = registerLlmProxyPlugin({
      id: "test-in-place-rewriter",
      async onToolCalls({ toolCalls }) {
        toolCalls[0].arguments = { location: "approved" };
        return undefined;
      },
    });
    try {
      const tool = { name: "get_weather", input: { location: "original" } };
      h.options = {
        includeToolUse: true,
        streamStopReason: "tool_use",
        nonStreamingToolUse: tool,
        streamingToolUse: tool,
      };
      const response = await h.post(h.payload(stream));
      expect(response.statusCode, response.body).toBe(200);
      const released = noticeFrom(response.body, stream);
      expect(released.name).toBe("get_weather");
      expect(released.input).toEqual({ location: "approved" });
      expect(
        h.events.find((event) => event.event === "tool_call")?.arguments,
      ).toEqual({ location: "approved" });
    } finally {
      unregister();
    }
  });

  test("records a denied run_tool dispatch on the tool-call event, not in a signed offer", async () => {
    // The retry hint the runtime renders after the offer is accepted names
    // the tool the client called; a run_tool caller holds no tool by the
    // target's own name. That name is saved with the call, not signed into
    // the notice.
    config.openappa = { ...config.openappa, offerSigningSecret: "" };
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      h.events.push(event);
      if (event.event === "tool_call")
        return JSON.stringify({
          decision: "deny_call",
          feedback: "[appa] Blocked",
          offers: [{ offer_id: "offer-1" }],
        });
      return JSON.stringify({ decision: "ack" });
    });
    const body = h.payload(false);
    body.tools.push({
      name: "archestra__run_tool",
      description: "Run a tool",
      input_schema: { type: "object", properties: {} },
    } as (typeof body.tools)[number]);
    h.options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: {
        name: "archestra__run_tool",
        input: { tool_name: "archestra__whoami", tool_args: {} },
      },
    };

    const response = await h.post(body);

    expect(response.statusCode, response.body).toBe(200);
    const notice = noticeFrom(response.body, false);
    expect(notice.name).toBe("archestra__get_remedy_plans");
    expect(notice.input.tool).toBe("archestra__whoami");
    expect(notice.input).not.toHaveProperty("offers");
    expect(JSON.stringify(notice.input)).not.toContain("signature");
    expect(h.events.filter((event) => event.event === "tool_call")).toEqual([
      expect.objectContaining({
        tool: "archestra__whoami",
        dispatch: "archestra__run_tool",
      }),
    ]);
  });

  test("injects the missing notice tool when the client omitted get_remedy_plans", async () => {
    const body = h.payload(false);
    body.tools = body.tools.filter(
      (declared) => declared.name !== "archestra__get_remedy_plans",
    );

    const response = await h.post(body);

    expect(response.statusCode, response.body).toBe(200);
    expect(h.providerRequests.length).toBeGreaterThan(0);
  });
});
