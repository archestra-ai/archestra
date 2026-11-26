import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { vi } from "vitest";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import { kubernetesAgentRuntimeBackendDriver as backend } from "@/services/agent-runtime/backends/kubernetes";
import type { Agent } from "@/types";

/**
 * An Agent Runtime workspace for tests: a retained run, and the in-Pod
 * transfer helper replaced at its process boundary (the exec into the Pod).
 *
 * @public — test double, consumed only by tests.
 */

/**
 * The in-Pod helper, as far as the ticket service can tell. Like the real
 * one, it stages an entry exclusively and keeps what arrived before its input
 * failed. `inputDelayMs` holds off reading the input, as a Pod lookup before
 * the exec does.
 */
export function fakeWorkspacePod(
  file: Buffer = Buffer.alloc(0),
  options: { inputDelayMs?: number } = {},
) {
  vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
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
          if (staged.has(rest[0])) {
            throw new Error(`[Errno 17] File exists: ${rest[0]}`);
          }
          staged.set(rest[0], Buffer.alloc(0));
          if (options.inputDelayMs) {
            await new Promise((resolve) =>
              setTimeout(resolve, options.inputDelayMs),
            );
          }
          const parts: Buffer[] = [];
          try {
            for await (const chunk of stdin ?? []) {
              parts.push(Buffer.from(chunk));
            }
          } finally {
            staged.set(rest[0], Buffer.concat(parts));
          }
          const stored = Buffer.concat(parts);
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
          staged.delete(rest[0]);
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
export async function seedRetainedRun(params: {
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

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
