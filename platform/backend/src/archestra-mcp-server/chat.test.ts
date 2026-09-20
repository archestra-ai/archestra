// biome-ignore-all lint/suspicious/noExplicitAny: test

import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_ASK_USER_FULL_NAME,
} from "@archestra/shared";
import config from "@/config";
import { signOfferClaims, unsignedOfferClaims } from "@/openappa/offer-claims";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import {
  type ArchestraContext,
  executeArchestraTool,
  getArchestraMcpTools,
} from ".";

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
      callerId?: string | null;
      secret?: string;
    } = {},
  ) {
    return signOfferClaims(
      unsignedOfferClaims({
        organizationId: mockContext.organizationId as string,
        sessionId: overrides.sessionId ?? sessionId,
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
    // A2A, ChatOps, schedules and subagents run with no elicitation bridge:
    // nobody sees a form there, so a plain-text question is the only one that
    // reaches the user.
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
    expect(text).toContain("Do not ask the user again");
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
      "Do not ask it again, offer the same options in prose, or end with a follow-up question or invitation.",
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
      "Do not ask it again, offer the same options in prose, or end with a follow-up question or invitation.",
    );
    expect((result.content[0] as any).text).not.toContain(
      "Live remedy offers:",
    );
  });
});
