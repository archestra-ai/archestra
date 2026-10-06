// biome-ignore-all lint/suspicious/noExplicitAny: test

import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_ASK_USER_FULL_NAME,
} from "@archestra/shared";
import { vi } from "vitest";
import { scopedSessionId, sessionCallerId } from "@/openappa/actor";
import { currentTrajectory } from "@/openappa/current-trajectory";
import {
  clearHitlReview,
  consumeHitlRuling,
  recordHitlRuling,
  stageHitlReview,
} from "@/openappa/hitl-review";
import * as runtimeReview from "@/openappa/runtime-hitl-review";
import type { OpenAppaSession } from "@/openappa/service";
import { workloadPrincipal } from "@/services/agent-runtime/runtime-identity";
import { beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import type { Agent } from "@/types";
import {
  type ArchestraContext,
  executeArchestraTool,
  getArchestraMcpTools,
} from ".";

// The real cache, stored in this file's test database.
setupTestCacheManager();

describe("chat tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;
  // The Chat conversation the ask_user calls below run in, which is also the
  // OpenAPPA session the proxy stamps on their remedy calls.
  let sessionId: string;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    testAgent = await makeAgent({
      name: "Test Agent",
      agentType: "agent",
      organizationId: org.id,
    });
    sessionId = crypto.randomUUID();
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: user.id,
      organizationId: org.id,
      sessionId,
    };
  });

  function trajectory(
    overrides: { sessionId?: string; parentId?: string } = {},
  ) {
    return currentTrajectory({
      session_id:
        overrides.sessionId ??
        scopedSessionId(`user:${mockContext.userId}`, sessionId),
      ...(overrides.parentId ? { parent_id: overrides.parentId } : {}),
    });
  }

  function reviewSession(params: {
    sessionId: string;
    parentId?: string;
    callerId?: string;
  }): OpenAppaSession {
    const callerId = params.callerId ?? sessionCallerId(params.sessionId);
    return {
      organization_id: mockContext.organizationId as string,
      session_id: params.sessionId,
      ...(callerId ? { caller_id: callerId } : {}),
      ...(params.parentId ? { parent_id: params.parentId } : {}),
    };
  }

  test("ask_user advertises offer IDs but not the proxy trajectory", () => {
    const tool = getArchestraMcpTools().find(
      (candidate) => candidate.name === TOOL_ASK_USER_FULL_NAME,
    );
    const properties = tool?.inputSchema.properties;
    expect(properties).toHaveProperty("remedy_offer_ids");
    expect(properties).not.toHaveProperty("remedy_offers");
    expect(properties).not.toHaveProperty("trajectory");
    expect(tool?.inputSchema.additionalProperties).not.toBe(false);
  });

  test("a malformed ask_user call is shown the advertised arguments, not the proxy's", async () => {
    const result = await executeArchestraTool(
      TOOL_ASK_USER_FULL_NAME,
      { options: [{ label: "Approve" }] },
      mockContext,
    );

    expect(result.isError).toBe(true);
    const text = result.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    expect(text).toContain('"remedy_offer_ids"');
    expect(text).not.toContain('"remedy_offers"');
    expect(text).not.toContain('"trajectory"');
  });

  const acceptingElicitation = {
    elicit: async () => ({
      status: "answered" as const,
      result: {
        action: "accept" as const,
        content: { choice: "Accept for this session" },
      },
    }),
  };

  test("todo_write returns error when todos is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}todo_write`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__todo_write",
    );
    expect((result.content[0] as any).text).toContain("todos:");
  });

  test("todo_write succeeds with valid todos", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}todo_write`,
      {
        todos: [
          { id: 1, content: "Test task", status: "pending" },
          { id: 2, content: "Another task", status: "completed" },
        ],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ success: true, todoCount: 2 });
    expect((result.content[0] as any).text).toContain(
      "Successfully wrote 2 todo item(s)",
    );
  });

  test("ask_user in a headless run tells the model to ask in its reply", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Accept this change for the rest of this session?",
        options: [
          { label: "Accept for this session" },
          { label: "Do not accept" },
        ],
      },
      mockContext,
    );
    expect(result.isError).toBe(true);
    const text = (result.content[0] as any).text;
    expect(text).toContain("Ask the question in your reply instead");
    expect(text).not.toContain("Do not ask this as a plain-text");
  });

  test("ask_user tells the model to use the client's own question tool when the client cannot show the form", async () => {
    mockContext = {
      ...mockContext,
      elicitation: { elicit: async () => ({ status: "no_viewer" as const }) },
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Accept this change for the rest of this session?",
        options: [
          { label: "Accept for this session" },
          { label: "Do not accept" },
        ],
      },
      mockContext,
    );
    expect(result.isError).toBe(true);
    const text = (result.content[0] as any).text;
    expect(text).toContain("This client did not answer the choice form");
    expect(text).toContain("Do not ask this as a plain-text chat question");
  });

  test("ask_user does not attribute an automatic client decline to the user", async () => {
    mockContext = {
      ...mockContext,
      elicitation: {
        elicit: async () => ({
          status: "answered" as const,
          result: {
            action: "decline" as const,
            _meta: { approvals_reviewer: "auto_review" },
          },
        }),
      },
    };
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Which option?",
        options: [{ label: "One" }, { label: "Two" }],
      },
      mockContext,
    );
    expect(result.isError).toBe(true);
    const text = (result.content[0] as any).text as string;
    expect(text).toContain("This client did not answer the choice form");
    expect(text).not.toContain("The user declined");
  });

  test("ask_user returns the selected option after elicitation", async () => {
    mockContext = {
      ...mockContext,
      elicitation: {
        elicit: async () => ({
          status: "answered" as const,
          result: {
            action: "accept" as const,
            content: { choice: "Accept for this session" },
          },
        }),
      },
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Accept this change for the rest of this session?",
        options: [
          { label: "Accept for this session" },
          { label: "Do not accept" },
        ],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      action: "accept",
      selected: ["Accept for this session"],
    });
  });

  test("ask_user rejects duplicate option labels", async () => {
    mockContext = {
      ...mockContext,
      elicitation: {
        elicit: async () => ({
          status: "answered" as const,
          result: { action: "accept" as const, content: { choice: "A" } },
        }),
      },
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Pick one",
        options: [{ label: "A" }, { label: "A" }],
      },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Give each option a different label",
    );
  });

  test("ask_user maps multi-choice option_N keys to labels", async () => {
    mockContext = {
      ...mockContext,
      elicitation: {
        elicit: async () => ({
          status: "answered" as const,
          result: {
            action: "accept" as const,
            content: { option_0: true, option_1: false, option_2: true },
          },
        }),
      },
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Pick any",
        allowMultiple: true,
        options: [
          { label: "Accept for this session" },
          { label: "Do not accept" },
          { label: "Ask later" },
        ],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      action: "accept",
      selected: ["Accept for this session", "Ask later"],
    });
  });

  test("ask_user passes its trimmed header and the calling tool call to the question", async () => {
    const asked: unknown[] = [];
    mockContext = {
      ...mockContext,
      currentToolCallId: "call_visibility",
      elicitation: {
        elicit: async (params) => {
          asked.push(params);
          return acceptingElicitation.elicit();
        },
      },
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Who can see this app?",
        header: "  Visibility ",
        options: [
          { label: "Accept for this session" },
          { label: "Do not accept" },
        ],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect(asked).toEqual([
      expect.objectContaining({
        message: "Who can see this app?",
        header: "Visibility",
        toolCallId: "call_visibility",
      }),
    ]);
  });

  test("ask_user rejects a header too long for a tab", async () => {
    mockContext = { ...mockContext, elicitation: acceptingElicitation };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Who can see this app?",
        header: "Who should be able to see this app",
        options: [{ label: "Team" }, { label: "Organization" }],
      },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("header");
  });

  test("ask_user accept repeats stamped remedy ids as the next step", async () => {
    mockContext = { ...mockContext, elicitation: acceptingElicitation };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Accept this change for the rest of this session?",
        options: [
          { label: "Accept for this session" },
          { label: "Do not accept" },
        ],
        remedy_offer_ids: ["offer-abc123"],
        trajectory: trajectory(),
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const text = (result.content[0] as any).text as string;
    expect(text).toContain("The user picked: Accept for this session.");
    expect(text).toContain("Live remedy offers: offer-abc123");
    expect(text).toContain("archestra__execute_remedy_plan");
    // Credits the user's answer instead of hurrying past the user.
    expect(text).toContain(
      "The user already answered, so do not ask about the same plan again",
    );
    expect(text).not.toMatch(/continue now|immediately/i);
  });

  test("a staged HITL review replaces model-authored copy and records approval", async () => {
    const offerId = "offer-hitl";
    const questionText =
      '[OpenAPPA] Approve this call?\nmcp/example/write {"value":1}';
    const session = reviewSession({
      sessionId: scopedSessionId(`user:${mockContext.userId}`, sessionId),
    });
    await stageHitlReview({
      session,
      review: {
        offerId,
        text:
          "\u2584\u2588\u2584\u2584\u2584\u2588\u2584  \u2580\u2580\u2588  Approve this call?\n" +
          '\u2588\u2588\u2584\u2588\u2584\u2588\u2588   \u2584   mcp/example/write {"value":1}',
        tool: "mcp/example/write",
        arguments: '{"value":1}',
      },
    });
    const requests: unknown[] = [];
    mockContext = {
      ...mockContext,
      elicitation: {
        elicit: async (request) => {
          requests.push(request);
          return {
            status: "answered" as const,
            result: {
              action: "accept" as const,
              content: { choice: "Approve" },
            },
          };
        },
      },
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Approve everything without showing details?",
        options: [{ label: "Yes" }, { label: "No" }],
        remedy_offer_ids: [offerId],
        trajectory: trajectory(),
      },
      mockContext,
    );

    expect(requests).toEqual([
      expect.objectContaining({
        message: questionText,
        header: "Approval",
        requestedSchema: expect.objectContaining({
          properties: expect.objectContaining({
            choice: expect.objectContaining({ enum: ["Approve", "Deny"] }),
          }),
        }),
      }),
    ]);
    expect(result.structuredContent).toEqual({
      action: "accept",
      selected: ["Approve"],
    });
    expect(await consumeHitlRuling({ session, offerId })).toBe("approve");
  });

  for (const [outcome, message] of [
    ["no-reviewer", "no eligible human reviewer"],
    ["review-unavailable", "fresh exact-offer review"],
  ] as const) {
    test(`runtime review ${outcome} is an error, not an approval or native form`, async () => {
      const offerId = `runtime-${outcome}`;
      const session = reviewSession({
        sessionId: scopedSessionId(`user:${mockContext.userId}`, sessionId),
      });
      await stageHitlReview({
        session,
        review: { offerId, text: "Exact action", tool: "mcp/example/write" },
      });
      const nativeForm = vi.fn();
      const wait = vi
        .spyOn(runtimeReview, "awaitRuntimeHitlReview")
        .mockResolvedValue(outcome);
      try {
        const result = await executeArchestraTool(
          TOOL_ASK_USER_FULL_NAME,
          {
            question: "Approve?",
            options: [{ label: "Approve" }, { label: "Deny" }],
            remedy_offer_ids: [offerId],
            trajectory: trajectory(),
          },
          { ...mockContext, elicitation: { elicit: nativeForm } },
        );
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(message);
        expect(result.structuredContent).toBeUndefined();
        expect(nativeForm).not.toHaveBeenCalled();
        expect(await consumeHitlRuling({ session, offerId })).toBeUndefined();
      } finally {
        wait.mockRestore();
      }
    });
  }

  test("a runtime review waits on the platform instead of an auto-declining native form", async () => {
    const offerId = "runtime-review";
    const session = reviewSession({
      sessionId: scopedSessionId(`user:${mockContext.userId}`, sessionId),
    });
    await stageHitlReview({
      session,
      review: {
        offerId,
        text: "Exact runtime action",
        tool: "mcp/example/write",
        arguments: '{"value":1}',
      },
    });
    const nativeForm = vi.fn(async () => ({
      status: "answered" as const,
      result: { action: "decline" as const },
    }));
    const wait = vi
      .spyOn(runtimeReview, "awaitRuntimeHitlReview")
      .mockResolvedValue("approve");
    try {
      const answer = await executeArchestraTool(
        TOOL_ASK_USER_FULL_NAME,
        {
          question: "Approve?",
          options: [{ label: "Approve" }, { label: "Deny" }],
          remedy_offer_ids: [offerId],
          trajectory: trajectory(),
        },
        { ...mockContext, elicitation: { elicit: nativeForm } },
      );
      expect(answer.structuredContent).toEqual({
        action: "accept",
        selected: ["Approve"],
      });
      expect(nativeForm).not.toHaveBeenCalled();
      expect(wait).toHaveBeenCalledWith(
        expect.objectContaining({ offerId, userId: mockContext.userId }),
      );
      expect(await consumeHitlRuling({ session, offerId })).toBeUndefined();
    } finally {
      wait.mockRestore();
    }
  });

  test.each([
    "missing",
    "parent",
    "raw parent",
  ])("a child review is decided under its stamped scope when the gateway session is %s", async (gatewaySession) => {
    const offerId = "offer-child-review";
    const parentId = `user:${mockContext.userId}|parent-session`;
    const session: OpenAppaSession = {
      organization_id: mockContext.organizationId as string,
      caller_id: `user:${mockContext.userId}`,
      session_id: `${parentId}:child-agent`,
      parent_id: parentId,
    };
    await stageHitlReview({
      session,
      review: { offerId, text: "Approve this child's exact call?" },
    });
    const requests: string[] = [];
    mockContext = {
      ...mockContext,
      sessionId: undefined,
      openappaSession:
        gatewaySession === "missing"
          ? undefined
          : {
              ...session,
              session_id:
                gatewaySession === "raw parent" ? "parent-session" : parentId,
              parent_id: undefined,
            },
      elicitation: {
        elicit: async ({ message }) => {
          requests.push(message);
          return {
            status: "answered" as const,
            result: {
              action: "accept" as const,
              content: { choice: "Approve" },
            },
          };
        },
      },
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Approve something else?",
        options: [{ label: "Approve" }, { label: "Deny" }],
        remedy_offer_ids: [offerId],
        trajectory: trajectory({
          sessionId: session.session_id,
          parentId,
        }),
      },
      mockContext,
    );

    expect(result.structuredContent).toEqual({
      action: "accept",
      selected: ["Approve"],
    });
    expect(requests).toEqual(["Approve this child's exact call?"]);
    expect(await consumeHitlRuling({ session, offerId })).toBe("approve");
    expect(
      await consumeHitlRuling({
        session: { ...session, session_id: parentId, parent_id: undefined },
        offerId,
      }),
    ).toBeUndefined();
  });

  test.each([
    "user:other-account",
    "virtual-key:vk-1",
    "app:app-1",
  ])("a headerless gateway decides a review on the same %s trajectory", async (callerId) => {
    const offerId = "offer-shared";
    const session = reviewSession({
      sessionId: scopedSessionId(callerId, "client-session"),
      callerId,
    });
    await stageHitlReview({
      session,
      review: { offerId, text: "Canonical review for another account." },
    });
    const requests: string[] = [];
    mockContext = {
      ...mockContext,
      sessionId: undefined,
      openappaSession: undefined,
      elicitation: {
        elicit: async ({ message }) => {
          requests.push(message);
          return {
            status: "answered" as const,
            result: {
              action: "accept" as const,
              content: { choice: "Approve" },
            },
          };
        },
      },
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Approve something else?",
        options: [{ label: "Yes" }, { label: "No" }],
        remedy_offer_ids: [offerId],
        trajectory: trajectory({ sessionId: session.session_id }),
      },
      mockContext,
    );

    expect(result.structuredContent).toEqual({
      action: "accept",
      selected: ["Approve"],
    });
    expect(requests).toEqual(["Canonical review for another account."]);
    expect(await consumeHitlRuling({ session, offerId })).toBe("approve");
  });

  test("a wrong trajectory does not consume a pending review", async () => {
    const offerId = "offer-wrong-trajectory";
    const session = reviewSession({
      sessionId: scopedSessionId("virtual-key:vk-1", "client-session"),
      callerId: "virtual-key:vk-1",
    });
    await stageHitlReview({
      session,
      review: { offerId, text: "Do not route this review." },
    });
    await recordHitlRuling({ session, offerId, ruling: "approve" });
    const requests: string[] = [];
    mockContext = {
      ...mockContext,
      sessionId: undefined,
      openappaSession: undefined,
      elicitation: {
        elicit: async ({ message }) => {
          requests.push(message);
          return {
            status: "answered" as const,
            result: { action: "decline" as const },
          };
        },
      },
    };

    await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Ordinary question?",
        options: [{ label: "Yes" }, { label: "No" }],
        remedy_offer_ids: [offerId],
        trajectory: trajectory({ sessionId: "other-session" }),
      },
      mockContext,
    );

    expect(requests).toEqual(["Ordinary question?"]);
    expect(await consumeHitlRuling({ session, offerId })).toBe("approve");
  });

  test.each([
    "matching root",
    "foreign conversation",
    "child",
  ] as const)("ask_user recovers an unprefixed Chat caller only for a %s", async (caseName) => {
    const offerId = "chat-caller-review";
    const parentId = caseName === "child" ? "parent-session" : undefined;
    const session = reviewSession({
      sessionId,
      callerId: `user:${mockContext.userId}`,
      parentId,
    });
    await stageHitlReview({
      session,
      review: { offerId, text: "Exact Chat review." },
    });
    const requests: string[] = [];
    mockContext = {
      ...mockContext,
      conversationId:
        caseName === "foreign conversation" ? "other-conversation" : sessionId,
      elicitation: {
        elicit: async ({ message }) => {
          requests.push(message);
          return {
            status: "answered" as const,
            result: {
              action: "accept" as const,
              content: {
                choice: caseName === "matching root" ? "Approve" : "Yes",
              },
            },
          };
        },
      },
    };
    await executeArchestraTool(
      TOOL_ASK_USER_FULL_NAME,
      {
        question: "Ordinary question?",
        options: [{ label: "Yes" }, { label: "No" }],
        remedy_offer_ids: [offerId],
        trajectory: trajectory({ sessionId, parentId }),
      },
      mockContext,
    );
    expect(requests).toEqual([
      caseName === "matching root"
        ? "Exact Chat review."
        : "Ordinary question?",
    ]);
    expect(await consumeHitlRuling({ session, offerId })).toBe(
      caseName === "matching root" ? "approve" : undefined,
    );
  });

  test.each([
    "missing",
    "malformed",
  ])("a %s trajectory does not consume a pending review", async (stamp) => {
    const offerId = "offer-unstamped";
    const session = reviewSession({
      sessionId: scopedSessionId(`user:${mockContext.userId}`, sessionId),
    });
    await stageHitlReview({
      session,
      review: { offerId, text: "Do not route this review." },
    });
    await recordHitlRuling({ session, offerId, ruling: "approve" });
    mockContext = {
      ...mockContext,
      elicitation: {
        elicit: async () => ({
          status: "answered" as const,
          result: { action: "decline" as const },
        }),
      },
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Ordinary question?",
        options: [{ label: "Yes" }, { label: "No" }],
        remedy_offer_ids: [offerId],
        ...(stamp === "malformed"
          ? { trajectory: { v: 2, session_id: session.session_id } }
          : {}),
      },
      mockContext,
    );

    if (stamp === "malformed") {
      expect(result.isError).toBe(true);
    }
    expect(await consumeHitlRuling({ session, offerId })).toBe("approve");
  });

  test("a staged HITL review without a viewer fails closed", async () => {
    const offerId = "offer-no-viewer";
    const session = reviewSession({
      sessionId: scopedSessionId(`user:${mockContext.userId}`, sessionId),
    });
    await stageHitlReview({
      session,
      review: { offerId, text: "Review this exact call." },
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "May I ask you to approve this?",
        options: [{ label: "Yes" }, { label: "No" }],
        remedy_offer_ids: [offerId],
        trajectory: trajectory(),
      },
      mockContext,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as any).text as string;
    expect(text).toContain("cannot show the HITL review");
    expect(text).toContain("Do not ask for approval in plain text");
    expect(text).toContain("do not retry it");
  });

  test("automatic client decline cannot be recorded as a human HITL denial", async () => {
    const offerId = "offer-auto-decline";
    const session = reviewSession({
      sessionId: scopedSessionId(`user:${mockContext.userId}`, sessionId),
    });
    await stageHitlReview({
      session,
      review: { offerId, text: "Review this exact call." },
    });
    mockContext = {
      ...mockContext,
      elicitation: {
        elicit: async () => ({
          status: "answered" as const,
          result: {
            action: "decline" as const,
            _meta: { approvals_reviewer: "auto_review" },
          },
        }),
      },
    };
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Approve this?",
        options: [{ label: "Yes" }, { label: "No" }],
        remedy_offer_ids: [offerId],
        trajectory: trajectory(),
      },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "cannot show the HITL review",
    );
    expect(await consumeHitlRuling({ session, offerId })).toBeUndefined();
  });

  test("a late form answer cannot approve a review whose stage was cleared", async () => {
    const offerId = "late-answer";
    const session = reviewSession({
      sessionId: scopedSessionId(`user:${mockContext.userId}`, sessionId),
    });
    await stageHitlReview({
      session,
      review: { offerId, text: "Review this exact call." },
    });
    mockContext = {
      ...mockContext,
      elicitation: {
        elicit: async () => {
          await clearHitlReview({ session, offerId });
          return {
            status: "answered" as const,
            result: {
              action: "accept" as const,
              content: { choice: "Approve" },
            },
          };
        },
      },
    };
    const result = await executeArchestraTool(
      TOOL_ASK_USER_FULL_NAME,
      {
        question: "Approve?",
        options: [{ label: "Approve" }, { label: "Deny" }],
        remedy_offer_ids: [offerId],
        trajectory: trajectory(),
      },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No ruling was recorded");
    expect(await consumeHitlRuling({ session, offerId })).toBeUndefined();
  });

  test("parallel decisions keep accepted and declined offers separate", async () => {
    mockContext = {
      ...mockContext,
      elicitation: {
        elicit: async (request) =>
          request.message.includes("first")
            ? {
                status: "answered" as const,
                result: {
                  action: "accept" as const,
                  content: { choice: "Yes" },
                },
              }
            : {
                status: "answered" as const,
                result: { action: "decline" as const },
              },
      },
    };
    const ask = (question: string, offerId: string) =>
      executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
        {
          question,
          options: [{ label: "Yes" }, { label: "No" }],
          remedy_offer_ids: [offerId],
          trajectory: trajectory(),
        },
        mockContext,
      );

    const [accepted, declined] = await Promise.all([
      ask("Accept the first remedy?", "offer-first"),
      ask("Accept the second remedy?", "offer-second"),
    ]);
    const acceptedText = (accepted.content[0] as any).text as string;
    const declinedText = (declined.content[0] as any).text as string;
    expect(acceptedText).toContain("Live remedy offers: offer-first");
    expect(acceptedText).not.toContain("offer-second");
    expect(declinedText).not.toContain("Live remedy offers");
    expect(declinedText).not.toContain("offer-first");
  });

  test("ask_user does not treat remedy ids as live without a trajectory", async () => {
    mockContext = { ...mockContext, elicitation: acceptingElicitation };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Accept this change for the rest of this session?",
        options: [
          { label: "Accept for this session" },
          { label: "Do not accept" },
        ],
        remedy_offer_ids: ["offer-dropped"],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    const text = (result.content[0] as any).text as string;
    expect(text).toContain("The user picked: Accept for this session.");
    expect(text).not.toContain("Live remedy offers");
  });

  test("ask_user keeps a workload trajectory only for that workspace principal", async () => {
    const workspaceId = "44444444-4444-4444-8444-444444444444";
    const principal = workloadPrincipal(workspaceId);
    const session = `${principal}|workspace-a`;
    mockContext = {
      agent: mockContext.agent,
      organizationId: mockContext.organizationId,
      openappaSession: {
        organization_id: mockContext.organizationId as string,
        caller_id: principal,
        session_id: session,
      },
      elicitation: acceptingElicitation,
    };

    const accepted = await executeArchestraTool(
      TOOL_ASK_USER_FULL_NAME,
      {
        question: "Accept this change for the rest of this session?",
        options: [
          { label: "Accept for this session" },
          { label: "Do not accept" },
        ],
        remedy_offer_ids: ["offer-owned"],
        trajectory: trajectory({ sessionId: session }),
      },
      mockContext,
    );
    expect((accepted.content[0] as any).text).toContain("offer-owned");

    const dropped = await executeArchestraTool(
      TOOL_ASK_USER_FULL_NAME,
      {
        question: "Accept this change for the rest of this session?",
        options: [
          { label: "Accept for this session" },
          { label: "Do not accept" },
        ],
        remedy_offer_ids: ["offer-sibling"],
        trajectory: trajectory({
          sessionId: scopedSessionId(
            workloadPrincipal("55555555-5555-4555-8555-555555555555"),
            "workspace-b",
          ),
        }),
      },
      mockContext,
    );
    expect((dropped.content[0] as any).text).not.toContain("offer-sibling");
  });

  test("ask_user ignores legacy offer routing and uses the current trajectory", async () => {
    mockContext = { ...mockContext, elicitation: acceptingElicitation };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Accept this change for the rest of this session?",
        options: [
          { label: "Accept for this session" },
          { label: "Do not accept" },
        ],
        remedy_offer_ids: ["offer-live"],
        trajectory: trajectory(),
        remedy_offers: [
          { offer_id: "offer-replayed", session_id: "another-conversation" },
        ],
      },
      mockContext,
    );

    const text = (result.content[0] as any).text as string;
    expect(text).toContain("Live remedy offers: offer-live.");
    expect(text).not.toContain("offer-replayed");
  });

  test("ask_user uses the stamped gateway trajectory rather than Chat history offers", async () => {
    const gatewaySession = `user:${mockContext.userId}|client-session`;
    mockContext = {
      ...mockContext,
      sessionId: undefined,
      openappaSession: {
        organization_id: mockContext.organizationId as string,
        caller_id: `user:${mockContext.userId}`,
        session_id: gatewaySession,
      },
      elicitation: acceptingElicitation,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Accept this change for the rest of this session?",
        options: [
          { label: "Accept for this session" },
          { label: "Do not accept" },
        ],
        remedy_offer_ids: ["offer-gateway"],
        trajectory: trajectory({ sessionId: gatewaySession }),
        remedy_offers: [{ offer_id: "offer-chat" }],
      },
      mockContext,
    );

    const text = (result.content[0] as any).text as string;
    expect(text).toContain("Live remedy offers: offer-gateway.");
    expect(text).not.toContain("offer-chat");
  });

  test.each([
    "decline",
    "cancel",
  ] as const)("ask_user %s with live offers closes the decision", async (action) => {
    mockContext = {
      ...mockContext,
      elicitation: {
        elicit: async () => ({
          status: "answered" as const,
          result: { action },
        }),
      },
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Accept this change for the rest of this session?",
        options: [
          { label: "Accept for this session" },
          { label: "Do not accept" },
        ],
        remedy_offer_ids: ["offer-decline"],
        trajectory: trajectory(),
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ action, selected: [] });
    expect((result.content[0] as any).text).toContain(
      "If this question offered the remedy, the user did not accept it: do not retry the blocked call and do not ask again.",
    );
    expect((result.content[0] as any).text).toContain(
      "Do not ask again, offer the same options in prose, or end with a follow-up question or invitation.",
    );
    expect((result.content[0] as any).text).not.toContain(
      "Live remedy offers:",
    );
  });

  test("ask_user treats a question nobody answered in time as not accepted", async () => {
    mockContext = {
      ...mockContext,
      elicitation: {
        elicit: async () => ({ status: "unanswered" as const }),
      },
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Accept this change for the rest of this session?",
        options: [
          { label: "Accept for this session" },
          { label: "Do not accept" },
        ],
        remedy_offer_ids: ["offer-unanswered"],
        trajectory: trajectory(),
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      action: "cancel",
      selected: [],
      timedOut: true,
    });
    const text = (result.content[0] as any).text;
    expect(text).toContain("The user did not answer the question in time.");
    expect(text).toContain(
      "If this question offered the remedy, the user did not accept it: do not retry the blocked call and do not ask again.",
    );
  });

  test.each([
    "decline",
    "cancel",
  ] as const)("ask_user %s closes a question without remedy offers", async (action) => {
    mockContext = {
      ...mockContext,
      elicitation: {
        elicit: async () => ({
          status: "answered" as const,
          result: { action },
        }),
      },
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Accept this change for the rest of this session?",
        options: [
          { label: "Accept for this session" },
          { label: "Do not accept" },
        ],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      action,
      selected: [],
    });
    expect((result.content[0] as any).text).toContain(
      "Do not ask again, offer the same options in prose, or end with a follow-up question or invitation.",
    );
    expect((result.content[0] as any).text).not.toContain(
      "Live remedy offers:",
    );
  });
});
