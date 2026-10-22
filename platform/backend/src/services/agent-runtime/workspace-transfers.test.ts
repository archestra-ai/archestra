import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { vi } from "vitest";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import { CacheKey, cacheManager } from "@/cache-manager";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import { kubernetesAgentRuntimeBackendDriver as backend } from "@/services/agent-runtime/backends/kubernetes";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import type { Agent } from "@/types";
import {
  WORKSPACE_TRANSFER_TICKET_TTL_MS,
  workspaceTransferTickets,
} from "./workspace-transfers";

setupTestCacheManager();

/**
 * The tool call that mints a ticket and the curl command that redeems it hit
 * whichever replica the load balancer picks, and the only thing replicas
 * share is the database. A ticket that is not in the shared cache is a
 * ticket another replica cannot honour.
 */
describe("transfer tickets in the shared cache", () => {
  beforeEach(() => {
    vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("an upload ticket is written to the shared cache and gone from it once redeemed", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const seeded = await seededRun({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
    });
    const pod = fakePod(Buffer.alloc(0));
    const bytes = Buffer.from("workspace-transfer-probe\n");
    const sha256 = digest(bytes);
    const minted = await workspaceTransferTickets.mintUpload({
      ...seeded,
      path: "probe/incoming/hello.txt",
      size: bytes.length,
      sha256,
    });

    expect(await cachedTicket(minted.ticket.id)).toMatchObject({
      direction: "upload",
      path: "probe/incoming/hello.txt",
      sha256,
    });

    const ticket = await workspaceTransferTickets.resolve(
      minted.ticket.id,
      minted.token,
    );
    const received = await workspaceTransferTickets.receive({
      ticket,
      body: Readable.from([bytes]),
    });

    expect(received).toMatchObject({
      path: "probe/incoming/hello.txt",
      size: bytes.length,
      sha256,
    });
    expect(pod.staged.get(ticket.entryId)?.equals(bytes)).toBe(true);
    expect(pod.finalized).toEqual([
      [ticket.entryId, "probe/incoming/hello.txt", sha256, "-", "0"],
    ]);
    // A redeemed ticket is gone for every replica.
    expect(await cachedTicket(minted.ticket.id)).toBeUndefined();
    await expect(
      workspaceTransferTickets.resolve(minted.ticket.id, minted.token),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test("a download ticket stays in the shared cache for resumes, and a wrong token, an unknown id or an expired ticket is not found", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const seeded = await seededRun({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
    });
    const file = Buffer.from("report: step 1 done\n");
    fakePod(file);
    const minted = await workspaceTransferTickets.mintDownload({
      ...seeded,
      path: "reports/summary.md",
    });

    const ticket = await workspaceTransferTickets.resolve(
      minted.ticket.id,
      minted.token,
    );
    expect(ticket).toMatchObject({
      direction: "download",
      size: file.length,
      sha256: digest(file),
    });
    const resumed = await workspaceTransferTickets.read({
      ticket,
      offset: 8,
      length: -1,
    });
    const parts: Buffer[] = [];
    for await (const part of resumed.stdout) parts.push(Buffer.from(part));
    await resumed.completed;
    expect(Buffer.concat(parts).equals(file.subarray(8))).toBe(true);
    // Still there: the next Range request may come from any replica.
    expect(await cachedTicket(minted.ticket.id)).toMatchObject({
      direction: "download",
    });

    await expect(
      workspaceTransferTickets.resolve(
        minted.ticket.id,
        `${minted.token.slice(1)}x`,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      workspaceTransferTickets.resolve("not-a-ticket", minted.token),
    ).rejects.toMatchObject({ statusCode: 404 });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + WORKSPACE_TRANSFER_TICKET_TTL_MS + 1000);
    await expect(
      workspaceTransferTickets.resolve(minted.ticket.id, minted.token),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

// =============================================================================
// Helpers
// =============================================================================

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** What any replica would find for this ticket. */
async function cachedTicket(id: string) {
  return cacheManager.get<Record<string, unknown>>(
    `${CacheKey.AgentWorkspaceTransferTicket}-${id}`,
  );
}

/** The in-Pod helper, as far as the ticket service can tell. */
function fakePod(file: Buffer) {
  const staged = new Map<string, Buffer>();
  const finalized: string[][] = [];
  let snapshots = 0;
  vi.spyOn(backend, "runWorkspaceTransferCommand").mockImplementation(
    async ({ args, stdin }) => {
      const [command, ...rest] = args;
      switch (command) {
        case "stat":
          return { ok: true, path: rest[0], present: false };
        case "write-stream": {
          const parts: Buffer[] = [];
          for await (const chunk of stdin ?? []) parts.push(Buffer.from(chunk));
          const stored = Buffer.concat(parts);
          staged.set(rest[0], stored);
          return {
            ok: true,
            upload_id: rest[0],
            size: stored.length,
            sha256: digest(stored),
          };
        }
        case "finalize":
          finalized.push(rest);
          return {
            ok: true,
            path: rest[1],
            size: staged.get(rest[0])?.length ?? 0,
            sha256: rest[2],
          };
        case "snapshot":
          snapshots++;
          return {
            ok: true,
            transfer_id: `pinned-${snapshots}`,
            path: rest[0],
            size: file.length,
            sha256: digest(file),
            mtime_ns: "1",
            ino: "1",
          };
        case "discard":
          return { ok: true, discarded: rest[0] };
        default:
          throw new Error(`unexpected helper command: ${args.join(" ")}`);
      }
    },
  );
  vi.spyOn(backend, "readWorkspaceTransferRange").mockImplementation(
    async ({ offset, length }) => ({
      stdout: Readable.from([
        file.subarray(offset, length < 0 ? undefined : offset + length),
      ]),
      completed: Promise.resolve(),
    }),
  );
  return { staged, finalized };
}

/** A retained run whose owner may move files in and out of its workspace. */
async function seededRun(params: {
  makeAgent: (overrides: Record<string, unknown>) => Promise<Agent>;
  makeMember: (
    userId: string,
    organizationId: string,
    role: { role: "member" },
  ) => Promise<unknown>;
  makeOrganization: () => Promise<{ id: string }>;
  makeUser: () => Promise<{ id: string }>;
}): Promise<{ actor: A2AActor; taskId: string }> {
  const user = await params.makeUser();
  const org = await params.makeOrganization();
  await params.makeMember(user.id, org.id, { role: "member" });
  const agent = await params.makeAgent({
    organizationId: org.id,
    authorId: user.id,
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
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const task = await A2ATaskModel.createForRun({
    contextId: context.id,
    agentId: agent.id,
  });
  const runtimeScope = backend.resolveRuntimeScope({});
  const workloadName = `live-${task.id}`;
  await AgentRunModel.create({
    organizationId: org.id,
    agentId: agent.id,
    taskId: task.id,
    actorKind: "user",
    actorId: user.id,
    actorUserId: user.id,
    backend: "kubernetes",
    runtimeScope,
    workloadName,
  });
  await AgentWorkspaceModel.create({
    id: task.id,
    organizationId: org.id,
    agentId: agent.id,
    actorKind: "user",
    actorId: user.id,
    backend: "kubernetes",
    runtimeScope,
    workloadName,
    state: "idle",
    lastTaskId: task.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return {
    actor: { id: user.id, kind: "user", organizationId: org.id },
    taskId: task.id,
  };
}
