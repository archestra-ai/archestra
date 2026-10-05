import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  TOOL_GET_RUN_FULL_NAME,
  TOOL_START_RUN_FULL_NAME,
  TOOL_STEER_RUN_FULL_NAME,
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
const OTHER = "user:parent|other-session";

describe("runtime crossing", () => {
  const originalBaseUrl = config.agentRuntime.platformBaseUrl;
  const originalRuntime = config.agentRuntime.enabled;
  const originalOpenappa = config.openappa.enabled;

  beforeEach(async () => {
    config.agentRuntime.platformBaseUrl = "http://platform.test";
    config.agentRuntime.enabled = true;
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
    config.agentRuntime.enabled = originalRuntime;
    config.openappa.enabled = originalOpenappa;
  });
});

describe("model-facing runtime tools", () => {
  beforeEach(async () => {
    config.openappa.enabled = true;
    config.agentRuntime.enabled = true;
    await GuardrailsDeploymentModel.setEnabled(true);
  });

  test("no proof refuses a runtime start", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const actor = await makeUser();
    const org = await makeOrganization();
    await makeMember(actor.id, org.id, { role: "member" });
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: actor.id,
      runtime: runtimeConfig(),
    });
    await seedAndAssignArchestraTools(agent.id);
    const launch = vi.spyOn(backend, "launch");

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

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Error: This runtime crossing has no verified source. The request was not sent.",
      },
    ]);
    expect(launch).not.toHaveBeenCalled();
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

test("an oversized protected export reads no bytes and issues no ticket", async ({
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
  vi.spyOn(backend, "runWorkspaceTransferCommand").mockResolvedValue({
    transfer_id: "oversized",
    path: "report.bin",
    size: 4 * 1024 * 1024 + 1,
    sha256: "0".repeat(64),
    mtime_ns: "1",
    ino: "1",
  });
  const reader = vi.spyOn(backend, "readWorkspaceTransferRange");
  const crossing = vi.spyOn(openappa, "returnRuntimeValue");
  await expect(
    workspaceTransferTickets.mintDownload({
      actor: {
        kind: "user",
        id: seeded.context.userId,
        organizationId: seeded.organizationId,
      },
      taskId: seeded.task.id,
      path: "report.bin",
      crossing: { child: seeded.child, operationId: "oversized-export" },
    }),
  ).rejects.toThrow("limited to 4 MiB");
  expect(reader).not.toHaveBeenCalled();
  expect(crossing).not.toHaveBeenCalled();
  expect(backend.runWorkspaceTransferCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({ args: ["discard", "oversized"] }),
  );
});

test("a signed released get_run proof executes once and replay cannot read the runtime again", async ({
  makeAgent,
  makeMember,
  makeOrganization,
  makeUser,
  seedAndAssignArchestraTools,
}) => {
  await GuardrailsDeploymentModel.setEnabled(true);
  config.openappa.enabled = true;
  config.agentRuntime.enabled = true;
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
    const first = await executeArchestraTool(
      TOOL_GET_RUN_FULL_NAME,
      { ...args, runtime_proof: proof },
      context,
    );
    expect(JSON.stringify(first.content)).toContain("checked answer");
    const replay = await executeArchestraTool(
      TOOL_GET_RUN_FULL_NAME,
      { ...args, runtime_proof: proof },
      context,
    );
    expect(replay.isError).toBe(true);
    expect(JSON.stringify(replay.content)).toContain("already claimed");
    expect(read).toHaveBeenCalledOnce();
  } finally {
    config.openappa.offerSigningSecret = prior;
  }
});

test("a held file returns a generic refusal without private native diagnostics", async () => {
  vi.spyOn(openappa, "returnRuntimeValue").mockResolvedValue({
    kind: "held",
    reason: "private-diagnostic-qa-sentinel",
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
  await result.catch((error: Error) =>
    expect(error.message).not.toContain("private-diagnostic-qa-sentinel"),
  );
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
  await db.insert(schema.openappaSessionsTable).values({
    actor: openappaActor(child.session_id),
    root: openappaActor(PARENT),
    organizationId: org.id,
    callerId: child.caller_id,
    sessionId: child.session_id,
    parentId: PARENT,
    startDecision: { decision: "ack" },
  });
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
