// biome-ignore-all lint/suspicious/noExplicitAny: test

import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import config from "@/config";
import { signOfferClaims, unsignedOfferClaims } from "@/openappa/offer-claims";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

describe("chat tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    testAgent = await makeAgent({
      name: "Test Agent",
      agentType: "agent",
      organizationId: org.id,
    });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: user.id,
      organizationId: org.id,
    };
  });

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

  test("ask_user returns no-form error when elicitation is unavailable", async () => {
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
    expect((result.content[0] as any).text).toContain(
      "This client did not answer the choice form",
    );
    expect((result.content[0] as any).text).toContain(
      "Do not ask this as a plain-text chat question",
    );
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

  test("ask_user accept repeats verified live offers as the next step", async () => {
    const envelope = signOfferClaims(
      unsignedOfferClaims({
        organizationId: mockContext.organizationId as string,
        sessionId: `ask-ruling-${testAgent.id}`,
        offerId: "offer-abc123",
        tool: "archestra__list_skills",
        spelling: "list_skills",
      }),
      config.openappa.offerSigningSecret,
    );
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

  test("ask_user drops offers signed with the wrong secret", async () => {
    const forged = signOfferClaims(
      unsignedOfferClaims({
        organizationId: mockContext.organizationId as string,
        sessionId: `ask-forged-${testAgent.id}`,
        offerId: "offer-forged",
      }),
      "not-the-configured-offer-secret-32-chars-min!",
    );
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
        remedy_offers: [forged],
      },
      mockContext,
    );
    const text = (result.content[0] as any).text as string;
    expect(text).not.toContain("Live remedy offers");
  });

  test("ask_user decline with live offers tells the model to stop", async () => {
    const envelope = signOfferClaims(
      unsignedOfferClaims({
        organizationId: mockContext.organizationId as string,
        sessionId: `ask-decline-${testAgent.id}`,
        offerId: "offer-decline",
      }),
      config.openappa.offerSigningSecret,
    );
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
    expect((result.content[0] as any).text).toContain(
      "The user did not accept the remedy. Do not retry the blocked call and do not ask again.",
    );
  });

  test("ask_user treats a question nobody answered in time as not accepted", async () => {
    const envelope = signOfferClaims(
      unsignedOfferClaims({
        organizationId: mockContext.organizationId as string,
        sessionId: `ask-unanswered-${testAgent.id}`,
        offerId: "offer-unanswered",
      }),
      config.openappa.offerSigningSecret,
    );
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
    });
    const text = (result.content[0] as any).text;
    expect(text).toContain("The user did not answer the question in time.");
    expect(text).toContain(
      "The user did not accept the remedy. Do not retry the blocked call and do not ask again.",
    );
  });

  test("ask_user returns decline without selected options", async () => {
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
      action: "decline",
      selected: [],
    });
  });
});
