import { ADMIN_ROLE_NAME, BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { vi } from "vitest";
import type { executeA2AMessage } from "@/agents/a2a-executor";

const A2A_RESULT = {
  messageId: "msg-1",
  text: "done",
  finishReason: "stop",
  responseUiMessage: {
    id: "a0000000-0000-4000-8000-000000000001",
    role: "assistant",
    parts: [{ type: "text", text: "done" }],
  },
};

const mockExecuteA2AMessage = vi.hoisted(() => vi.fn());
vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: mockExecuteA2AMessage,
}));

import config from "@/config";
import db, { schema } from "@/database";
import { ScheduleTriggerRunModel } from "@/models";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type TestFixtures,
  test,
} from "@/test";
import { handleScheduleTriggerRunExecution } from "./schedule-trigger-run-handler";

describe("handleScheduleTriggerRunExecution for a tuner", () => {
  const saved = {
    tuners: config.tuners.enabled,
    openappa: config.openappa.enabled,
  };
  beforeEach(() => {
    config.tuners.enabled = true;
    config.openappa.enabled = true;
    mockExecuteA2AMessage.mockReset().mockResolvedValue(A2A_RESULT);
  });
  afterEach(() => {
    config.tuners.enabled = saved.tuners;
    config.openappa.enabled = saved.openappa;
  });

  test("with nothing found, succeeds without calling the agent", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const { trigger, run } = await appaTunerRun({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    });

    await handleScheduleTriggerRunExecution({
      runId: run.id,
      triggerId: trigger.id,
    });

    const settled = await ScheduleTriggerRunModel.findById(run.id);
    expect(settled?.status).toBe("success");
    expect(settled?.tuner?.outcome).toBe("no_candidates");
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  test("with candidates, runs the agent on the tuner's message for this run", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const { organizationId, trigger, run } = await appaTunerRun({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
    });
    await seedDenials(organizationId);
    let executed: Parameters<typeof executeA2AMessage>[0] | undefined;
    mockExecuteA2AMessage.mockImplementation(async (params) => {
      executed = params;
      return A2A_RESULT;
    });

    await handleScheduleTriggerRunExecution({
      runId: run.id,
      triggerId: trigger.id,
    });

    const settled = await ScheduleTriggerRunModel.findById(run.id);
    expect(settled?.error).toBeNull();
    expect(settled?.status).toBe("success");
    expect(settled?.tuner?.outcome).toBe("agent_ran");
    expect(executed?.scheduleTriggerRunId).toBe(run.id);
    expect(executed?.message).not.toBe(trigger.messageTemplate);
  });

  test("fails the run when the actor lost tuner access", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const { trigger, run } = await appaTunerRun({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
      makeScheduleTriggerRun,
      actorRole: "member",
    });

    await handleScheduleTriggerRunExecution({
      runId: run.id,
      triggerId: trigger.id,
    });

    const settled = await ScheduleTriggerRunModel.findById(run.id);
    expect(settled?.status).toBe("failed");
    expect(settled?.tuner).toBeNull();
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });
});

async function appaTunerRun(
  params: Pick<
    TestFixtures,
    | "makeOrganization"
    | "makeUser"
    | "makeMember"
    | "makeAgent"
    | "makeScheduleTrigger"
    | "makeScheduleTriggerRun"
  > & { actorRole?: string },
) {
  const organization = await params.makeOrganization();
  const actor = await params.makeUser();
  await params.makeMember(actor.id, organization.id, {
    role: params.actorRole ?? ADMIN_ROLE_NAME,
  });
  const agent = await params.makeAgent({
    agentType: "agent",
    organizationId: organization.id,
    builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.APPA_TUNER },
  });
  const trigger = await params.makeScheduleTrigger({
    organizationId: organization.id,
    actorUserId: actor.id,
    agentId: agent.id,
    tunerKind: "appa",
  });
  const run = await params.makeScheduleTriggerRun(trigger.id);
  return { organizationId: organization.id, trigger, run };
}

async function seedDenials(organizationId: string) {
  for (const [index, session] of ["s1", "s1", "s1", "s2", "s2"].entries()) {
    await db.insert(schema.openappaOperationsTable).values({
      organizationId,
      sessionId: session,
      operationId: `call:${crypto.randomUUID()}`,
      root: "root",
      status: "complete",
      input: { semantic: { event: "tool_call", tool: "shell__exec" } },
      decision: { decision: "deny_call", offers: [] },
      createdAt: new Date(Date.now() - (index + 1) * 60 * 60 * 1000),
    });
  }
}
