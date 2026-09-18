// biome-ignore-all lint/suspicious/noExplicitAny: test

import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import { pendingRulings } from "@/openappa/pending-rulings";
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

  test("ask_user accept repeats the pending remedy ruling as the next step", async () => {
    const sessionId = `ask-ruling-${testAgent.id}`;
    pendingRulings.remember({
      organizationId: mockContext.organizationId as string,
      sessionId,
      ruling:
        '[appa] Blocked: this call cannot run yet.\n\nContinue:\n  - Accept this change for the rest of this session:\n    archestra__execute_remedy_plan(offer_id: "abc123", plan: "Accept")',
    });
    mockContext = {
      ...mockContext,
      openappaSession: {
        organization_id: mockContext.organizationId as string,
        session_id: sessionId,
      },
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
    const text = (result.content[0] as any).text as string;
    expect(text).toContain("The user picked: Accept for this session.");
    expect(text).toContain("continue now exactly as the ruling says");
    expect(text).toContain('offer_id: "abc123"');
    // Consume-once: the ruling must not answer a later question.
    const second = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}ask_user`,
      {
        question: "Unrelated question?",
        options: [{ label: "One" }, { label: "Two" }],
      },
      mockContext,
    );
    expect((second.content[0] as any).text).not.toContain("offer_id");
  });

  test("ask_user decline with a pending ruling tells the model to stop", async () => {
    const sessionId = `ask-decline-${testAgent.id}`;
    pendingRulings.remember({
      organizationId: mockContext.organizationId as string,
      sessionId,
      ruling: "[appa] Blocked: this call cannot run yet.",
    });
    mockContext = {
      ...mockContext,
      openappaSession: {
        organization_id: mockContext.organizationId as string,
        session_id: sessionId,
      },
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
    expect((result.content[0] as any).text).toContain(
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
