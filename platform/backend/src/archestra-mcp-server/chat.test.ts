// biome-ignore-all lint/suspicious/noExplicitAny: test

import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_ASK_USER_FULL_NAME,
} from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import { consumeHitlRuling, stageHitlReview } from "@/openappa/hitl-review";
import { signOfferClaims, unsignedOfferClaims } from "@/openappa/offer-claims";
import * as openappaService from "@/openappa/service";
import { chatOpenAppaSession, type OpenAppaSession } from "@/openappa/service";
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
  // OpenAPPA session the proxy signs their remedy offers for.
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

  // A remedy offer as the proxy signs it for this test's Chat session.
  function sessionOffer(
    offerId: string,
    overrides: {
      sessionId?: string;
      parentId?: string;
      callerId?: string | null;
      secret?: string;
    } = {},
  ) {
    return signOfferClaims(
      unsignedOfferClaims({
        organizationId: mockContext.organizationId as string,
        sessionId: overrides.sessionId ?? sessionId,
        parentId: overrides.parentId,
        callerId:
          overrides.callerId === null
            ? undefined
            : (overrides.callerId ?? `user:${mockContext.userId}`),
        offerId,
        tool: "archestra__list_skills",
        spelling: "list_skills",
      }),
      overrides.secret ?? config.openappa.offerSigningSecret,
    );
  }

  test("ask_user advertises offer IDs but not proxy-stamped envelopes", () => {
    const tool = getArchestraMcpTools().find(
      (candidate) => candidate.name === TOOL_ASK_USER_FULL_NAME,
    );
    const properties = tool?.inputSchema.properties;
    expect(properties).toHaveProperty("remedy_offer_ids");
    expect(properties).not.toHaveProperty("remedy_offers");
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

  test("ask_user accept repeats verified live offers as the next step", async () => {
    const envelope = sessionOffer("offer-abc123");
    mockContext = { ...mockContext, elicitation: acceptingElicitation };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Accept this change for the rest of this session?",
        options: [
          { label: "Accept for this session" },
          { label: "Do not accept" },
        ],
        remedy_offers: [envelope],
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
    const session = chatOpenAppaSession(
      mockContext.organizationId as string,
      mockContext.userId as string,
      sessionId,
    );
    await stageHitlReview({
      session,
      review: {
        offerId,
        text: "Canonical review text.",
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
        remedy_offers: [sessionOffer(offerId)],
      },
      mockContext,
    );

    expect(requests).toEqual([
      expect.objectContaining({
        message: "Canonical review text.",
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

  test("an unstaged verified offer shows the loaded review and records approval", async () => {
    const offerId = "offer-ask-first";
    const session = chatOpenAppaSession(
      mockContext.organizationId as string,
      mockContext.userId as string,
      sessionId,
    );
    const load = vi
      .spyOn(openappaService, "loadOfferReview")
      .mockResolvedValue({
        offer_id: offerId,
        text: "Approve this exact call?",
        session_id: sessionId,
        tool: "qa-replay__qa_read_internal",
        arguments: "{}",
        restrictions: [
          { dimension: "trust", before: "trusted", after: "suspicious" },
          { dimension: "readers", before: "public", after: "internal" },
        ],
      });
    const requests: string[] = [];
    mockContext = {
      ...mockContext,
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

    try {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
        {
          question: "Approve everything without showing details?",
          options: [{ label: "Yes" }, { label: "No" }],
          remedy_offer_ids: [offerId],
          remedy_offers: [sessionOffer(offerId)],
        },
        mockContext,
      );
      expect(result.isError).not.toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("trust: trusted -> suspicious");
      expect(requests[0]).toContain("readers: public -> internal");
      expect(requests[0]).not.toContain("Approve everything");
      expect(result.structuredContent).toEqual({
        action: "accept",
        selected: ["Approve"],
      });
      expect(await consumeHitlRuling({ session, offerId })).toBe("approve");
    } finally {
      load.mockRestore();
    }
  });

  test("a signed offer with no loaded review does not record the model question", async () => {
    const offerId = "offer-unloaded";
    const session = chatOpenAppaSession(
      mockContext.organizationId as string,
      mockContext.userId as string,
      sessionId,
    );
    const load = vi
      .spyOn(openappaService, "loadOfferReview")
      .mockResolvedValue(null);
    const requests: string[] = [];
    mockContext = {
      ...mockContext,
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

    try {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
        {
          question: "Approve everything without showing details?",
          options: [{ label: "Approve" }, { label: "Deny" }],
          remedy_offer_ids: [offerId],
          remedy_offers: [sessionOffer(offerId)],
        },
        mockContext,
      );
      expect(requests).toEqual(["Approve everything without showing details?"]);
      expect(result.structuredContent).toEqual({
        action: "accept",
        selected: ["Approve"],
      });
      expect(await consumeHitlRuling({ session, offerId })).toBeUndefined();
    } finally {
      load.mockRestore();
    }
  });

  test("an incomplete loaded restriction list is not shown as the model question", async () => {
    const offerId = "offer-bad-restrictions";
    const load = vi
      .spyOn(openappaService, "loadOfferReview")
      .mockResolvedValue({
        offer_id: offerId,
        text: "Approve this call?",
        session_id: sessionId,
        restrictions: [
          { dimension: "unknown", before: "trusted", after: "suspicious" },
        ],
      });
    const requests: string[] = [];
    mockContext = {
      ...mockContext,
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

    try {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
        {
          question: "Approve everything without showing details?",
          options: [{ label: "Yes" }, { label: "No" }],
          remedy_offer_ids: [offerId],
          remedy_offers: [sessionOffer(offerId)],
        },
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        "The approval review cannot be shown",
      );
      expect(requests).toEqual([]);
    } finally {
      load.mockRestore();
    }
  });

  test.each([
    "missing",
    "parent",
    "raw parent",
  ])("a child review is decided under its signed scope when the gateway session is %s", async (gatewaySession) => {
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
        remedy_offers: [
          sessionOffer(offerId, {
            sessionId: session.session_id,
            parentId,
          }),
        ],
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

  test("a headerless gateway shows this user's signed root review, not the model question", async () => {
    const offerId = "offer-root";
    const session: OpenAppaSession = {
      organization_id: mockContext.organizationId as string,
      caller_id: `user:${mockContext.userId}`,
      session_id: `user:${mockContext.userId}|root-session`,
    };
    await stageHitlReview({
      session,
      review: { offerId, text: "Approve this exact call?" },
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
            result: { action: "decline" as const },
          };
        },
      },
    };

    await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Approve this exact internal read?",
        options: [{ label: "Approve" }, { label: "Deny" }],
        remedy_offer_ids: [offerId],
        remedy_offers: [
          sessionOffer(offerId, { sessionId: session.session_id }),
        ],
      },
      mockContext,
    );
    expect(requests).toEqual(["Approve this exact call?"]);
    expect(await consumeHitlRuling({ session, offerId })).toBe("deny");
  });

  test("a headerless root offer loads the native review before any remedy execution", async () => {
    const offerId = "offer-headerless-load";
    const runtimeSession = `user:${mockContext.userId}|headerless-root`;
    const load = vi
      .spyOn(openappaService, "loadOfferReview")
      .mockResolvedValue({
        offer_id: offerId,
        text: "Approve this call?\nmcp/qa-replay/qa_read_internal {}",
        session_id: runtimeSession,
        tool: "qa-replay__qa_read_internal",
        arguments: "{}",
        restrictions: [
          { dimension: "trust", before: "trusted", after: "suspicious" },
          { dimension: "readers", before: "public", after: "internal" },
        ],
      });
    const requests: string[] = [];
    mockContext = {
      ...mockContext,
      sessionId: undefined,
      openappaSession: undefined,
      elicitation: {
        elicit: async ({ message }) => {
          requests.push(message);
          throw new Error(
            "Synthetic protocol test stops before any human answer.",
          );
        },
      },
    };

    try {
      await expect(
        executeArchestraTool(
          `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
          {
            question: "Approve this exact internal read?",
            options: [{ label: "Approve" }, { label: "Deny" }],
            remedy_offer_ids: [offerId],
            remedy_offers: [
              sessionOffer(offerId, { sessionId: runtimeSession }),
            ],
          },
          mockContext,
        ),
      ).rejects.toThrow("stops before any human answer");
      expect(load).toHaveBeenCalledWith({
        organizationId: mockContext.organizationId,
        sessionId: runtimeSession,
        offerId,
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("trusted -> suspicious");
      expect(requests[0]).toContain("public -> internal");
      expect(requests[0]).toContain("mcp/qa-replay/qa_read_internal");
      expect(requests[0]).not.toContain("Approve this exact internal read?");
      expect(
        await consumeHitlRuling({
          session: {
            organization_id: mockContext.organizationId as string,
            caller_id: `user:${mockContext.userId}`,
            session_id: runtimeSession,
          },
          offerId,
        }),
      ).toBeUndefined();
    } finally {
      load.mockRestore();
    }
  });

  test("a headerless gateway does not accept an unrelated other owner's child offer", async () => {
    const offerId = "offer-unrelated";
    const parentId = `user:${mockContext.userId}|parent-session`;
    const callerId = "service:other-owner";
    const session: OpenAppaSession = {
      organization_id: mockContext.organizationId as string,
      caller_id: callerId,
      session_id: `${parentId}:child-agent`,
      parent_id: parentId,
    };
    await stageHitlReview({
      session,
      review: { offerId, text: "Do not route this review." },
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
        remedy_offers: [
          sessionOffer(offerId, {
            sessionId: session.session_id,
            parentId: session.parent_id,
            callerId,
          }),
        ],
      },
      mockContext,
    );
    expect(requests).toEqual(["Ordinary question?"]);
    expect(await consumeHitlRuling({ session, offerId })).toBeUndefined();
  });

  test.each([
    "mixed child scopes",
    "mismatched declared ID",
  ])("a %s cannot route a review to the wrong child", async (caseName) => {
    const offerId = "offer-child-one";
    const parentId = `user:${mockContext.userId}|parent-session`;
    const session: OpenAppaSession = {
      organization_id: mockContext.organizationId as string,
      caller_id: `user:${mockContext.userId}`,
      session_id: `${parentId}:child-one`,
      parent_id: parentId,
    };
    await stageHitlReview({
      session,
      review: { offerId, text: "Do not route this review." },
    });
    const requests: string[] = [];
    mockContext = {
      ...mockContext,
      openappaSession: {
        ...session,
        session_id: parentId,
        parent_id: undefined,
      },
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
        remedy_offer_ids: [
          caseName === "mixed child scopes" ? offerId : "offer-child-two",
        ],
        remedy_offers: [
          sessionOffer(offerId, {
            sessionId: session.session_id,
            parentId,
          }),
          ...(caseName === "mixed child scopes"
            ? [
                sessionOffer("offer-child-two", {
                  sessionId: `${parentId}:child-two`,
                  parentId,
                }),
              ]
            : []),
        ],
      },
      mockContext,
    );
    expect(requests).toEqual(["Ordinary question?"]);
    expect(await consumeHitlRuling({ session, offerId })).toBeUndefined();
  });

  test("a staged HITL review without a viewer fails closed", async () => {
    const offerId = "offer-no-viewer";
    const session = chatOpenAppaSession(
      mockContext.organizationId as string,
      mockContext.userId as string,
      sessionId,
    );
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
        remedy_offers: [sessionOffer(offerId)],
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
    const session = chatOpenAppaSession(
      mockContext.organizationId as string,
      mockContext.userId as string,
      sessionId,
    );
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
        remedy_offers: [sessionOffer(offerId)],
      },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "cannot show the HITL review",
    );
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
          remedy_offers: [sessionOffer(offerId)],
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

  test.each([
    {
      case: "signed with the wrong secret",
      overrides: { secret: "not-the-configured-offer-secret-32-chars-min!" },
    },
    {
      // e.g. replayed into this conversation from another one's history
      case: "minted for another session",
      overrides: { sessionId: "another-conversation" },
    },
    {
      case: "minted for another user",
      overrides: { callerId: "user:someone-else" },
    },
    {
      case: "minted for an app caller",
      overrides: { callerId: "app:someone-else" },
    },
    {
      case: "minted for a virtual-key caller",
      overrides: { callerId: "virtual-key:someone-else" },
    },
    {
      case: "minted with no owner",
      overrides: { callerId: null },
    },
  ])("ask_user drops an offer $case", async ({ overrides }) => {
    mockContext = { ...mockContext, elicitation: acceptingElicitation };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Accept this change for the rest of this session?",
        options: [
          { label: "Accept for this session" },
          { label: "Do not accept" },
        ],
        remedy_offers: [sessionOffer("offer-dropped", overrides)],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    const text = (result.content[0] as any).text as string;
    expect(text).toContain("The user picked: Accept for this session.");
    expect(text).not.toContain("Live remedy offers");
  });

  test("ask_user keeps only this session's offers when replayed ones ride along", async () => {
    mockContext = { ...mockContext, elicitation: acceptingElicitation };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Accept this change for the rest of this session?",
        options: [
          { label: "Accept for this session" },
          { label: "Do not accept" },
        ],
        remedy_offers: [
          sessionOffer("offer-replayed", { sessionId: "another-conversation" }),
          sessionOffer("offer-live"),
        ],
      },
      mockContext,
    );

    const text = (result.content[0] as any).text as string;
    expect(text).toContain("Live remedy offers: offer-live.");
    expect(text).not.toContain("offer-replayed");
  });

  test("ask_user keeps an offer the gateway's header-named session was signed for", async () => {
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
        remedy_offers: [
          sessionOffer("offer-gateway", { sessionId: gatewaySession }),
          // Chat's conversation id is not this call's session here.
          sessionOffer("offer-chat"),
        ],
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
    const envelope = sessionOffer("offer-decline");
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
        remedy_offers: [envelope],
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
    const envelope = sessionOffer("offer-unanswered");
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
        remedy_offers: [envelope],
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
