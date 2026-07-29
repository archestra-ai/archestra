import { chatTaskPrincipal } from "@/clients/chat-task-bridge";
import { McpGatewayTaskModel } from "@/models";
import { mcpGatewayTaskRunner } from "@/routes/mcp-gateway/tasks";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const TTL_MS = 60_000;

describe("POST /api/chat/tasks/:taskId/cancel", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;
  let agentId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    currentUser = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(currentUser.id, organizationId, { role: "admin" });
    agentId = (await makeAgent()).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: chatRoutes } = await import("./routes");
    await app.register(chatRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const cancel = (taskId: string) =>
    app.inject({ method: "POST", url: `/api/chat/tasks/${taskId}/cancel` });

  async function makeTask(principal: string) {
    return McpGatewayTaskModel.create({
      agentId,
      principal,
      toolName: "slow-lab__slow_report",
      ttlMs: TTL_MS,
    });
  }

  test("cancels a running task the caller owns", async () => {
    const task = await makeTask(chatTaskPrincipal(currentUser.id));

    const response = await cancel(task.id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cancelled: true });

    const stored = await McpGatewayTaskModel.getForPrincipal({
      taskId: task.id,
      agentId,
      principal: chatTaskPrincipal(currentUser.id),
    });
    expect(stored?.status).toBe("cancelled");
  });

  test("aborts the in-flight call when it is running on this replica", async () => {
    const task = await makeTask(chatTaskPrincipal(currentUser.id));
    const controller = new AbortController();
    mcpGatewayTaskRunner.register(task.id, controller);

    await cancel(task.id);

    expect(controller.signal.aborted).toBe(true);
    mcpGatewayTaskRunner.release(task.id);
  });

  test("will not cancel another user's task, and leaves it running", async ({
    makeUser,
  }) => {
    const otherUser = await makeUser();
    const task = await makeTask(chatTaskPrincipal(otherUser.id));
    const controller = new AbortController();
    mcpGatewayTaskRunner.register(task.id, controller);

    const response = await cancel(task.id);

    // Reported the same way as a task that never existed, so a task id cannot
    // be probed across users.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cancelled: false });

    const stored = await McpGatewayTaskModel.getForPrincipal({
      taskId: task.id,
      agentId,
      principal: chatTaskPrincipal(otherUser.id),
    });
    expect(stored?.status).toBe("working");
    // The abort must not fire for a task the caller does not own.
    expect(controller.signal.aborted).toBe(false);
    mcpGatewayTaskRunner.release(task.id);
  });

  test("reports false for an already-finished task", async () => {
    const task = await makeTask(chatTaskPrincipal(currentUser.id));
    await McpGatewayTaskModel.completeIfWorking(task.id, {
      content: [{ type: "text", text: "done" }],
    });

    const response = await cancel(task.id);

    expect(response.json()).toEqual({ cancelled: false });
    const stored = await McpGatewayTaskModel.getForPrincipal({
      taskId: task.id,
      agentId,
      principal: chatTaskPrincipal(currentUser.id),
    });
    // A cancel arriving after completion must not overwrite the result.
    expect(stored?.status).toBe("completed");
  });

  test("reports false for an unknown task id", async () => {
    const response = await cancel("00000000-0000-4000-8000-000000000000");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cancelled: false });
  });

  test("rejects a malformed task id", async () => {
    const response = await cancel("not-a-uuid");

    expect(response.statusCode).toBe(400);
  });
});
