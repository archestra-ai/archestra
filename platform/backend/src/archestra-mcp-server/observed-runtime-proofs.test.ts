import {
  TOOL_GET_AGENT_RUN_FULL_NAME,
  TOOL_TRANSFER_WORKSPACE_FILE_SHORT_NAME,
  TOOL_WRITE_WORKSPACE_FILE_SHORT_NAME,
} from "@archestra/shared";
import { vi } from "vitest";
import { executeArchestraTool } from "@/archestra-mcp-server";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import db, { schema } from "@/database";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import OpenAppaUnenforcedModel from "@/models/openappa-unenforced";
import { openappaActor } from "@/openappa/actor";
import { signRuntimeToolProof } from "@/openappa/runtime-tool-claims";
import * as openappa from "@/openappa/service";
import { kubernetesAgentRuntimeBackendDriver as backend } from "@/services/agent-runtime/backends/kubernetes";
import { runtimeOpenAppaSession } from "@/services/agent-runtime/runtime-identity";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import type { Agent } from "@/types";

setupTestCacheManager();

const PARENT = "user:parent|conversation";
const SECRET = "observed-runtime-proof-test-secret";

describe("runtime calls signed while enforcement was off", () => {
  const priorSecret = config.openappa.offerSigningSecret;
  const priorOpenappa = config.openappa.enabled;

  beforeEach(async () => {
    config.openappa.offerSigningSecret = SECRET;
    config.openappa.enabled = true;
    // The call reaches the gateway after enforcement turned on again.
    await GuardrailsDeploymentModel.setEnabled(true);
    vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
  });

  afterEach(() => {
    config.openappa.offerSigningSecret = priorSecret;
    config.openappa.enabled = priorOpenappa;
  });

  test("crosses as its session's once, when the session made the call", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const seeded = await seededRun({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
      seedAndAssignArchestraTools,
    });
    await recordMade(seeded, "observed-get-run");
    const read = vi.spyOn(openappa, "loadChildReturns").mockResolvedValue([
      {
        childSessionId: seeded.child.session_id,
        operationId: `runtime-return:${seeded.taskId}:checked`,
        value: "checked answer",
      },
    ]);

    const first = await getRun(seeded, { callId: "observed-get-run" });
    expect(first.isError).not.toBe(true);
    expect(JSON.stringify(first.content)).toContain("checked answer");
    // The runtime's output crossed into the parent session, not around it.
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: PARENT,
        childSessionId: seeded.child.session_id,
      }),
    );

    const replay = await getRun(seeded, { callId: "observed-get-run" });
    expect(replay.isError).toBe(true);
    expect(JSON.stringify(replay.content)).toContain(
      "no unclaimed record of this runtime call",
    );
    expect(read).toHaveBeenCalledOnce();
  });

  test("is refused when no record says the session made the call", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const seeded = await seededRun({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
      seedAndAssignArchestraTools,
    });
    const read = vi.spyOn(openappa, "loadChildReturns");

    const result = await getRun(seeded, { callId: "never-made" });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "no unclaimed record of this runtime call",
    );
    expect(read).not.toHaveBeenCalled();
  });

  test("never accepts a launch, even one the session made", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const seeded = await seededRun({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
      seedAndAssignArchestraTools,
    });
    await recordMade(seeded, "observed-spawn");

    const result = await getRun(seeded, {
      callId: "observed-spawn",
      spawn: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "no unclaimed record of this runtime call",
    );
  });
});

describe("runtime calls signed while enforcement was off, beyond reads", () => {
  const priorSecret = config.openappa.offerSigningSecret;
  const priorOpenappa = config.openappa.enabled;

  beforeEach(() => {
    config.openappa.offerSigningSecret = SECRET;
    config.openappa.enabled = true;
    vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
  });

  afterEach(() => {
    config.openappa.offerSigningSecret = priorSecret;
    config.openappa.enabled = priorOpenappa;
  });

  test("a write is refused once enforcement is on, so the model makes it again under a ruling", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    await GuardrailsDeploymentModel.setEnabled(true);
    const seeded = await seededRun({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
      seedAndAssignArchestraTools,
    });
    await recordMade(seeded, "observed-write");
    const args = {
      run_id: seeded.taskId,
      path: "notes.txt",
      content: "written while off",
    };
    const proof = signRuntimeToolProof({
      session: seeded.parent,
      toolCallId: "observed-write",
      action: "write_workspace_file",
      arguments: args,
      spawn: false,
      observed: true,
      secret: SECRET,
    });

    const result = await executeArchestraTool(
      archestraMcpBranding.getToolName(TOOL_WRITE_WORKSPACE_FILE_SHORT_NAME),
      { ...args, runtime_proof: proof },
      seeded.context,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "no unclaimed record of this runtime call",
    );
  });

  test("an upload is refused once enforcement is on, as a write is", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    await GuardrailsDeploymentModel.setEnabled(true);
    const seeded = await seededRun({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
      seedAndAssignArchestraTools,
    });
    await recordMade(seeded, "observed-upload");
    const args = {
      run_id: seeded.taskId,
      direction: "upload",
      path: "in/data.csv",
      local_path: "/tmp/data.csv",
    };
    const proof = signRuntimeToolProof({
      session: seeded.parent,
      toolCallId: "observed-upload",
      action: "transfer_workspace_file",
      arguments: args,
      spawn: false,
      observed: true,
      secret: SECRET,
    });

    const result = await executeArchestraTool(
      archestraMcpBranding.getToolName(TOOL_TRANSFER_WORKSPACE_FILE_SHORT_NAME),
      { ...args, runtime_proof: proof },
      seeded.context,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "no unclaimed record of this runtime call",
    );
  });

  test("while enforcement is off, a proof that does not check out does not fail the call", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    await GuardrailsDeploymentModel.setEnabled(false);
    const seeded = await seededRun({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
      seedAndAssignArchestraTools,
    });
    const args = { run_id: seeded.taskId };
    // Signed long ago: the call sat behind a slow tool, and the proof expired.
    const stale = signRuntimeToolProof({
      session: seeded.parent,
      toolCallId: "stale-get-run",
      action: "get_agent_run",
      arguments: args,
      spawn: false,
      observed: true,
      secret: SECRET,
      now: Math.floor(Date.now() / 1000) - 3600,
    });

    const result = await executeArchestraTool(
      TOOL_GET_AGENT_RUN_FULL_NAME,
      { ...args, runtime_proof: stale },
      seeded.context,
    );

    expect(JSON.stringify(result.content)).not.toContain(
      "could not verify this runtime tool",
    );
    expect(JSON.stringify(result.content)).toContain(seeded.taskId);
  });
});

// =============================================================================
// Helpers
// =============================================================================

type Seeded = Awaited<ReturnType<typeof seededRun>>;

async function recordMade(seeded: Seeded, toolCallId: string): Promise<void> {
  await OpenAppaUnenforcedModel.recordCalls({
    organizationId: seeded.organizationId,
    sessionId: PARENT,
    toolCallIds: [toolCallId],
    reason: "made",
  });
}

function getRun(seeded: Seeded, params: { callId: string; spawn?: boolean }) {
  const args = { run_id: seeded.taskId };
  const proof = signRuntimeToolProof({
    session: seeded.parent,
    toolCallId: params.callId,
    action: "get_agent_run",
    arguments: args,
    spawn: params.spawn ?? false,
    observed: true,
    secret: SECRET,
  });
  if (!proof) throw new Error("The fixture has no source proof");
  return executeArchestraTool(
    TOOL_GET_AGENT_RUN_FULL_NAME,
    { ...args, runtime_proof: proof },
    seeded.context,
  );
}

/** A run whose runtime is bound to `PARENT`, a governed session of its user. */
async function seededRun(params: {
  makeAgent: (overrides: Record<string, unknown>) => Promise<Agent>;
  makeMember: (
    userId: string,
    organizationId: string,
    role: { role: "member" },
  ) => Promise<unknown>;
  makeOrganization: () => Promise<{ id: string }>;
  makeUser: () => Promise<{ id: string }>;
  seedAndAssignArchestraTools: (agentId: string) => Promise<unknown>;
}) {
  const actor = await params.makeUser();
  const org = await params.makeOrganization();
  await params.makeMember(actor.id, org.id, { role: "member" });
  const agent = await params.makeAgent({
    organizationId: org.id,
    authorId: actor.id,
    runtime: {
      image: "runtime:test",
      command: null,
      inferenceProtocol: "openai_chat",
      backend: "kubernetes",
      steerMode: "tmux_keys",
      privileged: false,
      resources: null,
      environment: null,
      credentials: null,
      ttlHours: 1,
      idleTimeoutMinutes: 5,
    },
  });
  await params.seedAndAssignArchestraTools(agent.id);
  const contextRow = await A2AContextModel.create({
    actorKind: "user",
    actorId: actor.id,
  });
  const task = await A2ATaskModel.createForRun({
    contextId: contextRow.id,
    agentId: agent.id,
  });
  const scope = backend.resolveRuntimeScope({});
  const workloadName = `live-${task.id}`;
  await AgentRunModel.create({
    organizationId: org.id,
    agentId: agent.id,
    taskId: task.id,
    actorKind: "user",
    actorId: actor.id,
    actorUserId: actor.id,
    backend: "kubernetes",
    runtimeScope: scope,
    workloadName,
  });
  const workspace = await AgentWorkspaceModel.create({
    id: task.id,
    organizationId: org.id,
    agentId: agent.id,
    actorKind: "user",
    actorId: actor.id,
    backend: "kubernetes",
    runtimeScope: scope,
    workloadName,
    state: "active",
    activeTaskId: task.id,
    lastTaskId: task.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const child = runtimeOpenAppaSession({
    organizationId: org.id,
    workspaceId: workspace.id,
    workloadName,
    actorKind: "user",
    actorId: actor.id,
    parentId: PARENT,
  });
  const parent = {
    organization_id: org.id,
    caller_id: `user:${actor.id}`,
    session_id: PARENT,
  };
  await db.insert(schema.openappaSessionsTable).values([
    {
      organizationId: org.id,
      callerId: parent.caller_id,
      sessionId: PARENT,
      actor: openappaActor(PARENT),
      root: openappaActor(PARENT),
      parentId: null,
      startDecision: { decision: "ack" },
    },
    {
      actor: openappaActor(child.session_id),
      root: openappaActor(PARENT),
      organizationId: org.id,
      callerId: child.caller_id,
      sessionId: child.session_id,
      parentId: PARENT,
      startDecision: { decision: "ack" },
    },
  ]);
  return {
    organizationId: org.id,
    taskId: task.id,
    child,
    parent,
    context: {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      userId: actor.id,
      organizationId: org.id,
    },
  };
}
