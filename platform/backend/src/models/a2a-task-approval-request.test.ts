import {
  type A2AArchestraApprovalRequest,
  A2AProtocolTaskState,
} from "@/agents/a2a/a2a-protocol";
import { describe, expect, test } from "@/test";
import A2AContextModel from "./a2a-context";
import A2ATaskModel from "./a2a-task";
import A2ATaskApprovalRequestModel from "./a2a-task-approval-request";

async function createContext() {
  return await A2AContextModel.create({
    actorKind: "user",
    actorId: crypto.randomUUID(),
  });
}

async function createTask(contextId: string) {
  return await A2ATaskModel.create({
    contextId,
    state: A2AProtocolTaskState.Submitted,
  });
}

function makeApprovalRequest(
  approvalId: string,
  overrides: Partial<A2AArchestraApprovalRequest> = {},
): A2AArchestraApprovalRequest {
  return {
    approvalId,
    toolCallId: `tool-call-${approvalId}`,
    toolName: `Tool ${approvalId}`,
    approved: false,
    resolved: false,
    ...overrides,
  };
}

describe("A2ATaskApprovalRequestModel", () => {
  describe("bulkCreate", () => {
    test("creates approval requests for a task", async () => {
      const context = await createContext();
      const task = await createTask(context.id);
      const approvalRequests = [
        makeApprovalRequest("approval-2"),
        makeApprovalRequest("approval-1"),
      ];

      const created = await A2ATaskApprovalRequestModel.bulkCreate({
        taskId: task.id,
        approvalRequests,
      });

      expect(created).toHaveLength(2);
      expect(created.every((req) => req.taskId === task.id)).toBe(true);

      const found = await A2ATaskApprovalRequestModel.findByTaskId(task.id);

      expect(found).toHaveLength(2);
      expect(found.every((req) => req.taskId === task.id)).toBe(true);
      expect(found.map(({ approvalId }) => approvalId).sort()).toEqual([
        "approval-1",
        "approval-2",
      ]);
    });
  });

  describe("bulkCreateRaw", () => {
    test("returns an empty array for empty input", async () => {
      await expect(
        A2ATaskApprovalRequestModel.bulkCreateRaw([]),
      ).resolves.toEqual([]);
    });
  });

  describe("findById", () => {
    test("returns an approval request by id", async () => {
      const context = await createContext();
      const task = await createTask(context.id);
      const [created] = await A2ATaskApprovalRequestModel.bulkCreateRaw([
        {
          ...makeApprovalRequest("approval-1"),
          taskId: task.id,
        },
      ]);

      const found = await A2ATaskApprovalRequestModel.findById(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.taskId).toBe(task.id);
      expect(found?.approvalId).toBe("approval-1");
      expect(found?.toolCallId).toBe("tool-call-approval-1");
      expect(found?.toolName).toBe("Tool approval-1");
      expect(found?.approved).toBe(false);
      expect(found?.resolved).toBe(false);
    });
  });

  describe("updateDecision", () => {
    test("updates a single approval request decision", async () => {
      const context = await createContext();
      const task = await createTask(context.id);
      const [created] = await A2ATaskApprovalRequestModel.bulkCreateRaw([
        {
          ...makeApprovalRequest("approval-1"),
          taskId: task.id,
        },
      ]);

      await A2ATaskApprovalRequestModel.updateDecision({
        taskId: task.id,
        approvalId: created.approvalId,
        approved: true,
      });

      const found = await A2ATaskApprovalRequestModel.findById(created.id);

      expect(found?.approved).toBe(true);
      expect(found?.resolved).toBe(true);
    });
  });

  describe("updateTaskApprovalDecisions", () => {
    test("updates multiple approval decisions on a task", async () => {
      const context = await createContext();
      const task = await createTask(context.id);
      await A2ATaskApprovalRequestModel.bulkCreate({
        taskId: task.id,
        approvalRequests: [
          makeApprovalRequest("approval-1"),
          makeApprovalRequest("approval-2"),
          makeApprovalRequest("approval-3"),
        ],
      });

      await A2ATaskApprovalRequestModel.updateTaskApprovalDecisions({
        taskId: task.id,
        approvalDecisions: [
          { approvalId: "approval-1", approved: true },
          { approvalId: "approval-3", approved: false },
        ],
      });

      const found = await A2ATaskApprovalRequestModel.findByTaskId(task.id);
      const byApprovalId = Object.fromEntries(
        found.map((req) => [req.approvalId, req]),
      );

      expect(byApprovalId["approval-1"]).toMatchObject({
        approved: true,
        resolved: true,
      });
      expect(byApprovalId["approval-2"]).toMatchObject({
        approved: false,
        resolved: false,
      });
      expect(byApprovalId["approval-3"]).toMatchObject({
        approved: false,
        resolved: true,
      });
    });
  });

  describe("delete", () => {
    test("removes a single approval request", async () => {
      const context = await createContext();
      const task = await createTask(context.id);
      const [created] = await A2ATaskApprovalRequestModel.bulkCreateRaw([
        {
          ...makeApprovalRequest("approval-delete"),
          taskId: task.id,
        },
      ]);

      await A2ATaskApprovalRequestModel.delete(created.id);
      expect(await A2ATaskApprovalRequestModel.findById(created.id)).toBeNull();
    });

    test("removes all approval requests for a task", async () => {
      const context = await createContext();
      const task = await createTask(context.id);
      await A2ATaskApprovalRequestModel.bulkCreate({
        taskId: task.id,
        approvalRequests: [
          makeApprovalRequest("approval-1"),
          makeApprovalRequest("approval-2"),
        ],
      });

      await A2ATaskApprovalRequestModel.deleteByTaskId(task.id);
      expect(await A2ATaskApprovalRequestModel.findByTaskId(task.id)).toEqual(
        [],
      );
    });
  });
});
