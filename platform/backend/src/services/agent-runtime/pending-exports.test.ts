import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  TOOL_READ_WORKSPACE_FILE_SHORT_NAME,
  TOOL_TRANSFER_WORKSPACE_FILE_SHORT_NAME,
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
import { openappaActor } from "@/openappa/actor";
import * as openappa from "@/openappa/service";
import { kubernetesAgentRuntimeBackendDriver as backend } from "@/services/agent-runtime/backends/kubernetes";
import * as workspaceFiles from "@/services/agent-runtime/workspace-files";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import type { Agent } from "@/types";
import { pendingExports } from "./pending-exports";
import { runtimeOpenAppaSession } from "./runtime-identity";
import { workspaceTransferTickets } from "./workspace-transfers";

setupTestCacheManager();

const PARENT = "user:parent|conversation";
const READ = archestraMcpBranding.getToolName(
  TOOL_READ_WORKSPACE_FILE_SHORT_NAME,
);
const TRANSFER = archestraMcpBranding.getToolName(
  TOOL_TRANSFER_WORKSPACE_FILE_SHORT_NAME,
);
const BUSY = {
  kind: "held" as const,
  reason:
    "the child has a call still open; report its outcome before the child ends",
  busy: true as const,
};

describe("files pinned while their runtime is mid-call", () => {
  const originalOpenappa = config.openappa.enabled;

  beforeEach(async () => {
    config.openappa.enabled = true;
    await GuardrailsDeploymentModel.setEnabled(true);
    vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
  });

  afterEach(() => {
    config.openappa.enabled = originalOpenappa;
  });

  test("a read pinned while the runtime is busy is served once the runtime's next request releases it", async ({
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
    const read = vi
      .spyOn(workspaceFiles, "accessAgentWorkspaceFile")
      .mockResolvedValue(fileResult("progress: step 1"));
    const crossing = vi
      .spyOn(openappa, "returnRuntimeValue")
      .mockResolvedValueOnce(BUSY);

    const pinned = await readFile(seeded);
    expect(pinned.isError).not.toBe(true);
    expect(pinned.structuredContent).toMatchObject({
      status: "pending",
      path: "reports/progress.md",
      sha256: digest("progress: step 1"),
    });
    expect(JSON.stringify(pinned)).not.toContain("progress: step 1");
    expect(JSON.stringify(pinned)).toContain(
      "Call read_workspace_file again with the same arguments",
    );

    // The runtime's next model request: no call open, so the file crosses.
    crossing.mockImplementationOnce(async ({ value }) => ({
      kind: "admitted",
      value,
    }));
    await pendingExports.drain(seeded.child);

    const served = await readFile(seeded);
    expect(served.isError).not.toBe(true);
    expect(served.structuredContent).toMatchObject({
      path: "reports/progress.md",
      encoding: "utf8",
      content: "progress: step 1",
    });
    // The parent gets the version it was told was pinned, read once.
    expect(read).toHaveBeenCalledOnce();
    const operations = crossing.mock.calls.map((call) => call[0].operationId);
    expect(operations[0]).toBe("call-1");
    expect(operations[1]).toMatch(/^file-read:[0-9a-f]+:1$/);
    expect(crossing.mock.calls[1][0].session).toEqual(seeded.child);

    // The entry is gone: the next call reads the file again.
    crossing.mockImplementationOnce(async ({ value }) => ({
      kind: "admitted",
      value,
    }));
    await readFile(seeded);
    expect(read).toHaveBeenCalledTimes(2);
  });

  test("each retry of a pinned read crosses under an operation id no earlier attempt used", async ({
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
    vi.spyOn(workspaceFiles, "accessAgentWorkspaceFile").mockResolvedValue(
      fileResult("partial"),
    );
    const crossing = vi
      .spyOn(openappa, "returnRuntimeValue")
      .mockResolvedValueOnce(BUSY)
      .mockResolvedValueOnce(BUSY)
      .mockResolvedValueOnce(BUSY);

    await readFile(seeded);
    await pendingExports.drain(seeded.child);
    const again = await readFile(seeded);

    expect(again.structuredContent).toMatchObject({ status: "pending" });
    const operations = crossing.mock.calls.map((call) => call[0].operationId);
    expect(new Set(operations).size).toBe(operations.length);
    expect(operations.slice(1)).toEqual([
      expect.stringMatching(/:1$/),
      expect.stringMatching(/:2$/),
    ]);
  });

  test("a pinned read the runtime rules against reaches the parent as the ruling", async ({
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
    vi.spyOn(workspaceFiles, "accessAgentWorkspaceFile").mockResolvedValue(
      fileResult("secret notes"),
    );
    vi.spyOn(openappa, "returnRuntimeValue")
      .mockResolvedValueOnce(BUSY)
      .mockResolvedValueOnce({
        kind: "held",
        reason: "ruling-sentinel: allowed readers would narrow",
      });

    await readFile(seeded);
    await pendingExports.drain(seeded.child);
    const refused = await readFile(seeded);

    expect(refused.isError).toBe(true);
    const text = JSON.stringify(refused.content);
    expect(text).toContain("protected file could not be admitted");
    expect(text).toContain(
      "Guardrails ruling: ruling-sentinel: allowed readers would narrow",
    );
    expect(text).not.toContain("secret notes");
  });

  test("the parent's own retry crosses a pinned read when the runtime has gone idle", async ({
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
    vi.spyOn(workspaceFiles, "accessAgentWorkspaceFile").mockResolvedValue(
      fileResult("final report"),
    );
    vi.spyOn(openappa, "returnRuntimeValue")
      .mockResolvedValueOnce(BUSY)
      .mockImplementationOnce(async ({ value }) => ({
        kind: "admitted",
        value,
      }));

    await readFile(seeded);
    const served = await readFile(seeded);

    expect(served.structuredContent).toMatchObject({
      content: "final report",
    });
  });

  test("a download pinned while the runtime is busy is ticketed from its snapshot after the drain", async ({
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
    const bytes = Buffer.from("deliverable bytes");
    const sha256 = digest(bytes);
    const helper = vi
      .spyOn(backend, "runWorkspaceTransferCommand")
      .mockResolvedValue({
        transfer_id: "pinned",
        path: "out/report.txt",
        size: bytes.length,
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
      .mockResolvedValueOnce(BUSY);

    const pinned = await transfer(seeded);
    expect(pinned.isError).not.toBe(true);
    expect(pinned.structuredContent).toMatchObject({
      status: "pending",
      size: bytes.length,
      sha256,
    });
    expect(JSON.stringify(pinned)).not.toContain("Authorization: Bearer");
    // The pinned version must survive until it is served.
    expect(helper).not.toHaveBeenCalledWith(
      expect.objectContaining({ args: ["discard", "pinned"] }),
    );

    crossing.mockImplementation(async ({ value }) => ({
      kind: "admitted",
      value,
    }));
    await pendingExports.drain(seeded.child);
    const drained = JSON.parse(crossing.mock.calls[1][0].value);
    expect(drained).toMatchObject({
      encoding: "utf8",
      content: "deliverable bytes",
      chunk: { index: 0, count: 1, sha256 },
    });

    const ticketed = await transfer(seeded);
    expect(ticketed.isError).not.toBe(true);
    expect(ticketed.structuredContent).toMatchObject({
      direction: "download",
      sha256,
    });
    const command = String(
      (ticketed.structuredContent as { command: string }).command,
    );
    const ticketId = /\/([0-9a-f]{32})\/content/.exec(command)?.[1];
    const token = /Bearer ([A-Za-z0-9_-]+)/.exec(command)?.[1];
    if (!ticketId || !token) throw new Error("no ticket in the command");
    const stream = await workspaceTransferTickets.read({
      ticket: workspaceTransferTickets.resolve(ticketId, token),
      offset: 0,
      length: -1,
    });
    const parts: Buffer[] = [];
    for await (const part of stream.stdout) parts.push(Buffer.from(part));
    expect(Buffer.concat(parts).toString()).toBe("deliverable bytes");
  });

  test("a drain does not fail the runtime's request when a pinned file cannot be read", async ({
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
    const bytes = Buffer.from("x");
    vi.spyOn(backend, "runWorkspaceTransferCommand").mockResolvedValue({
      transfer_id: "gone",
      path: "out/x",
      size: bytes.length,
      sha256: digest(bytes),
      mtime_ns: "1",
      ino: "1",
    });
    const range = vi
      .spyOn(backend, "readWorkspaceTransferRange")
      .mockResolvedValueOnce({
        stdout: Readable.from([bytes]),
        completed: Promise.resolve(),
      });
    vi.spyOn(openappa, "returnRuntimeValue").mockResolvedValueOnce(BUSY);
    await transfer(seeded);

    range.mockRejectedValue(new Error("pod is gone"));
    await expect(pendingExports.drain(seeded.child)).resolves.toBeUndefined();
  });
});

// =============================================================================
// Helpers
// =============================================================================

function fileResult(text: string) {
  return {
    path: "reports/progress.md",
    size: Buffer.byteLength(text),
    sha256: digest(text),
    content_base64: Buffer.from(text).toString("base64"),
  } as Awaited<ReturnType<typeof workspaceFiles.accessAgentWorkspaceFile>>;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

type Seeded = Awaited<ReturnType<typeof seededRun>>;

function readFile(seeded: Seeded) {
  return executeArchestraTool(
    READ,
    { task_id: seeded.taskId, path: "reports/progress.md" },
    seeded.context,
  );
}

function transfer(seeded: Seeded) {
  return executeArchestraTool(
    TRANSFER,
    {
      task_id: seeded.taskId,
      direction: "download",
      path: "out/report.txt",
      local_path: "/tmp/report.txt",
    },
    seeded.context,
  );
}

/** A user's run whose runtime is bound to the parent session `PARENT`. */
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
    taskId: task.id,
    child,
    context: {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      userId: actor.id,
      organizationId: org.id,
      openappaRuntimeCall: {
        session: {
          organization_id: org.id,
          caller_id: "user:parent",
          session_id: PARENT,
        },
        toolCallId: "call-1",
        spawn: false,
      },
    },
  };
}
