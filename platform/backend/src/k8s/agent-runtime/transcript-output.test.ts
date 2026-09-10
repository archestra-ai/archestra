import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { CoreV1Api, Exec, KubeConfig } from "@kubernetes/client-node";
import { vi } from "vitest";
import type WebSocket from "ws";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  VirtualApiKeyModel,
} from "@/models";
import { expect, test } from "@/test";
import manager from "./manager";

// This manager caches its clients. Isolate the fake cluster from other files,
// including the opt-in tests that exercise a real Kubernetes controller.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    agentRuntime: { enabled: true },
    orchestrator: {
      kubernetes: { kubeconfig: "", loadKubeconfigFromCurrentCluster: false },
    },
  }),
);

for (const outcome of ["success", "disconnect", "failure", "abort"] as const) {
  test(`transcript snapshots require confirmed completion: ${outcome}`, async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    vi.spyOn(manager, "isEnabled", "get").mockReturnValue(true);
    vi.spyOn(KubeConfig.prototype, "loadFromDefault").mockImplementation(
      function (this: KubeConfig) {
        this.loadFromOptions({
          clusters: [
            { name: "test", server: "https://kubernetes.example.test" },
          ],
          users: [{ name: "test" }],
          contexts: [{ name: "test", cluster: "test", user: "test" }],
          currentContext: "test",
        });
      },
    );
    const organization = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: organization.id });
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: user.id,
    });
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_WORKING",
    });
    const run = await AgentRunModel.create({
      taskId: task.id,
      agentId: agent.id,
      organizationId: organization.id,
      actorKind: "user",
      actorId: user.id,
      actorUserId: user.id,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      workloadName: `snapshot-${randomUUID()}`,
    });
    vi.spyOn(CoreV1Api.prototype, "listNamespacedPod").mockResolvedValue({
      items: [
        { metadata: { name: run.workloadName }, status: { phase: "Running" } },
      ],
    });
    const socket = Object.assign(new EventEmitter(), {
      close: vi.fn(),
    }) as unknown as WebSocket;
    const abort = new AbortController();
    vi.spyOn(Exec.prototype, "exec").mockImplementation(async (...args) => {
      args[4]?.write("partial output");
      setTimeout(() => {
        if (outcome === "disconnect") socket.emit("close");
        else if (outcome === "abort") abort.abort();
        else
          args[8]?.({
            status: outcome === "success" ? "Success" : "Failure",
            message: "private diagnostic",
          });
      }, 0);
      return socket;
    });
    let output = "";
    const result = manager.snapshotLogs({
      session: run,
      lines: 1,
      abortSignal: abort.signal,
      destination: new Writable({
        write(chunk, _encoding, callback) {
          output += chunk.toString();
          callback();
        },
      }),
    });
    if (outcome === "success") {
      await expect(result).resolves.toBeUndefined();
      expect(output).toBe("partial output");
    } else {
      await expect(result).rejects.toThrow(
        outcome === "disconnect"
          ? "disconnected before completion"
          : outcome === "abort"
            ? "snapshot aborted"
            : /^Could not read turn output$/,
      );
    }
  });
}

test("retains access only for the same live CLI and revokes it on workspace cleanup", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  vi.spyOn(manager, "isEnabled", "get").mockReturnValue(true);
  vi.spyOn(KubeConfig.prototype, "loadFromDefault").mockImplementation(
    function (this: KubeConfig) {
      this.loadFromOptions({
        clusters: [{ name: "test", server: "https://kubernetes.example.test" }],
        users: [{ name: "test" }],
        contexts: [{ name: "test", cluster: "test", user: "test" }],
        currentContext: "test",
      });
    },
  );
  const organization = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: organization.id });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state: "TASK_STATE_COMPLETED",
  });
  const key = await VirtualApiKeyModel.create({
    organizationId: organization.id,
    name: "retained-terminal",
    keyType: "passthrough",
  });
  const run = await AgentRunModel.create({
    taskId: task.id,
    agentId: agent.id,
    organizationId: organization.id,
    actorKind: "user",
    actorId: user.id,
    actorUserId: user.id,
    backend: "kubernetes",
    runtimeScope: "archestra-dev",
    workloadName: `retained-${randomUUID()}`,
    virtualApiKeyId: key.virtualKey.id,
  });
  const pods = vi
    .spyOn(CoreV1Api.prototype, "listNamespacedPod")
    .mockResolvedValue({
      items: [
        { metadata: { name: run.workloadName }, status: { phase: "Running" } },
      ],
    });
  vi.spyOn(CoreV1Api.prototype, "readNamespacedSecret").mockResolvedValue({
    data: {},
  });
  vi.spyOn(CoreV1Api.prototype, "deleteNamespacedSecret").mockResolvedValue({});
  await expect(manager.hasRetainedTerminal(run)).resolves.toBe(true);
  await manager.releaseRun(run, { retainInteractiveSession: true });
  expect(
    (await AgentRunModel.findByTaskId(run.taskId))?.virtualApiKeyId,
  ).toBeNull();
  pods.mockResolvedValue({ items: [] });
  await expect(manager.hasRetainedTerminal(run)).resolves.toBe(false);
  await manager.releaseRun(run, { retainInteractiveSession: true });
  expect(
    (await AgentRunModel.findByTaskId(run.taskId))?.virtualApiKeyId,
  ).toBeNull();
});
