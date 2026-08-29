import {
  TOOL_GET_TASK_FULL_NAME,
  TOOL_START_TASK_FULL_NAME,
} from "@archestra/shared";
import { vi } from "vitest";
import { A2AManager } from "@/agents/a2a/a2a-manager";
import * as a2aExecutor from "@/agents/a2a-executor";
import { AgentTeamModel } from "@/models";
import { RouteCategory } from "@/observability/tracing";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

describe("task tools", () => {
  let callingAgent: Agent;
  let actorId: string;
  let organizationId: string;
  let context: ArchestraContext;

  beforeEach(
    async ({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
      seedAndAssignArchestraTools,
    }) => {
      const organization = await makeOrganization();
      const actor = await makeUser();
      await makeMember(actor.id, organization.id, { role: "member" });
      actorId = actor.id;
      organizationId = organization.id;
      callingAgent = await makeAgent({
        organizationId,
        authorId: actorId,
        agentType: "agent",
        scope: "org",
      });
      await seedAndAssignArchestraTools(callingAgent.id);
      context = {
        agent: { id: callingAgent.id, name: callingAgent.name },
        agentId: callingAgent.id,
        userId: actorId,
        organizationId,
      };
    },
  );

  test("does not start work on a team Agent the actor cannot access", async ({
    makeAgent,
    makeTeam,
    makeUser,
  }) => {
    const owner = await makeUser();
    const team = await makeTeam(organizationId, owner.id);
    const target = await makeAgent({
      organizationId,
      authorId: owner.id,
      agentType: "agent",
      scope: "team",
    });
    await AgentTeamModel.syncAgentTeams(target.id, [team.id]);

    const result = await executeArchestraTool(
      TOOL_START_TASK_FULL_NAME,
      { agent_id: target.id, message: "Do the restricted work" },
      context,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "Agent not found",
    );
  });

  test("task controls remain callable without individual assignment", async ({
    makeAgent,
  }) => {
    const unassignedAgent = await makeAgent({
      organizationId,
      authorId: actorId,
      agentType: "mcp_gateway",
      scope: "org",
    });

    const result = await executeArchestraTool(
      TOOL_GET_TASK_FULL_NAME,
      { task_id: crypto.randomUUID() },
      {
        ...context,
        agent: { id: unassignedAgent.id, name: unassignedAgent.name },
        agentId: unassignedAgent.id,
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "Task not found",
    );
    expect((result.content[0] as { text: string }).text).not.toContain(
      "not assigned",
    );
  });

  test("preserves the originating chat thread on a delegated task", async ({
    makeAgent,
  }) => {
    const target = await makeAgent({
      organizationId,
      authorId: actorId,
      agentType: "agent",
      scope: "org",
    });
    vi.spyOn(a2aExecutor, "executeA2AMessage").mockResolvedValue({
      text: "Finished",
      messageId: crypto.randomUUID(),
      finishReason: "stop",
      responseUiMessage: {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text: "Finished" }],
      },
    });
    const sendMessage = vi.spyOn(A2AManager.prototype, "sendMessage");
    const chatContext: ArchestraContext = {
      ...context,
      sessionId: "slack:C123:T456",
      chatOpsBindingId: crypto.randomUUID(),
      chatOpsThreadId: "T456",
    };

    const result = await executeArchestraTool(
      TOOL_START_TASK_FULL_NAME,
      { agent_id: target.id, message: "Do the work" },
      chatContext,
    );

    expect(result.isError).not.toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: target.id,
        systemParams: {
          sessionId: chatContext.sessionId,
          routeCategory: RouteCategory.CHATOPS,
          completionTarget: {
            type: "chatops",
            bindingId: chatContext.chatOpsBindingId,
            threadId: chatContext.chatOpsThreadId,
          },
        },
        taskRun: { createTask: true, detached: true },
      }),
    );
  });
});
