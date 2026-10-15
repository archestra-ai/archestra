import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  TOOL_GET_RUN_FULL_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_START_RUN_FULL_NAME,
  TOOL_STEER_RUN_FULL_NAME,
  TOOL_TRANSFER_WORKSPACE_FILE_SHORT_NAME,
  TOOL_WRITE_WORKSPACE_FILE_SHORT_NAME,
} from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { executeArchestraTool } from "@/archestra-mcp-server";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { startDelegatedTask } from "@/archestra-mcp-server/tasks";
import config from "@/config";
import db, { schema } from "@/database";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
} from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import OpenAppaSpawnCorrelationModel from "@/models/openappa-spawn-correlation";
import { openappaActor } from "@/openappa/actor";
import { signRuntimeToolProof } from "@/openappa/runtime-tool-claims";
import * as openappa from "@/openappa/service";
import { kubernetesAgentRuntimeBackendDriver as backend } from "@/services/agent-runtime/backends/kubernetes";
import * as workspaceFiles from "@/services/agent-runtime/workspace-files";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { Agent, ResolvedAgentRuntime } from "@/types";
import { ApiError } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import { runTaskInAgentRuntime } from "./pod-run";
import { crossRuntimeFile, crossRuntimeOutput } from "./runtime-crossing";
import { runtimeOpenAppaSession } from "./runtime-identity";
import * as startTask from "./start-task";
import { workspaceTransferTickets } from "./workspace-transfers";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
useMswServer(
  http.post("http://127.0.0.1:9000/v1/openai/:agentId/chat/completions", () =>
    HttpResponse.json(
      { error: { message: "Title unavailable" } },
      { status: 400 },
    ),
  ),
);

const PARENT = "user:parent|conversation";
const TOOL_WRITE_WORKSPACE_FILE_FULL_NAME = archestraMcpBranding.getToolName(
  TOOL_WRITE_WORKSPACE_FILE_SHORT_NAME,
);
const TOOL_TRANSFER_WORKSPACE_FILE_FULL_NAME = archestraMcpBranding.getToolName(
  TOOL_TRANSFER_WORKSPACE_FILE_SHORT_NAME,
);
const OTHER = "user:parent|other-session";

describe("runtime crossing", () => {
  const originalBaseUrl = config.agentRuntime.platformBaseUrl;
  const originalOpenappa = config.openappa.enabled;

  beforeEach(async () => {
    config.agentRuntime.platformBaseUrl = "http://platform.test";
    config.openappa.enabled = true;
    await GuardrailsDeploymentModel.setEnabled(true);
    vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
    vi.spyOn(backend, "teardown").mockResolvedValue();
    vi.spyOn(backend, "releaseRun").mockResolvedValue();
    vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);
    vi.spyOn(backend, "stageInputs").mockResolvedValue();
    vi.spyOn(backend, "launch").mockResolvedValue();
    vi.spyOn(backend, "continueRun").mockResolvedValue();
    vi.spyOn(backend, "waitUntilRunning").mockRejectedValue(
      new Error("stop after start"),
    );
  });

  test("binds a child before launch and staged files, and puts the contract in the prompt", async ({
    makeAgent,
    makeAdmin,
    makeMember,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const started = await runnable({
      makeAgent,
      makeAdmin,
      makeMember,
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const order: string[] = [];
    vi.spyOn(openappa, "startRuntimeChild").mockImplementation(async () => {
      order.push("bind");
      return { contract: "CONTRACT" };
    });
    vi.spyOn(backend, "launch").mockImplementation(async (spec) => {
      order.push("launch");
      expect(spec.secretEnv.ARCHESTRA_AGENT_RUNTIME_TASK).toContain("CONTRACT");
      expect(spec.secretEnv.ARCHESTRA_AGENT_RUNTIME_TASK).toContain(
        "Do the work",
      );
    });
    vi.spyOn(backend, "stageInputs").mockImplementation(async () => {
      order.push("stage");
    });

    await expect(
      runTaskInAgentRuntime({
        ...started.params,
        runtimeCrossing: crossing(true, started.organizationId),
      }),
    ).rejects.toThrow("stop after start");

    expect(order).toEqual(["bind", "launch", "stage"]);
    expect(openappa.startRuntimeChild).toHaveBeenCalledWith(
      expect.objectContaining({
        spawnCallId: "call-1",
        session: expect.objectContaining({ parent_id: PARENT }),
      }),
    );
  });

  test("a spawn refusal starts no pod", async ({
    makeAgent,
    makeAdmin,
    makeMember,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const started = await runnable({
      makeAgent,
      makeAdmin,
      makeMember,
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    });
    vi.spyOn(openappa, "startRuntimeChild").mockRejectedValue(
      new ApiError(409, "spawn refused"),
    );

    await expect(
      runTaskInAgentRuntime({
        ...started.params,
        runtimeCrossing: crossing(true, started.organizationId),
      }),
    ).rejects.toThrow("protected runtime could not be bound");
    expect(backend.launch).not.toHaveBeenCalled();
    expect(backend.stageInputs).not.toHaveBeenCalled();
  });

  test("an unbound human start does not bind a parent", async ({
    makeAgent,
    makeAdmin,
    makeMember,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const started = await runnable({
      makeAgent,
      makeAdmin,
      makeMember,
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const bind = vi.spyOn(openappa, "startRuntimeChild");

    await expect(runTaskInAgentRuntime(started.params)).rejects.toThrow(
      "stop after start",
    );
    expect(bind).not.toHaveBeenCalled();
    expect(backend.launch).toHaveBeenCalled();
  });

  test("a resumed session keeps its parent and addresses before the prompt", async ({
    makeAgent,
    makeAdmin,
    makeMember,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const started = await runnable({
      makeAgent,
      makeAdmin,
      makeMember,
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      resume: true,
    });
    await bindChild(started);
    const order: string[] = [];
    const bind = vi.spyOn(openappa, "startRuntimeChild");
    vi.spyOn(openappa, "addressRuntimeChild").mockImplementation(async () => {
      order.push("address");
    });
    vi.spyOn(backend, "continueRun").mockImplementation(async () => {
      order.push("continue");
    });

    await expect(
      runTaskInAgentRuntime({
        ...started.params,
        resumeFromTaskId: started.previousTaskId,
        runtimeCrossing: crossing(false, started.organizationId),
      }),
    ).rejects.toThrow("stop after start");

    expect(bind).not.toHaveBeenCalled();
    expect(order[0]).toBe("address");
    expect(order).toContain("continue");
    expect(order.indexOf("address")).toBeLessThan(order.indexOf("continue"));
  });

  test("a wrong parent is not attached to an opened root", async ({
    makeAgent,
    makeAdmin,
    makeMember,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const started = await runnable({
      makeAgent,
      makeAdmin,
      makeMember,
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      resume: true,
    });
    await bindChild(started, null);
    vi.spyOn(openappa, "addressRuntimeChild");

    await expect(
      runTaskInAgentRuntime({
        ...started.params,
        resumeFromTaskId: started.previousTaskId,
        runtimeCrossing: crossing(false, started.organizationId),
      }),
    ).rejects.toThrow("opened without a parent");
    expect(openappa.addressRuntimeChild).not.toHaveBeenCalled();
    expect(backend.continueRun).not.toHaveBeenCalled();
  });

  afterEach(async () => {
    await drainBackgroundWork();
    config.agentRuntime.platformBaseUrl = originalBaseUrl;
    config.openappa.enabled = originalOpenappa;
  });
});

describe("model-facing runtime tools", () => {
  beforeEach(async () => {
    vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
    config.openappa.enabled = true;
    await GuardrailsDeploymentModel.setEnabled(true);
  });

  test("no proof starts an unbound run when unrecognized clients are allowed", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const started = await startWithoutProof({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
      seedAndAssignArchestraTools,
    });

    expect(started.result.isError).not.toBe(true);
    expect(started.result.structuredContent).toMatchObject({
      runtime: "dedicated",
      session_id: started.task.id,
    });
    expect(started.starts).toHaveLength(1);
    expect(started.starts[0].systemParams).not.toHaveProperty(
      "runtimeCrossing",
    );
  });

  test("no proof starts nothing when unrecognized clients are blocked", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    await GuardrailsDeploymentModel.set({ unsupportedClientAction: "block" });

    const started = await startWithoutProof({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
      seedAndAssignArchestraTools,
    });

    expect(started.result.isError).toBe(true);
    expect(JSON.stringify(started.result.content)).toContain(
      "ask an administrator to allow unrecognized clients",
    );
    expect(started.starts).toHaveLength(0);
  });

  test("no proof reads and steers a run that has no parent", async ({
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
      parentId: null,
    });
    await db.insert(schema.a2aArtifactsTable).values({
      taskId: seeded.task.id,
      name: "agent-response",
      parts: [{ text: "RAW ARTIFACT" }],
    });
    const steer = vi.spyOn(backend, "steer").mockResolvedValue();
    const context = { ...seeded.context, openappaRuntimeCall: undefined };

    const read = await executeArchestraTool(
      TOOL_GET_RUN_FULL_NAME,
      { task_id: seeded.task.id },
      context,
    );
    const steered = await executeArchestraTool(
      TOOL_STEER_RUN_FULL_NAME,
      { task_id: seeded.task.id, message: "Carry on" },
      context,
    );

    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toMatchObject({ output: "RAW ARTIFACT" });
    expect(steered.isError).not.toBe(true);
    expect(steer).toHaveBeenCalledOnce();
  });

  test("no proof does not read, steer or write a run bound to a parent", async ({
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
    await db.insert(schema.a2aArtifactsTable).values({
      taskId: seeded.task.id,
      name: "agent-response",
      parts: [{ text: "RAW ARTIFACT" }],
    });
    const steer = vi.spyOn(backend, "steer").mockResolvedValue();
    const write = vi.spyOn(workspaceFiles, "accessAgentWorkspaceFile");
    const context = { ...seeded.context, openappaRuntimeCall: undefined };

    const read = await executeArchestraTool(
      TOOL_GET_RUN_FULL_NAME,
      { task_id: seeded.task.id },
      context,
    );
    const steered = await executeArchestraTool(
      TOOL_STEER_RUN_FULL_NAME,
      { task_id: seeded.task.id, message: "SECRET STEER" },
      context,
    );
    const written = await executeArchestraTool(
      TOOL_WRITE_WORKSPACE_FILE_FULL_NAME,
      { task_id: seeded.task.id, path: "note.txt", content: "SECRET FILE" },
      context,
    );

    for (const result of [read, steered, written]) {
      expect(result.isError).toBe(true);
      // Without a proof the gateway cannot tell the parent from a stranger,
      // so the refusal names the missing proof rather than another session.
      expect(JSON.stringify(result)).toContain(
        "carried no proof of its source",
      );
      expect(JSON.stringify(result)).not.toContain("different session");
    }
    expect(JSON.stringify(read)).not.toContain("RAW ARTIFACT");
    expect(steer).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  test("a classified spawn that resolves in-process is refused", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const actor = await makeUser();
    const org = await makeOrganization();
    await makeMember(actor.id, org.id, { role: "member" });
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: actor.id,
    });

    await releasedSpawn(org.id);

    const result = await startDelegatedTask({
      agentId: agent.id,
      message: "Do the work",
      context: {
        agent: { id: agent.id, name: agent.name },
        userId: actor.id,
        organizationId: org.id,
        openappaRuntimeCall: {
          session: proofSession(org.id),
          toolCallId: "call-1",
          spawn: true,
        },
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "no longer the resolved target",
    );
    expect(await recordedLaunch(org.id)).toEqual({
      kind: "failed",
      reason: "refused",
    });
  });

  // The proxy tells the model what the gateway recorded for the call, so the
  // record must exist before the client gets the result.
  test("records the run that a released launch started", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const actor = await makeUser();
    const org = await makeOrganization();
    await makeMember(actor.id, org.id, { role: "member" });
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: actor.id,
      runtime: runtimeConfig(),
    });
    await releasedSpawn(org.id);
    // The launch itself is not under test, and a real one would outlive it.
    const a2aContext = await A2AContextModel.create({
      actorKind: "user",
      actorId: actor.id,
    });
    const task = await A2ATaskModel.create({
      contextId: a2aContext.id,
      agentId: agent.id,
      state: "TASK_STATE_SUBMITTED",
    });
    vi.spyOn(startTask, "startDetachedAgentTask").mockResolvedValue(task);

    const result = await startDelegatedTask({
      agentId: agent.id,
      message: "Do the work",
      context: {
        agent: { id: agent.id, name: agent.name },
        userId: actor.id,
        organizationId: org.id,
        openappaRuntimeCall: {
          session: proofSession(org.id),
          toolCallId: "call-1",
          spawn: true,
        },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(await recordedLaunch(org.id)).toEqual({
      kind: "launched",
      session_id: task.id,
      state: "submitted",
    });
  });

  test("records that a launch needs credentials, with the setup link", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const actor = await makeUser();
    const org = await makeOrganization();
    await makeMember(actor.id, org.id, { role: "member" });
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: actor.id,
      runtime: {
        ...runtimeConfig(),
        credentials: [
          {
            key: "GITHUB_TOKEN",
            label: "GitHub token",
            scope: "per_user",
            required: true,
          },
        ],
      },
    });
    await releasedSpawn(org.id);

    const result = await startDelegatedTask({
      agentId: agent.id,
      message: "Do the work",
      context: {
        agent: { id: agent.id, name: agent.name },
        userId: actor.id,
        organizationId: org.id,
        openappaRuntimeCall: {
          session: proofSession(org.id),
          toolCallId: "call-1",
          spawn: true,
        },
      },
    });

    expect(result.isError).toBe(true);
    expect(await recordedLaunch(org.id)).toEqual({
      kind: "failed",
      reason: "credentials_needed",
      setup_url: expect.stringContaining(
        `/agents/${agent.id}?setup=credentials&keys=GITHUB_TOKEN`,
      ),
    });
  });

  test("a parent gets only the exact admitted turn value", async ({
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
    await db.insert(schema.a2aArtifactsTable).values({
      taskId: seeded.task.id,
      name: "agent-response",
      parts: [{ text: "RAW ARTIFACT" }],
    });
    vi.spyOn(openappa, "loadChildReturns").mockResolvedValue([
      {
        childSessionId: seeded.child.session_id,
        operationId: `runtime-return:${seeded.task.id}:new`,
        value: "ADMITTED",
      },
      {
        childSessionId: seeded.child.session_id,
        operationId: "file-read",
        value: "NOT A TURN",
      },
      {
        childSessionId: seeded.child.session_id,
        operationId: `runtime-return:${seeded.task.id}:old`,
        value: "STALE",
      },
    ]);

    const result = await executeArchestraTool(
      TOOL_GET_RUN_FULL_NAME,
      { task_id: seeded.task.id },
      seeded.context,
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      output: "ADMITTED",
      output_truncated: false,
      requests: [],
    });
    expect(JSON.stringify(result)).not.toContain("RAW ARTIFACT");
    expect(JSON.stringify(result)).not.toContain("STALE");
  });

  test("an oversized admitted value is withheld whole", async ({
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
    vi.spyOn(openappa, "loadChildReturns").mockResolvedValue([
      {
        childSessionId: seeded.child.session_id,
        operationId: `runtime-return:${seeded.task.id}:big`,
        value: "x".repeat(20_001),
      },
    ]);

    const result = await executeArchestraTool(
      TOOL_GET_RUN_FULL_NAME,
      { task_id: seeded.task.id },
      seeded.context,
    );

    expect(JSON.stringify(result)).toContain("not truncated");
    expect(JSON.stringify(result)).not.toContain("x".repeat(40));
  });

  test("a different session of the same user does not receive raw output", async ({
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
    await db.insert(schema.a2aArtifactsTable).values({
      taskId: seeded.task.id,
      name: "agent-response",
      parts: [{ text: "RAW ARTIFACT" }],
    });

    const result = await executeArchestraTool(
      TOOL_GET_RUN_FULL_NAME,
      { task_id: seeded.task.id },
      {
        ...seeded.context,
        openappaRuntimeCall: {
          session: {
            ...proofSession(seeded.organizationId),
            session_id: OTHER,
          },
          toolCallId: "call-other",
          spawn: false,
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("RAW ARTIFACT");
    expect(JSON.stringify(result)).toContain("different session");
  });

  test("a refused steer or write does not inject bytes", async ({
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
    vi.spyOn(openappa, "addressRuntimeChild").mockRejectedValue(
      new ApiError(409, "label refused"),
    );
    const write = vi.spyOn(workspaceFiles, "accessAgentWorkspaceFile");
    const steer = vi.spyOn(backend, "steer").mockResolvedValue();

    const steered = await executeArchestraTool(
      TOOL_STEER_RUN_FULL_NAME,
      { task_id: seeded.task.id, message: "SECRET STEER" },
      seeded.context,
    );
    const written = await executeArchestraTool(
      TOOL_WRITE_WORKSPACE_FILE_FULL_NAME,
      {
        task_id: seeded.task.id,
        path: "note.txt",
        content: "SECRET FILE",
      },
      seeded.context,
    );

    expect(steered.isError).toBe(true);
    expect(written.isError).toBe(true);
    expect(steer).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(JSON.stringify(steered)).not.toContain("SECRET STEER");
    expect(JSON.stringify(written)).not.toContain("SECRET FILE");
  });
});

describe("crossRuntimeOutput", () => {
  test("returns the latest admitted value and narrows the native lookup to this child and task", async ({
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
    const lookup = vi.spyOn(openappa, "loadChildReturns").mockResolvedValue([
      {
        childSessionId: seeded.child.session_id,
        operationId: `runtime-return:${seeded.task.id}:new`,
        value: "newest admitted answer",
      },
      {
        childSessionId: seeded.child.session_id,
        operationId: `runtime-return:${seeded.task.id}:old`,
        value: "older answer",
      },
    ]);
    const call = seeded.context.openappaRuntimeCall;
    if (!call) throw new Error("The fixture has no authenticated source");
    await expect(
      crossRuntimeOutput({
        organizationId: seeded.organizationId,
        workspaceId: seeded.task.id,
        taskId: seeded.task.id,
        crossing: {
          source: call.session,
          callId: call.toolCallId,
          spawn: false,
        },
      }),
    ).resolves.toEqual({ kind: "admitted", value: "newest admitted answer" });
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: seeded.child.session_id,
        operationPrefix: `runtime-return:${seeded.task.id}:`,
      }),
    );
  });

  test("ignores a return that is not this turn", async ({
    makeAgent,
    makeAdmin,
    makeMember,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const started = await runnable({
      makeAgent,
      makeAdmin,
      makeMember,
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
      resume: true,
    });
    await bindChild(started);
    vi.spyOn(openappa, "loadChildReturns").mockResolvedValue([
      {
        childSessionId: started.childSessionId,
        operationId: "runtime-return:other-task:1",
        value: "OTHER",
      },
    ]);

    await expect(
      crossRuntimeOutput({
        crossing: crossing(false, started.organizationId),
        organizationId: started.organizationId,
        workspaceId: started.workspaceId,
        taskId: started.taskId,
      }),
    ).resolves.toMatchObject({ kind: "withheld" });
  });
});

function crossing(spawn: boolean, organizationId: string) {
  return {
    source: proofSession(organizationId),
    callId: "call-1",
    spawn,
  };
}

function proofSession(organizationId: string) {
  return {
    organization_id: organizationId,
    caller_id: "user:parent",
    session_id: PARENT,
  };
}

/** The released `call-1` spawn of the proof session, as the proxy leaves it. */
async function releasedSpawn(organizationId: string) {
  const session = proofSession(organizationId);
  await db.insert(schema.openappaSessionsTable).values({
    organizationId,
    callerId: session.caller_id,
    sessionId: session.session_id,
    actor: openappaActor(session.session_id),
    root: openappaActor(session.session_id),
    parentId: null,
    startDecision: { decision: "ack" },
  });
  await db.insert(schema.openappaOperationsTable).values({
    organizationId,
    callerId: session.caller_id,
    sessionId: session.session_id,
    operationId: "call:call-1",
    root: openappaActor(session.session_id),
    status: "complete",
    input: {
      semantic: {
        event: "tool_call",
        tool: "archestra__start_run",
        spawn: true,
      },
    },
    decision: { decision: "allow_call" },
  });
}

async function recordedLaunch(organizationId: string) {
  const session = proofSession(organizationId);
  const launches = await OpenAppaSpawnCorrelationModel.runtimeLaunches({
    organizationId,
    callerId: session.caller_id,
    sessionId: session.session_id,
    toolCallIds: ["call-1"],
  });
  return launches.get("call-1");
}

function runtimeConfig() {
  return {
    image: "runtime:test",
    command: null,
    inferenceProtocol: "openai_chat" as const,
    backend: "kubernetes" as const,
    steerMode: "tmux_keys" as const,
    privileged: false,
    resources: null,
    environment: null,
    credentials: null,
    ttlHours: 1,
    idleTimeoutMinutes: 5,
  };
}

for (const transformed of [false, true]) {
  test(`a protected transfer releases only the exact pinned bytes (transformed=${transformed})`, async ({
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
    const bytes = Buffer.from("private pinned report");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    vi.spyOn(backend, "runWorkspaceTransferCommand").mockResolvedValue({
      transfer_id: "snapshot-one",
      path: "report.txt",
      size: bytes.length,
      sha256,
      mtime_ns: "1",
      ino: "1",
    });
    vi.spyOn(backend, "readWorkspaceTransferRange").mockImplementation(
      async () => ({
        stdout: Readable.from([bytes]),
        completed: Promise.resolve(),
      }),
    );
    const crossing = vi
      .spyOn(openappa, "returnRuntimeValue")
      .mockImplementation(async ({ value }) => ({
        kind: "admitted",
        value: transformed ? "approved digest only" : value,
      }));
    const transfer = workspaceTransferTickets.mintDownload({
      actor: {
        kind: "user",
        id: seeded.context.userId,
        organizationId: seeded.organizationId,
      },
      taskId: seeded.task.id,
      path: "report.txt",
      crossing: { child: seeded.child, operationId: "export-call" },
    });
    if (transformed)
      await expect(transfer).rejects.toThrow("not admitted unchanged");
    else {
      const minted = await transfer;
      expect(minted).toMatchObject({ ticket: { sha256, size: bytes.length } });
      expect(minted.ticket).not.toHaveProperty("admittedBytes");
      bytes.fill(0);
      vi.mocked(backend.readWorkspaceTransferRange).mockRejectedValue(
        new Error("the runtime snapshot changed"),
      );
      const stream = await workspaceTransferTickets.read({
        ticket: workspaceTransferTickets.resolve(
          minted.ticket.id,
          minted.token,
        ),
        offset: 8,
        length: 6,
      });
      const chunks: Buffer[] = [];
      for await (const chunk of stream.stdout) chunks.push(Buffer.from(chunk));
      await stream.completed;
      expect(Buffer.concat(chunks).toString()).toBe("pinned");
      expect(backend.readWorkspaceTransferRange).toHaveBeenCalledOnce();
    }
    expect(JSON.parse(crossing.mock.calls[0][0].value)).toEqual({
      path: "report.txt",
      encoding: "utf8",
      content: "private pinned report",
      sha256,
    });
    expect(crossing.mock.calls[0][0].session).toEqual(seeded.child);
  });
}

test("a protected export above the inline size crosses chunk by chunk and is served only from verified chunks", async ({
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
  const chunk = 4 * 1024 * 1024;
  const size = chunk + 5;
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < chunk; i += 4099) bytes[i] = (i * 31) & 0xff;
  bytes.write("tail!", chunk);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  vi.spyOn(backend, "runWorkspaceTransferCommand").mockResolvedValue({
    transfer_id: "big",
    path: "report.bin",
    size,
    sha256,
    mtime_ns: "1",
    ino: "1",
  });
  vi.spyOn(backend, "readWorkspaceTransferRange").mockImplementation(
    async ({ offset, length }) => ({
      stdout: Readable.from([
        bytes.subarray(offset, length < 0 ? undefined : offset + length),
      ]),
      completed: Promise.resolve(),
    }),
  );
  const crossing = vi
    .spyOn(openappa, "returnRuntimeValue")
    .mockImplementation(async ({ value }) => ({ kind: "admitted", value }));
  const minted = await workspaceTransferTickets.mintDownload({
    actor: {
      kind: "user",
      id: seeded.context.userId,
      organizationId: seeded.organizationId,
    },
    taskId: seeded.task.id,
    path: "report.bin",
    crossing: { child: seeded.child, operationId: "big-export" },
  });
  expect(minted.ticket).toMatchObject({ sha256, size });
  expect(minted.ticket).not.toHaveProperty("admittedBytes");
  // Every byte crossed as content, in order, each chunk naming its digest.
  expect(crossing.mock.calls.map((call) => call[0].operationId)).toEqual([
    `file-export:big-export:${sha256}:0/2`,
    `file-export:big-export:${sha256}:1/2`,
  ]);
  const tail = JSON.parse(crossing.mock.calls[1][0].value);
  expect(tail).toMatchObject({
    path: "report.bin",
    encoding: "base64",
    sha256,
    chunk: {
      index: 1,
      count: 2,
      sha256: createHash("sha256").update("tail!").digest("hex"),
    },
  });
  expect(Buffer.from(tail.content, "base64").toString()).toBe("tail!");
  // The snapshot stays pinned: it is what the download is served from.
  expect(backend.runWorkspaceTransferCommand).not.toHaveBeenCalledWith(
    expect.objectContaining({ args: ["discard", "big"] }),
  );
  const ticket = workspaceTransferTickets.resolve(
    minted.ticket.id,
    minted.token,
  );
  const across = await workspaceTransferTickets.read({
    ticket,
    offset: chunk - 3,
    length: -1,
  });
  const parts: Buffer[] = [];
  for await (const part of across.stdout) parts.push(Buffer.from(part));
  await across.completed;
  expect(Buffer.concat(parts).equals(bytes.subarray(chunk - 3))).toBe(true);
  // A runtime that rewrites the snapshot after admission releases nothing.
  bytes[chunk + 2] ^= 0xff;
  const tampered = await workspaceTransferTickets.read({
    ticket,
    offset: chunk,
    length: 2,
  });
  await expect(
    (async () => {
      for await (const _part of tampered.stdout) {
        // drain
      }
    })(),
  ).rejects.toThrow("no longer matches its admitted bytes");
});

test("the transfer tool reports a held export with the Guardrails ruling, not an internal error", async ({
  makeAgent,
  makeMember,
  makeOrganization,
  makeUser,
  seedAndAssignArchestraTools,
}) => {
  await GuardrailsDeploymentModel.setEnabled(true);
  config.openappa.enabled = true;
  const seeded = await seededRun({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  });
  const bytes = Buffer.from("progress while a tool runs");
  vi.spyOn(backend, "runWorkspaceTransferCommand").mockResolvedValue({
    transfer_id: "busy",
    path: "reports/progress.md",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mtime_ns: "1",
    ino: "1",
  });
  vi.spyOn(backend, "readWorkspaceTransferRange").mockResolvedValue({
    stdout: Readable.from([bytes]),
    completed: Promise.resolve(),
  });
  vi.spyOn(openappa, "returnRuntimeValue").mockResolvedValue({
    kind: "held",
    reason:
      "the child has a call still open; report its outcome before the child ends",
  });

  const result = await executeArchestraTool(
    TOOL_TRANSFER_WORKSPACE_FILE_FULL_NAME,
    {
      task_id: seeded.task.id,
      direction: "download",
      path: "reports/progress.md",
      local_path: "/tmp/progress.md",
    },
    seeded.context,
  );

  expect(result.isError).toBe(true);
  const text = JSON.stringify(result.content);
  expect(text).toContain("Guardrails ruling: the child has a call still open");
  expect(text).toContain("No download ticket was issued");
  expect(text).not.toContain("internal error");
});

test("a held protected export names the Guardrails ruling and issues no ticket", async ({
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
  const bytes = Buffer.from("held report");
  vi.spyOn(backend, "runWorkspaceTransferCommand").mockResolvedValue({
    transfer_id: "held",
    path: "report.txt",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mtime_ns: "1",
    ino: "1",
  });
  vi.spyOn(backend, "readWorkspaceTransferRange").mockResolvedValue({
    stdout: Readable.from([bytes]),
    completed: Promise.resolve(),
  });
  vi.spyOn(openappa, "returnRuntimeValue").mockResolvedValue({
    kind: "held",
    reason: "ruling-sentinel: allowed readers would narrow",
  });
  await expect(
    workspaceTransferTickets.mintDownload({
      actor: {
        kind: "user",
        id: seeded.context.userId,
        organizationId: seeded.organizationId,
      },
      taskId: seeded.task.id,
      path: "report.txt",
      crossing: { child: seeded.child, operationId: "held-export" },
    }),
  ).rejects.toThrow("ruling-sentinel: allowed readers would narrow");
  expect(backend.runWorkspaceTransferCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({ args: ["discard", "held"] }),
  );
});

// The gateway lists only some runtime tools, so a connected client reaches the
// others through `run_tool`, with the proof inside `tool_args`.
test.for([
  false,
  true,
])("a signed released get_run proof executes once and replay cannot read the runtime again (wrapped=%s)", async (wrapped, {
  makeAgent,
  makeMember,
  makeOrganization,
  makeUser,
  seedAndAssignArchestraTools,
}) => {
  await GuardrailsDeploymentModel.setEnabled(true);
  config.openappa.enabled = true;
  const seeded = await seededRun({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  });
  const session = {
    organization_id: seeded.organizationId,
    caller_id: `user:${seeded.context.userId}`,
    session_id: PARENT,
  };
  await db.insert(schema.openappaSessionsTable).values({
    organizationId: seeded.organizationId,
    callerId: session.caller_id,
    sessionId: PARENT,
    actor: openappaActor(PARENT),
    root: openappaActor(PARENT),
    parentId: null,
    startDecision: { decision: "ack" },
  });
  await db.insert(schema.openappaOperationsTable).values({
    organizationId: seeded.organizationId,
    callerId: session.caller_id,
    sessionId: PARENT,
    operationId: "call:signed-get-run",
    root: openappaActor(PARENT),
    status: "complete",
    input: {
      semantic: {
        event: "tool_call",
        tool: "archestra__get_run",
        spawn: false,
      },
    },
    decision: { decision: "allow_call" },
  });
  const prior = config.openappa.offerSigningSecret;
  config.openappa.offerSigningSecret = "synthetic-runtime-dispatch-test-secret";
  try {
    const args = { task_id: seeded.task.id };
    const proof = signRuntimeToolProof({
      session,
      toolCallId: "signed-get-run",
      action: "get_run",
      arguments: args,
      spawn: false,
      secret: config.openappa.offerSigningSecret,
    });
    if (!proof) throw new Error("The fixture has no source proof");
    const read = vi.spyOn(openappa, "loadChildReturns").mockResolvedValue([
      {
        childSessionId: seeded.child.session_id,
        operationId: `runtime-return:${seeded.task.id}:checked`,
        value: "checked answer",
      },
    ]);
    const context = { ...seeded.context, openappaRuntimeCall: undefined };
    const signed = { ...args, runtime_proof: proof };
    const dispatch = () =>
      wrapped
        ? executeArchestraTool(
            TOOL_RUN_TOOL_FULL_NAME,
            { tool_name: TOOL_GET_RUN_FULL_NAME, tool_args: signed },
            context,
          )
        : executeArchestraTool(TOOL_GET_RUN_FULL_NAME, signed, context);
    const first = await dispatch();
    expect(JSON.stringify(first.content)).toContain("checked answer");
    const replay = await dispatch();
    expect(replay.isError).toBe(true);
    expect(JSON.stringify(replay.content)).toContain("already claimed");
    expect(read).toHaveBeenCalledOnce();
  } finally {
    config.openappa.offerSigningSecret = prior;
  }
});

test("a held file carries the Guardrails ruling with its refusal", async () => {
  vi.spyOn(openappa, "returnRuntimeValue").mockResolvedValue({
    kind: "held",
    reason: "ruling-sentinel: allowed readers would narrow",
  });
  const result = crossRuntimeFile({
    child: {
      organization_id: "qa-org",
      session_id: "qa-child",
      parent_id: "qa-parent",
    },
    operationId: "qa-held",
    value: "private file bytes",
  });
  await expect(result).rejects.toThrow("protected file could not be admitted");
  await result.catch((error: Error) => {
    expect(error.message).toContain(
      "Guardrails ruling: ruling-sentinel: allowed readers would narrow",
    );
    expect(error.message).not.toContain("private file bytes");
  });
});

async function runnable(params: {
  makeAgent: (overrides: Record<string, unknown>) => Promise<Agent>;
  makeAdmin: () => Promise<{ id: string }>;
  makeMember: (
    userId: string,
    organizationId: string,
    role: { role: "admin" },
  ) => Promise<unknown>;
  makeOrganization: () => Promise<{ id: string }>;
  makeSecret: (overrides: {
    secret: { apiKey: string };
  }) => Promise<{ id: string }>;
  makeLlmProviderApiKey: (
    organizationId: string,
    secretId: string,
    overrides: { provider: "openai" },
  ) => Promise<{ id: string }>;
  resume?: boolean;
}) {
  const org = await params.makeOrganization();
  const user = await params.makeAdmin();
  await params.makeMember(user.id, org.id, { role: "admin" });
  const secret = await params.makeSecret({
    secret: { apiKey: "test-upstream-key" },
  });
  const key = await params.makeLlmProviderApiKey(org.id, secret.id, {
    provider: "openai",
  });
  const model = await ModelModel.create({
    externalId: `openai/runtime-crossing-${crypto.randomUUID()}`,
    provider: "openai",
    modelId: "test-model",
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalling: true,
    lastSyncedAt: new Date(),
  });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [model.id]);
  const agent = await params.makeAgent({
    organizationId: org.id,
    authorId: user.id,
    agentType: "agent",
    modelId: model.id,
    llmApiKeyId: key.id,
  });
  const runtime: ResolvedAgentRuntime = {
    agentId: agent.id,
    organizationId: org.id,
    environmentId: null,
    secretId: null,
    image: "runtime:test",
    command: null,
    inferenceProtocol: "openai_chat",
    backend: "kubernetes",
    steerMode: "tmux_keys",
    privileged: false,
    resources: null,
    environment: null,
    credentials: null,
    ttlHours: null,
    maxCostUsd: null,
    idleTimeoutMinutes: null,
  };
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const task = await A2ATaskModel.createForRun({
    contextId: context.id,
    agentId: agent.id,
  });
  const previousTask = params.resume
    ? await A2ATaskModel.createForRun({
        contextId: context.id,
        agentId: agent.id,
      })
    : null;
  let workspaceId = task.id;
  if (previousTask) {
    const scope = backend.resolveRuntimeScope({});
    const previous = await AgentRunModel.create({
      organizationId: org.id,
      agentId: agent.id,
      taskId: previousTask.id,
      actorKind: "user",
      actorId: user.id,
      actorUserId: user.id,
      backend: "kubernetes",
      runtimeScope: scope,
      workloadName: `kept-${previousTask.id}`,
    });
    await AgentRunModel.close({ id: previous.id });
    const workspace = await AgentWorkspaceModel.create({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: user.id,
      backend: "kubernetes",
      runtimeScope: scope,
      workloadName: previous.workloadName,
      state: "idle",
      lastTaskId: previousTask.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    workspaceId = workspace.id;
  }
  const child = runtimeOpenAppaSession({
    organizationId: org.id,
    workspaceId,
    workloadName: previousTask
      ? `kept-${previousTask.id}`
      : `unused-${task.id}`,
    actorKind: "user",
    actorId: user.id,
  });
  return {
    organizationId: org.id,
    workspaceId,
    taskId: task.id,
    previousTaskId: previousTask?.id,
    childSessionId: child.session_id,
    child,
    userId: user.id,
    params: {
      runtime,
      taskId: task.id,
      agentId: agent.id,
      actor: {
        kind: "user" as const,
        id: user.id,
        organizationId: org.id,
      },
      organizationId: org.id,
      runMode: "one_shot" as const,
      task: "Do the work",
      modelId: model.id,
      llmApiKeyId: null,
    },
  };
}

async function bindChild(
  started: Awaited<ReturnType<typeof runnable>>,
  parentId: string | null = PARENT,
) {
  await db.insert(schema.openappaSessionsTable).values({
    actor: openappaActor(started.child.session_id),
    root: openappaActor(parentId ?? started.child.session_id),
    organizationId: started.organizationId,
    callerId: started.child.caller_id,
    sessionId: started.child.session_id,
    parentId,
    startDecision: { decision: "ack" },
  });
}

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
  /** The session the run is bound to; null leaves it without a parent. */
  parentId?: string | null;
}) {
  // This fixture fakes execution I/O; availability must not depend on a host kubeconfig.
  vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
  const actor = await params.makeUser();
  const org = await params.makeOrganization();
  await params.makeMember(actor.id, org.id, { role: "member" });
  const agent = await params.makeAgent({
    organizationId: org.id,
    authorId: actor.id,
    runtime: runtimeConfig(),
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
  });
  const parentId = params.parentId === undefined ? PARENT : params.parentId;
  if (parentId) {
    await db.insert(schema.openappaSessionsTable).values({
      actor: openappaActor(child.session_id),
      root: openappaActor(parentId),
      organizationId: org.id,
      callerId: child.caller_id,
      sessionId: child.session_id,
      parentId,
      startDecision: { decision: "ack" },
    });
  }
  return {
    task,
    child,
    organizationId: org.id,
    context: {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      userId: actor.id,
      organizationId: org.id,
      openappaRuntimeCall: {
        session: { ...proofSession(org.id), organization_id: org.id },
        toolCallId: "call-1",
        spawn: false,
      },
    },
  };
}

/** Calls start_run with no proof; the launch seam is replaced, not the gate. */
async function startWithoutProof(params: {
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
    runtime: runtimeConfig(),
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
  const start = vi
    .spyOn(startTask, "startDetachedAgentTask")
    .mockResolvedValue(task);
  try {
    const result = await executeArchestraTool(
      TOOL_START_RUN_FULL_NAME,
      { agent_id: agent.id, message: "Do the work" },
      {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        userId: actor.id,
        organizationId: org.id,
      },
    );
    return { result, task, starts: start.mock.calls.map(([call]) => call) };
  } finally {
    // The shared setup clears calls but keeps implementations.
    start.mockRestore();
  }
}
