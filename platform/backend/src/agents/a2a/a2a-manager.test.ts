import { vi } from "vitest";
import { A2AContextModel, A2AMessageModel, A2ATaskModel } from "@/models";
import { describe, expect, test } from "@/test";
import { type A2AActor, A2AError, A2AErrorKind } from "./a2a-base";
import {
  buildApprovalDecisionSendMessageRequest,
  extractApprovalRequestsFromSendMessageResult,
} from "./a2a-helper";
import { A2AManager } from "./a2a-manager";
import {
  type A2AArchestraApprovalRequest,
  type A2AArchestraTaskApprovalDecision,
  type A2AProtocolGetTaskRequest,
  type A2AProtocolPart,
  A2AProtocolRole,
  type A2AProtocolSendMessageResponse,
  A2AProtocolTaskState,
} from "./a2a-protocol";

const { executeA2AMessage } = vi.hoisted(() => ({
  executeA2AMessage: vi.fn(),
}));

vi.mock("@/agents/a2a-executor.ts", () => ({
  executeA2AMessage,
}));

const getThrown = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
  } catch (e) {
    return e;
  }

  throw new Error("Expected function to throw");
};

const actor: A2AActor = {
  id: "actor1",
  kind: "user",
  organizationId: "org1",
};

async function sendMessageWithParts(
  manager: A2AManager,
  agentId: string,
  parts: A2AProtocolPart[],
): Promise<A2AProtocolSendMessageResponse> {
  return await manager.sendMessage({
    actor,
    agentId,
    request: {
      message: {
        messageId: crypto.randomUUID(),
        role: A2AProtocolRole.User,
        parts,
      },
      configuration: {},
      metadata: {},
    },
  });
}

async function sendTextMessage(
  manager: A2AManager,
  agentId: string,
  text: string,
): Promise<A2AProtocolSendMessageResponse> {
  return await sendMessageWithParts(manager, agentId, [{ text }]);
}

async function sendApprovalDecisions(
  manager: A2AManager,
  agentId: string,
  taskId: string,
  approvalDecisions: A2AArchestraTaskApprovalDecision[],
): Promise<A2AProtocolSendMessageResponse> {
  return await manager.sendMessage({
    actor,
    agentId,
    request: buildApprovalDecisionSendMessageRequest({
      taskId,
      approvalDecisions,
    }),
  });
}

function mockA2AExecuteMessageWithApprovalRequests(
  messageId: string,
  ids: string[],
) {
  executeA2AMessage.mockReturnValue({
    responseUiMessage: {
      id: messageId,
      role: "assistant",
      parts: ids.map((id) => ({
        type: `tool-tool-${id}`,
        state: "approval-requested",
        approval: {
          id: `approval-${id}`,
        },
        toolCallId: `toolCall-${id}`,
      })),
    },
  });
}

function mockA2AExecuteMessageWithTextAndApprovalRequests(
  messageId: string,
  texts: string[],
  ids: string[],
) {
  executeA2AMessage.mockReturnValue({
    responseUiMessage: {
      id: messageId,
      role: "assistant",
      parts: [
        ...texts.map((text) => ({ type: "text", text })),
        ...ids.map((id) => ({
          type: `tool-tool-${id}`,
          state: "approval-requested",
          approval: {
            id: `approval-${id}`,
          },
          toolCallId: `toolCall-${id}`,
        })),
      ],
    },
  });
}

function getApprovalRequest(
  id: string,
  resolved: boolean = false,
  approved: boolean = false,
): A2AArchestraApprovalRequest {
  return {
    approvalId: `approval-${id}`,
    toolCallId: `toolCall-${id}`,
    toolName: `tool-${id}`,
    approved: approved,
    resolved: resolved,
  };
}

function buildGetTaskRequest(params: {
  taskId: string;
}): A2AProtocolGetTaskRequest {
  return {
    id: params.taskId,
  };
}

describe("A2AManager.sendMessage", () => {
  test("empty message parts", async ({ makeAgent }) => {
    const agent = await makeAgent({ name: "agent1", teams: [] });
    const manager = new A2AManager();
    const prevContextCount = await A2AContextModel.getTotalCount();
    const prevTaskCount = await A2ATaskModel.getTotalCount();
    const prevMessageCount = await A2AMessageModel.getTotalCount();
    const err = await getThrown(async () =>
      sendMessageWithParts(manager, agent.id, []),
    );
    expect(err).toBeInstanceOf(A2AError);
    expect((err as A2AError).kind).toBe(A2AErrorKind.NothingToExecute);
    expect(await A2AContextModel.getTotalCount()).toBe(prevContextCount);
    expect(await A2ATaskModel.getTotalCount()).toBe(prevTaskCount);
    expect(await A2AMessageModel.getTotalCount()).toBe(prevMessageCount);
  });

  test("Text message", async ({ makeAgent }) => {
    const agent = await makeAgent({ name: "agent1", teams: [] });
    const manager = new A2AManager();
    const prevContextCount = await A2AContextModel.getTotalCount();
    const prevTaskCount = await A2ATaskModel.getTotalCount();
    const prevMessageCount = await A2AMessageModel.getTotalCount();
    executeA2AMessage.mockReturnValue({
      responseUiMessage: {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text: "response" }],
      },
      text: "response(text)",
    });

    const response = await sendTextMessage(manager, agent.id, "Hello!");

    if (!response.message) {
      throw new Error("Message should be defined");
    }
    expect(response.message.role).toBe(A2AProtocolRole.Agent);
    expect(response.message.parts).toEqual([{ text: "response" }]);

    const dbMessage = await A2AMessageModel.findById(
      response.message.messageId,
    );
    if (!dbMessage) {
      throw new Error("Message should be stored in the database");
    }
    expect(dbMessage.contextId).toBe(response.message.contextId);
    expect(dbMessage.parts).toEqual(response.message.parts);

    expect(await A2AContextModel.getTotalCount()).toBe(prevContextCount + 1);
    expect(await A2ATaskModel.getTotalCount()).toBe(prevTaskCount);
    expect(await A2AMessageModel.getTotalCount()).toBe(prevMessageCount + 2);
  });

  test("Text message: client messageId equals db messageId", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "agent1", teams: [] });
    const manager = new A2AManager();

    executeA2AMessage.mockReturnValue({
      responseUiMessage: {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text: "response" }],
      },
      text: "response(text)",
    });
    const clientMessageId = crypto.randomUUID();
    const response = await manager.sendMessage({
      actor,
      agentId: agent.id,
      request: {
        message: {
          messageId: clientMessageId,
          role: A2AProtocolRole.User,
          parts: [{ text: "Hello!" }],
        },
      },
    });
    if (!response.message) {
      throw new Error("Message should be defined");
    }
    const clientDbMessage = await A2AMessageModel.findById(clientMessageId);
    if (!clientDbMessage) {
      throw new Error("Message should be stored in the database");
    }
    expect(clientDbMessage.parts).toEqual([{ text: "Hello!" }]);
    expect(clientDbMessage.contextId).toBe(response.message.contextId);
  });

  test("Continue conversation within context", async ({ makeAgent }) => {
    const agent = await makeAgent({ name: "agent1", teams: [] });
    const manager = new A2AManager();
    executeA2AMessage.mockReturnValue({
      responseUiMessage: {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text: "response" }],
      },
      text: "response(text)",
    });

    const clientMessageId = crypto.randomUUID();
    const response = await manager.sendMessage({
      actor,
      agentId: agent.id,
      request: {
        message: {
          messageId: clientMessageId,
          role: A2AProtocolRole.User,
          parts: [{ text: "Hello!" }],
        },
      },
    });

    if (!response.message) {
      throw new Error("Message should be defined");
    }
    const contextId = response.message.contextId;
    if (!contextId) {
      throw new Error("Context ID should be defined");
    }
    executeA2AMessage.mockReturnValue({
      responseUiMessage: {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text: "response" }],
      },
      text: "response(text)",
    });
    const clientMessageId2 = crypto.randomUUID();
    const response2 = await manager.sendMessage({
      actor,
      agentId: agent.id,
      request: {
        message: {
          messageId: clientMessageId2,
          contextId,
          role: A2AProtocolRole.User,
          parts: [{ text: "Hello2!" }],
        },
      },
    });
    if (!response2.message) {
      throw new Error("Message should be defined");
    }
    expect(response2.message.contextId).toBe(contextId);

    expect((await A2AMessageModel.findById(clientMessageId))?.contextId).toBe(
      contextId,
    );
    expect(
      (await A2AMessageModel.findById(response.message.messageId))?.contextId,
    ).toBe(contextId);
    expect((await A2AMessageModel.findById(clientMessageId2))?.contextId).toBe(
      contextId,
    );
    expect(
      (await A2AMessageModel.findById(response2.message.messageId))?.contextId,
    ).toBe(contextId);
    const contextMessages = await A2AMessageModel.findByContextId(contextId);
    expect(contextMessages.length).toBe(4);
  });

  test("Text message stateless", async ({ makeAgent }) => {
    const agent = await makeAgent({ name: "agent1", teams: [] });
    const manager = new A2AManager({ stateless: true });
    const prevContextCount = await A2AContextModel.getTotalCount();
    const prevTaskCount = await A2ATaskModel.getTotalCount();
    const prevMessageCount = await A2AMessageModel.getTotalCount();
    executeA2AMessage.mockReturnValue({
      responseUiMessage: {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text: "response" }],
      },
      text: "response(text)",
    });

    const response = await sendTextMessage(manager, agent.id, "Hello!");

    expect(response.message?.role).toBe(A2AProtocolRole.Agent);
    expect(response.message?.parts).toEqual([{ text: "response" }]);

    // In stateless mode without approval flow nothing should be stored in the database
    expect(await A2AContextModel.getTotalCount()).toBe(prevContextCount);
    expect(await A2ATaskModel.getTotalCount()).toBe(prevTaskCount);
    expect(await A2AMessageModel.getTotalCount()).toBe(prevMessageCount);
  });

  describe("Approval flow", () => {
    test("Simple", async ({ makeAgent }) => {
      const agent = await makeAgent({ name: "agent1", teams: [] });
      const manager = new A2AManager();

      mockA2AExecuteMessageWithApprovalRequests(crypto.randomUUID(), ["1"]);
      const response = await sendTextMessage(manager, agent.id, "Hello!");

      if (!response.task) {
        throw new Error("Task should be defined");
      }
      expect(response.message).toBeUndefined();
      expect(response.task.status?.state).toBe(
        A2AProtocolTaskState.InputRequired,
      );
      expect(response.task.metadata?.approvalRequests).toEqual([
        getApprovalRequest("1"),
      ]);

      executeA2AMessage.mockReturnValue({
        responseUiMessage: {
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [{ type: "text", text: "response" }],
        },
        text: "response(text)",
      });

      const response2 = await sendApprovalDecisions(
        manager,
        agent.id,
        response.task.id,
        [
          {
            approvalId: "approval-1",
            approved: true,
          },
        ],
      );

      if (!response2.message) {
        throw new Error("Message should be defined");
      }

      expect(response2.task).toBeUndefined();
      expect(response2.message.role).toBe(A2AProtocolRole.Agent);
      expect(response2.message.parts).toEqual([{ text: "response" }]);

      const task = await manager.getTask({
        actor,
        agentId: agent.id,
        request: buildGetTaskRequest({ taskId: response.task.id }),
      });
      expect(task.status?.state).toBe(A2AProtocolTaskState.Completed);
      // Completed tasks should not return approval requests
      expect(task.metadata?.approvalRequests).toEqual([]);
      expect((await A2ATaskModel.findById(response.task.id))?.state).toBe(
        A2AProtocolTaskState.Completed,
      );

      const dbMessage = await A2AMessageModel.findById(
        response2.message.messageId,
      );
      if (!dbMessage) {
        throw new Error("Message should be stored in the database");
      }
      expect(dbMessage.parts).toEqual(response2.message.parts);
    });

    test("Multi request in single turn", async ({ makeAgent }) => {
      const agent = await makeAgent({ name: "agent1", teams: [] });
      const manager = new A2AManager();

      mockA2AExecuteMessageWithApprovalRequests(crypto.randomUUID(), [
        "1",
        "2",
        "3",
        "4",
      ]);
      const response = await sendTextMessage(manager, agent.id, "Hello!");

      if (!response.task) {
        throw new Error("Task should be defined");
      }
      expect(response.message).toBeUndefined();
      expect(response.task.status?.state).toBe(
        A2AProtocolTaskState.InputRequired,
      );
      expect(response.task.metadata?.approvalRequests).toEqual([
        getApprovalRequest("1"),
        getApprovalRequest("2"),
        getApprovalRequest("3"),
        getApprovalRequest("4"),
      ]);

      const messagesCountBeforeDecision = await A2AMessageModel.getTotalCount();
      const response2 = await sendApprovalDecisions(
        manager,
        agent.id,
        response.task.id,
        [
          {
            approvalId: "approval-1",
            approved: true,
          },
          {
            approvalId: "approval-2",
            approved: false,
          },
        ],
      );

      if (!response2.task) {
        throw new Error("Task should be defined");
      }
      expect(response2.message).toBeUndefined();
      expect(response2.task.status?.state).toBe(
        A2AProtocolTaskState.InputRequired,
      );
      expect(response2.task.metadata?.approvalRequests).toEqual([
        getApprovalRequest("1", true, true),
        getApprovalRequest("2", true, false),
        getApprovalRequest("3"),
        getApprovalRequest("4"),
      ]);
      // Incomplete task shouldn't create new messages on partial decision
      expect(await A2AMessageModel.getTotalCount()).toBe(
        messagesCountBeforeDecision,
      );
      expect(
        await manager.getTask({
          actor,
          agentId: agent.id,
          request: buildGetTaskRequest({ taskId: response.task.id }),
        }),
      ).toEqual(response2.task);

      const messagesCountBeforeDecision2 =
        await A2AMessageModel.getTotalCount();
      const response3 = await sendApprovalDecisions(
        manager,
        agent.id,
        response.task.id,
        [
          {
            approvalId: "approval-3",
            approved: true,
          },
        ],
      );

      if (!response3.task) {
        throw new Error("Task should be defined");
      }
      expect(response3.message).toBeUndefined();
      expect(response3.task.status?.state).toBe(
        A2AProtocolTaskState.InputRequired,
      );
      expect(response3.task.metadata?.approvalRequests).toEqual([
        getApprovalRequest("1", true, true),
        getApprovalRequest("2", true, false),
        getApprovalRequest("3", true, true),
        getApprovalRequest("4"),
      ]);
      // Incomplete task shouldn't create new messages on partial decision
      expect(await A2AMessageModel.getTotalCount()).toBe(
        messagesCountBeforeDecision2,
      );
      expect(
        await manager.getTask({
          actor,
          agentId: agent.id,
          request: buildGetTaskRequest({ taskId: response.task.id }),
        }),
      ).toEqual(response3.task);
    });

    test("Stateless without contextId", async ({ makeAgent }) => {
      const agent = await makeAgent({ name: "agent1", teams: [] });
      const manager = new A2AManager({ stateless: true });
      const actor: A2AActor = {
        id: "actor1",
        kind: "user",
        organizationId: "org1",
      };

      let prevContextCount = await A2AContextModel.getTotalCount();
      let prevTaskCount = await A2ATaskModel.getTotalCount();
      let prevMessageCount = await A2AMessageModel.getTotalCount();

      executeA2AMessage.mockReturnValue({
        responseUiMessage: {
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [
            {
              type: "tool-tool-1",
              state: "approval-requested",
              approval: {
                id: "approval-1",
              },
              toolCallId: "toolCall-1",
            },
          ],
        },
        text: "",
      });

      const response = await sendTextMessage(manager, agent.id, "Hello!");

      if (!response.task) {
        throw new Error("Task should be defined");
      }
      expect(response.message).toBeUndefined();
      expect(response.task.contextId).toBeDefined();
      expect(response.task.status?.state).toBe(
        A2AProtocolTaskState.InputRequired,
      );
      expect(response.task.metadata?.approvalRequests).toEqual([
        {
          approvalId: "approval-1",
          toolCallId: "toolCall-1",
          toolName: "tool-1",
          approved: false,
          resolved: false,
        },
      ]);
      expect(response.task.history).toEqual([
        {
          messageId: expect.any(String),
          contextId: response.task.contextId,
          taskId: response.task.id,
          role: A2AProtocolRole.User,
          parts: [{ text: "Hello!" }],
        },
        {
          messageId: expect.any(String),
          contextId: response.task.contextId,
          taskId: response.task.id,
          role: A2AProtocolRole.Agent,
          parts: [],
        },
      ]);
      const history = response.task.history || [];
      const lastMessage = history.length
        ? history[history.length - 1]
        : undefined;
      expect(response.task.status.message).toEqual(lastMessage);

      expect(
        await manager.getTask({
          actor,
          agentId: agent.id,
          request: buildGetTaskRequest({ taskId: response.task.id }),
        }),
      ).toEqual(response.task);

      expect(await A2AContextModel.getTotalCount()).toBe(prevContextCount + 1);
      expect(await A2ATaskModel.getTotalCount()).toBe(prevTaskCount + 1);
      // 1 user message + 1 assistant message
      expect(await A2AMessageModel.getTotalCount()).toBe(prevMessageCount + 2);

      // second request

      prevContextCount = await A2AContextModel.getTotalCount();
      prevTaskCount = await A2ATaskModel.getTotalCount();
      prevMessageCount = await A2AMessageModel.getTotalCount();

      executeA2AMessage.mockReturnValue({
        responseUiMessage: {
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [{ type: "text", text: "response" }],
        },
        text: "response(text)",
      });

      const response2 = await manager.sendMessage({
        actor,
        agentId: agent.id,
        request: buildApprovalDecisionSendMessageRequest({
          taskId: response.task.id,
          approvalDecisions: [
            {
              approvalId: "approval-1",
              approved: true,
            },
          ],
        }),
      });
      expect(response2.message).toBeDefined();
      expect(response2.task).toBeUndefined();
      expect(response2.message?.role).toBe(A2AProtocolRole.Agent);
      expect(response2.message?.parts).toEqual([{ text: "response" }]);

      const task = await manager.getTask({
        actor,
        agentId: agent.id,
        request: buildGetTaskRequest({ taskId: response.task.id }),
      });
      expect(task.status?.state).toBe(A2AProtocolTaskState.Completed);
      // Completed tasks should not return approval requests
      expect(task.metadata?.approvalRequests).toEqual([]);
      expect((await A2ATaskModel.findById(response.task.id))?.state).toBe(
        A2AProtocolTaskState.Completed,
      );

      expect(await A2AContextModel.getTotalCount()).toBe(prevContextCount);
      expect(await A2ATaskModel.getTotalCount()).toBe(prevTaskCount);
      expect(await A2AMessageModel.getTotalCount()).toBe(prevMessageCount);
    });

    test("Multi-turn", async ({ makeAgent }) => {
      // Case: agent send new approval request based on previous approval request resolution,
      //   without user message in between.
      // Path: user-msg -> approval-req1 -> user-resolve-full -> execute -> approval-req2

      const agent = await makeAgent({ name: "agent1", teams: [] });
      const manager = new A2AManager();

      const approvalMessageId = crypto.randomUUID();
      mockA2AExecuteMessageWithApprovalRequests(approvalMessageId, ["1"]);
      const response = await sendTextMessage(manager, agent.id, "Hello!");

      if (!response.task) {
        throw new Error("Task should be defined");
      }
      expect(response.message).toBeUndefined();
      expect(response.task.status?.state).toBe(
        A2AProtocolTaskState.InputRequired,
      );
      expect(extractApprovalRequestsFromSendMessageResult(response)).toEqual([
        getApprovalRequest("1"),
      ]);
      expect(response.task.history).toEqual([
        {
          messageId: expect.any(String),
          contextId: response.task.contextId,
          taskId: response.task.id,
          role: A2AProtocolRole.User,
          parts: [{ text: "Hello!" }],
        },
        {
          messageId: approvalMessageId,
          contextId: response.task.contextId,
          taskId: response.task.id,
          role: A2AProtocolRole.Agent,
          parts: [],
        },
      ]);
      expect(
        await manager.getTask({
          actor,
          agentId: agent.id,
          request: buildGetTaskRequest({ taskId: response.task.id }),
        }),
      ).toEqual(response.task);

      // The agent accepts the approval request,
      //   executes the message and returns a new approval request.
      mockA2AExecuteMessageWithApprovalRequests(approvalMessageId, ["11"]);
      const response2 = await sendApprovalDecisions(
        manager,
        agent.id,
        response.task.id,
        [
          {
            approvalId: "approval-1",
            approved: true,
          },
        ],
      );
      if (!response2.task) {
        throw new Error("Task should be defined");
      }
      expect(response2.task.id).toBeDefined();
      expect(response2.task.id).toEqual(response.task.id);
      expect(response2.task.status?.state).toBe(
        A2AProtocolTaskState.InputRequired,
      );
      expect(extractApprovalRequestsFromSendMessageResult(response2)).toEqual([
        getApprovalRequest("11"),
      ]);
      expect(response2.task.history?.slice(0, 2)).toEqual(
        response.task.history,
      );
      expect(response2.task.history).toEqual([
        {
          messageId: expect.any(String),
          contextId: response2.task.contextId,
          taskId: response2.task.id,
          role: A2AProtocolRole.User,
          parts: [{ text: "Hello!" }],
        },
        {
          messageId: approvalMessageId,
          contextId: response2.task.contextId,
          taskId: response2.task.id,
          role: A2AProtocolRole.Agent,
          parts: [],
        },
      ]);
      expect(
        await manager.getTask({
          actor,
          agentId: agent.id,
          request: buildGetTaskRequest({ taskId: response.task.id }),
        }),
      ).toEqual(response2.task);

      mockA2AExecuteMessageWithApprovalRequests(approvalMessageId, ["21"]);
      const response3 = await sendApprovalDecisions(
        manager,
        agent.id,
        response.task.id,
        [
          {
            approvalId: "approval-11",
            approved: true,
          },
        ],
      );
      if (!response3.task) {
        throw new Error("Task should be defined");
      }
      expect(response3.task.id).toBeDefined();
      expect(response3.task.id).toEqual(response.task.id);
      expect(response3.task.status?.state).toBe(
        A2AProtocolTaskState.InputRequired,
      );
      expect(extractApprovalRequestsFromSendMessageResult(response3)).toEqual([
        getApprovalRequest("21"),
      ]);
      expect(
        await manager.getTask({
          actor,
          agentId: agent.id,
          request: buildGetTaskRequest({ taskId: response.task.id }),
        }),
      ).toEqual(response3.task);
    });

    test("Multi-turn messages history", async ({ makeAgent }) => {
      const agent = await makeAgent({ name: "agent1", teams: [] });
      const manager = new A2AManager();

      const approvalMessageId = crypto.randomUUID();
      mockA2AExecuteMessageWithTextAndApprovalRequests(
        approvalMessageId,
        ["Doing 1st"],
        ["1"],
      );
      const response = await sendTextMessage(manager, agent.id, "Hello!");

      if (!response.task) {
        throw new Error("Task should be defined");
      }
      expect(response.message).toBeUndefined();
      expect(response.task.status?.state).toBe(
        A2AProtocolTaskState.InputRequired,
      );
      expect(extractApprovalRequestsFromSendMessageResult(response)).toEqual([
        getApprovalRequest("1"),
      ]);
      expect(response.task.history).toEqual([
        {
          messageId: expect.any(String),
          contextId: response.task.contextId,
          taskId: response.task.id,
          role: A2AProtocolRole.User,
          parts: [{ text: "Hello!" }],
        },
        {
          messageId: approvalMessageId,
          contextId: response.task.contextId,
          taskId: response.task.id,
          role: A2AProtocolRole.Agent,
          parts: [{ text: "Doing 1st" }],
        },
      ]);
      expect(
        await manager.getTask({
          actor,
          agentId: agent.id,
          request: buildGetTaskRequest({ taskId: response.task.id }),
        }),
      ).toEqual(response.task);

      // The agent accepts the approval request,
      //   executes the message and returns a new approval request.
      mockA2AExecuteMessageWithTextAndApprovalRequests(
        approvalMessageId,
        ["Doing 1st", "Doing 2nd"],
        ["2"],
      );
      const response2 = await sendApprovalDecisions(
        manager,
        agent.id,
        response.task.id,
        [
          {
            approvalId: "approval-1",
            approved: true,
          },
        ],
      );
      if (!response2.task) {
        throw new Error("Task should be defined");
      }
      expect(response2.task.id).toBeDefined();
      expect(response2.task.id).toEqual(response.task.id);
      expect(response2.task.status?.state).toBe(
        A2AProtocolTaskState.InputRequired,
      );
      expect(extractApprovalRequestsFromSendMessageResult(response2)).toEqual([
        getApprovalRequest("2"),
      ]);
      expect(response2.task.history).toEqual([
        {
          messageId: response.task.history?.[0].messageId,
          contextId: response2.task.contextId,
          taskId: response2.task.id,
          role: A2AProtocolRole.User,
          parts: [{ text: "Hello!" }],
        },
        {
          messageId: response.task.history?.[1].messageId,
          contextId: response2.task.contextId,
          taskId: response2.task.id,
          role: A2AProtocolRole.Agent,
          parts: [{ text: "Doing 1st" }, { text: "Doing 2nd" }],
        },
      ]);
      expect(
        await manager.getTask({
          actor,
          agentId: agent.id,
          request: buildGetTaskRequest({ taskId: response.task.id }),
        }),
      ).toEqual(response2.task);

      mockA2AExecuteMessageWithTextAndApprovalRequests(
        approvalMessageId,
        ["Doing 1st", "Doing 2nd", "Doing 3rd"],
        ["3"],
      );
      const response3 = await sendApprovalDecisions(
        manager,
        agent.id,
        response.task.id,
        [
          {
            approvalId: "approval-2",
            approved: true,
          },
        ],
      );
      if (!response3.task) {
        throw new Error("Task should be defined");
      }
      expect(response3.task.id).toBeDefined();
      expect(response3.task.id).toEqual(response.task.id);
      expect(response3.task.status?.state).toBe(
        A2AProtocolTaskState.InputRequired,
      );
      expect(extractApprovalRequestsFromSendMessageResult(response3)).toEqual([
        getApprovalRequest("3"),
      ]);
      expect(response3.task.history).toEqual([
        {
          messageId: response.task.history?.[0].messageId,
          contextId: response3.task.contextId,
          taskId: response3.task.id,
          role: A2AProtocolRole.User,
          parts: [{ text: "Hello!" }],
        },
        {
          messageId: response.task.history?.[1].messageId,
          contextId: response3.task.contextId,
          taskId: response3.task.id,
          role: A2AProtocolRole.Agent,
          parts: [
            { text: "Doing 1st" },
            { text: "Doing 2nd" },
            { text: "Doing 3rd" },
          ],
        },
      ]);
      expect(
        await manager.getTask({
          actor,
          agentId: agent.id,
          request: buildGetTaskRequest({ taskId: response3.task.id }),
        }),
      ).toEqual(response3.task);

      mockA2AExecuteMessageWithTextAndApprovalRequests(
        approvalMessageId,
        ["Doing 1st", "Doing 2nd", "Doing 3rd", "Final"],
        [],
      );
      const response4 = await sendApprovalDecisions(
        manager,
        agent.id,
        response3.task.id,
        [
          {
            approvalId: "approval-3",
            approved: true,
          },
        ],
      );
      expect(response4.message).toBeDefined();
      expect(response4.task).toBeUndefined();
      expect(response4.message?.role).toBe(A2AProtocolRole.Agent);
      expect(response4.message?.parts).toEqual([
        { text: "Doing 1st" },
        { text: "Doing 2nd" },
        { text: "Doing 3rd" },
        { text: "Final" },
      ]);

      const task = await manager.getTask({
        actor,
        agentId: agent.id,
        request: buildGetTaskRequest({ taskId: response3.task.id }),
      });
      expect(task.status?.state).toBe(A2AProtocolTaskState.Completed);
    });
  });
});
