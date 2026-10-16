import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  TOOL_READ_WORKSPACE_FILE_SHORT_NAME,
  TOOL_TRANSFER_WORKSPACE_FILE_SHORT_NAME,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
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
import * as agentRuntimeMetrics from "@/observability/metrics/agent-runtime";
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
const CHUNK = 4 * 1024 * 1024;

describe("files pinned while their runtime is mid-call", () => {
  const originalOpenappa = config.openappa.enabled;

  beforeEach(async () => {
    config.openappa.enabled = true;
    await GuardrailsDeploymentModel.setEnabled(true);
    vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
  });

  afterEach(() => {
    config.openappa.enabled = originalOpenappa;
    vi.useRealTimers();
  });

  test("a read pinned while the runtime is busy tells the parent nothing about the file, then serves what crossed", async ({
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
    const pod = fakePod("progress: step 1");
    const read = vi
      .spyOn(workspaceFiles, "accessAgentWorkspaceFile")
      .mockResolvedValue(fileResult("progress: step 1"));
    const crossing = vi
      .spyOn(openappa, "returnRuntimeValue")
      .mockResolvedValueOnce(BUSY);

    const pinned = await readFile(seeded);
    expect(pinned.isError).not.toBe(true);
    // A busy runtime must not be able to signal through the result.
    expect(pinned.structuredContent).toEqual({
      path: "reports/progress.md",
      status: "pending",
      message: expect.stringContaining(
        "Call read_workspace_file again with the same arguments",
      ),
    });
    expect(JSON.stringify(pinned)).not.toContain("progress: step 1");
    expect(JSON.stringify(pinned)).not.toContain(digest("progress: step 1"));

    // The runtime's next model request: no call open, so the file crosses.
    crossing.mockImplementationOnce(async ({ value }) => ({
      kind: "admitted",
      value,
    }));
    await pendingExports.drain(seeded.child);
    const drained = crossing.mock.calls[1][0];
    expect(drained.session).toEqual(seeded.child);
    expect(drained.value).toBe("progress: step 1");
    expect(drained.operationId).toMatch(/^file-read:[0-9a-f]+:[0-9a-f]+$/);
    // What crossed lives in the runtime's store, and the pin is released.
    expect(pod.discarded).toEqual(["pinned-1"]);
    const store = vi.spyOn(openappa, "loadChildReturns").mockResolvedValue([
      {
        childSessionId: seeded.child.session_id,
        operationId: drained.operationId,
        value: "progress: step 1",
      },
    ]);

    const served = await readFile(seeded);
    expect(served.isError).not.toBe(true);
    expect(served.structuredContent).toMatchObject({
      path: "reports/progress.md",
      encoding: "utf8",
      content: "progress: step 1",
      sha256: digest("progress: step 1"),
      pinned_at: expect.any(String),
    });
    expect(store).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: PARENT,
        childSessionId: seeded.child.session_id,
        operationPrefix: expect.stringMatching(/^file-read:[0-9a-f]+:$/),
      }),
    );
    expect(read).toHaveBeenCalledOnce();

    // The entry is gone: the next call reads the file again.
    crossing.mockImplementationOnce(async ({ value }) => ({
      kind: "admitted",
      value,
    }));
    await readFile(seeded);
    expect(read).toHaveBeenCalledTimes(2);
  });

  test("each attempt crosses under an operation id no earlier attempt used", async ({
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
    fakePod("partial");
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
    expect(operations).toHaveLength(3);
    expect(new Set(operations).size).toBe(3);
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
    fakePod("secret notes");
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

  test("the parent's own retry crosses a pinned read once the runtime is idle", async ({
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
    fakePod("final report");
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
      pinned_at: expect.any(String),
    });
  });

  test("another user on the same parent session never gets a file pinned for the first", async ({
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
    fakePod("owner's notes");
    vi.spyOn(workspaceFiles, "accessAgentWorkspaceFile").mockImplementation(
      async ({ actor }) => {
        if (actor.id !== seeded.context.userId)
          throw new Error("Workspace not found");
        return fileResult("owner's notes");
      },
    );
    const crossing = vi
      .spyOn(openappa, "returnRuntimeValue")
      .mockResolvedValueOnce(BUSY);
    await readFile(seeded);
    crossing.mockImplementation(async ({ value }) => ({
      kind: "admitted",
      value,
    }));
    await pendingExports.drain(seeded.child);
    const store = vi.spyOn(openappa, "loadChildReturns");

    const other = await fixturesUser(makeUser, makeMember, seeded);
    const intruder = await readFile({
      ...seeded,
      context: { ...seeded.context, userId: other },
    });

    expect(intruder.isError).toBe(true);
    expect(JSON.stringify(intruder)).not.toContain("owner's notes");
    expect(store).not.toHaveBeenCalled();
  });

  test("a runtime that stopped mid-call gets a refusal, not a pin that never crosses", async ({
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
    const pod = fakePod("half written");
    vi.spyOn(workspaceFiles, "accessAgentWorkspaceFile").mockResolvedValue(
      fileResult("half written"),
    );
    vi.spyOn(openappa, "returnRuntimeValue").mockResolvedValue(BUSY);
    // The turn ended without its call reporting: the dispatch stays open.
    await db
      .update(schema.agentWorkspacesTable)
      .set({ state: "idle", activeTaskId: null })
      .where(eq(schema.agentWorkspacesTable.id, seeded.taskId));

    const result = await readFile(seeded);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "stopped in the middle of a tool call",
    );
    expect(pod.snapshots).toBe(0);
  });

  test("a crossed file waiting longer than ten minutes is read afresh, not served", async ({
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
    fakePod("old version");
    const read = vi
      .spyOn(workspaceFiles, "accessAgentWorkspaceFile")
      .mockResolvedValueOnce(fileResult("old version"))
      .mockResolvedValueOnce(fileResult("new version"));
    const crossing = vi
      .spyOn(openappa, "returnRuntimeValue")
      .mockResolvedValueOnce(BUSY);
    await readFile(seeded);
    crossing.mockImplementation(async ({ value }) => ({
      kind: "admitted",
      value,
    }));
    await pendingExports.drain(seeded.child);
    const store = vi.spyOn(openappa, "loadChildReturns");

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60 * 1000);
    const later = await readFile(seeded);

    expect(later.structuredContent).toMatchObject({ content: "new version" });
    expect(later.structuredContent).not.toHaveProperty("pinned_at");
    expect(store).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
  });

  test("one pinned file that cannot be read does not keep the others from crossing", async ({
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
    const pod = fakePod("readable");
    vi.spyOn(workspaceFiles, "accessAgentWorkspaceFile").mockResolvedValue(
      fileResult("readable"),
    );
    const crossing = vi
      .spyOn(openappa, "returnRuntimeValue")
      .mockResolvedValueOnce(BUSY)
      .mockResolvedValueOnce(BUSY);
    await readFile(seeded, "reports/first.md");
    await readFile(seeded, "reports/second.md");
    pod.failRead("pinned-1");
    crossing.mockImplementation(async ({ value }) => ({
      kind: "admitted",
      value,
    }));

    await expect(pendingExports.drain(seeded.child)).resolves.toBeUndefined();

    // The second file still crossed on the same request.
    expect(crossing).toHaveBeenCalledTimes(3);
    expect(pod.discarded).toEqual(["pinned-2"]);
  });

  test("a file that grew past the read limit before it was pinned is refused, not buffered", async ({
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
    // Read while small; pinned after the runtime appended past 4 MiB.
    const pod = fakePod(Buffer.alloc(CHUNK + 1, 7));
    vi.spyOn(workspaceFiles, "accessAgentWorkspaceFile").mockResolvedValue(
      fileResult("small"),
    );
    vi.spyOn(openappa, "returnRuntimeValue").mockResolvedValue(BUSY);

    const result = await readFile(seeded);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "Use transfer_workspace_file to download it",
    );
    expect(pod.discarded).toEqual(["pinned-1"]);
    await pendingExports.drain(seeded.child);
    expect(pod.snapshots).toBe(1);
  });

  test("a pinned version that changed in the pod is dropped and the current file read instead", async ({
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
    const pod = fakePod("first draft");
    vi.spyOn(workspaceFiles, "accessAgentWorkspaceFile")
      .mockResolvedValueOnce(fileResult("first draft"))
      .mockResolvedValueOnce(fileResult("final draft"));
    vi.spyOn(openappa, "returnRuntimeValue")
      .mockResolvedValueOnce(BUSY)
      .mockImplementation(async ({ value }) => ({ kind: "admitted", value }));
    await readFile(seeded);
    // Same length, other bytes: the pin no longer holds what was pinned.
    pod.rewrite("final draft");

    const served = await readFile(seeded);

    expect(served.isError).not.toBe(true);
    expect(served.structuredContent).toMatchObject({ content: "final draft" });
    expect(served.structuredContent).not.toHaveProperty("pinned_at");
    expect(pod.discarded).toEqual(["pinned-1"]);
  });

  test("a pin the pod cannot release is counted, and the file still reaches the parent", async ({
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
    const pod = fakePod("final report");
    vi.spyOn(workspaceFiles, "accessAgentWorkspaceFile").mockResolvedValue(
      fileResult("final report"),
    );
    const crossing = vi
      .spyOn(openappa, "returnRuntimeValue")
      .mockResolvedValueOnce(BUSY);
    const counted = vi.spyOn(
      agentRuntimeMetrics,
      "reportAgentRuntimePendingExport",
    );
    await readFile(seeded);
    crossing.mockImplementation(async ({ value }) => ({
      kind: "admitted",
      value,
    }));
    pod.discardFails = true;

    await pendingExports.drain(seeded.child);

    // A crossed read releases its pin; this one stays for the in-pod sweep.
    expect(pod.discarded).toEqual([]);
    expect(counted).toHaveBeenCalledWith("discard_failed");
    const served = await readFile(seeded);
    expect(served.structuredContent).toMatchObject({ content: "final report" });
  });

  test("a pinned file the runtime's requests fail to read three times is released with a refusal", async ({
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
    const pod = fakePod("unreadable");
    vi.spyOn(workspaceFiles, "accessAgentWorkspaceFile").mockResolvedValue(
      fileResult("unreadable"),
    );
    const crossing = vi
      .spyOn(openappa, "returnRuntimeValue")
      .mockResolvedValue(BUSY);
    await readFile(seeded);
    pod.failRead("pinned-1");

    await pendingExports.drain(seeded.child);
    await pendingExports.drain(seeded.child);
    expect(pod.discarded).toEqual([]);
    await pendingExports.drain(seeded.child);
    expect(pod.discarded).toEqual(["pinned-1"]);
    // Every attempt failed before anything reached the guardrail.
    expect(crossing).toHaveBeenCalledTimes(1);

    const refused = await readFile(seeded);
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(
      "could not be read from the runtime. Call the tool again",
    );
    const again = await readFile(seeded);
    expect(again.structuredContent).toMatchObject({ status: "pending" });
    expect(pod.snapshots).toBe(2);
  });

  test("a download pinned while busy is ticketed from its snapshot after the drain", async ({
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
    const pod = fakePod("deliverable bytes");
    const crossing = vi
      .spyOn(openappa, "returnRuntimeValue")
      .mockResolvedValueOnce(BUSY);

    const pinned = await transfer(seeded);
    expect(pinned.isError).not.toBe(true);
    expect(pinned.structuredContent).toEqual({
      direction: "download",
      path: "out/report.txt",
      status: "pending",
      message: expect.any(String),
    });
    expect(pod.discarded).toEqual([]);

    crossing.mockImplementation(async ({ value }) => ({
      kind: "admitted",
      value,
    }));
    await pendingExports.drain(seeded.child);
    expect(JSON.parse(crossing.mock.calls[1][0].value)).toMatchObject({
      encoding: "utf8",
      content: "deliverable bytes",
      chunk: { index: 0, count: 1, sha256: digest("deliverable bytes") },
    });

    const ticketed = await transfer(seeded);
    expect(ticketed.isError).not.toBe(true);
    expect(await downloaded(ticketed)).toBe("deliverable bytes");
  });

  test("a large download pauses while the runtime is busy and resumes one chunk per runtime request", async ({
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
    // Exactly three chunks, so the last chunk ends on the boundary.
    const bytes = Buffer.alloc(3 * CHUNK);
    for (let i = 0; i < bytes.length; i += 4093) bytes[i] = (i * 7) & 0xff;
    fakePod(bytes);
    const crossing = vi
      .spyOn(openappa, "returnRuntimeValue")
      .mockImplementationOnce(async ({ value }) => ({
        kind: "admitted",
        value,
      }))
      .mockResolvedValueOnce(BUSY);

    const pinned = await transfer(seeded);
    expect(pinned.structuredContent).toMatchObject({ status: "pending" });

    crossing.mockImplementation(async ({ value }) => ({
      kind: "admitted",
      value,
    }));
    await pendingExports.drain(seeded.child);
    const afterOne = crossing.mock.calls.length;
    await pendingExports.drain(seeded.child);
    expect(afterOne).toBe(3);
    expect(crossing.mock.calls.length).toBe(4);
    const chunks = crossing.mock.calls.map(
      (call) => JSON.parse(call[0].value).chunk.index,
    );
    expect(chunks).toEqual([0, 1, 1, 2]);

    const ticketed = await transfer(seeded);
    expect(ticketed.isError).not.toBe(true);
    const served = Buffer.from(await downloaded(ticketed, "base64"), "base64");
    expect(served.equals(bytes)).toBe(true);
  });

  test("downloads pinned after the first share the runtime request's byte budget", async ({
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
    // Two chunks each: a full one and a 1 MiB tail.
    fakePod(Buffer.alloc(CHUNK + 1024 * 1024, 7));
    const crossing = vi
      .spyOn(openappa, "returnRuntimeValue")
      .mockResolvedValue(BUSY);
    const paths = ["out/first.bin", "out/second.bin", "out/third.bin"];
    for (const path of paths) {
      const pinned = await transfer(seeded, path);
      expect(pinned.structuredContent).toMatchObject({ status: "pending" });
    }
    crossing.mockImplementation(async ({ value }) => ({
      kind: "admitted",
      value,
    }));
    const crossed = () =>
      crossing.mock.calls.slice(paths.length).map((call) => {
        const value = JSON.parse(call[0].value);
        return `${value.path}#${value.chunk.index}`;
      });

    await pendingExports.drain(seeded.child);
    // 4 MiB + 4 MiB fills the 8 MiB budget; the third waits.
    expect(crossed()).toEqual(["out/first.bin#0", "out/second.bin#0"]);

    await pendingExports.drain(seeded.child);
    expect(crossed().slice(2)).toEqual([
      "out/first.bin#1",
      "out/second.bin#1",
      "out/third.bin#0",
    ]);
  });

  test("a runtime keeps at most sixteen pinned files and releases the oldest pin", async ({
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
    const pod = fakePod("pinned bytes");
    vi.spyOn(workspaceFiles, "accessAgentWorkspaceFile").mockResolvedValue(
      fileResult("pinned bytes"),
    );
    vi.spyOn(openappa, "returnRuntimeValue").mockResolvedValue(BUSY);
    // A clock that only moves forward, so "oldest" never depends on the host's.
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => ++clock);
    try {
      for (let file = 1; file <= 17; file++) {
        const pinned = await readFile(seeded, `reports/${file}.md`);
        expect(pinned.structuredContent).toMatchObject({ status: "pending" });
      }
    } finally {
      now.mockRestore();
    }

    expect(pod.snapshots).toBe(17);
    expect(pod.discarded).toEqual(["pinned-1"]);
  });
});

// =============================================================================
// Helpers
// =============================================================================

type Seeded = Awaited<ReturnType<typeof seededRun>>;

/**
 * The runtime's in-pod transfer helper: pins snapshots, serves their ranges,
 * and records which were discarded.
 */
function fakePod(content: string | Buffer) {
  let bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const state = {
    snapshots: 0,
    discarded: [] as string[],
    failing: new Set<string>(),
    failRead(id: string) {
      state.failing.add(id);
    },
    /** The file changes under its pins: they now serve these bytes. */
    rewrite(next: string) {
      bytes = Buffer.from(next);
    },
    discardFails: false,
  };
  vi.spyOn(backend, "runWorkspaceTransferCommand").mockImplementation(
    async ({ args }) => {
      if (args[0] === "snapshot") {
        state.snapshots++;
        return {
          transfer_id: `pinned-${state.snapshots}`,
          path: args[1],
          size: bytes.length,
          sha256: digest(bytes),
          mtime_ns: "1",
          ino: "1",
        };
      }
      if (args[0] === "discard") {
        if (state.discardFails) throw new Error("helper unavailable");
        state.discarded.push(args[1]);
      }
      return {};
    },
  );
  vi.spyOn(backend, "readWorkspaceTransferRange").mockImplementation(
    async ({ transferId, offset, length }) => {
      if (state.failing.has(transferId)) throw new Error("pod is gone");
      return {
        stdout: Readable.from([
          bytes.subarray(offset, length < 0 ? undefined : offset + length),
        ]),
        completed: Promise.resolve(),
      };
    },
  );
  return state;
}

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

function readFile(
  seeded: Pick<Seeded, "taskId" | "context">,
  path = "reports/progress.md",
) {
  return executeArchestraTool(
    READ,
    { task_id: seeded.taskId, path },
    seeded.context,
  );
}

function transfer(seeded: Seeded, path = "out/report.txt") {
  return executeArchestraTool(
    TRANSFER,
    {
      task_id: seeded.taskId,
      direction: "download",
      path,
      local_path: "/tmp/report.txt",
    },
    seeded.context,
  );
}

/** Follows a ticket the way the returned command would. */
async function downloaded(
  result: Awaited<ReturnType<typeof transfer>>,
  encoding: "utf8" | "base64" = "utf8",
): Promise<string> {
  const command = String(
    (result.structuredContent as { command: string }).command,
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
  return Buffer.concat(parts).toString(encoding);
}

/** A second member of the organization who does not own the run. */
async function fixturesUser(
  makeUser: () => Promise<{ id: string }>,
  makeMember: (
    userId: string,
    organizationId: string,
    role: { role: "member" },
  ) => Promise<unknown>,
  seeded: Seeded,
): Promise<string> {
  const other = await makeUser();
  await makeMember(other.id, seeded.organizationId, { role: "member" });
  return other.id;
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
    organizationId: org.id,
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
