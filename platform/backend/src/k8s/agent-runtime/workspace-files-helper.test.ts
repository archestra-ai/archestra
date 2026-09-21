import { EventEmitter } from "node:events";
import type { Exec, V1Pod } from "@kubernetes/client-node";
import type WebSocket from "ws";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import { AGENT_RUNTIME_THREAD_FILES_DIR } from "@/services/agent-runtime/runtime-contract";
import { afterEach, expect, test, vi } from "@/test";
import type { AgentRunRecord } from "@/types";

/**
 * The helper that serves workspace files travels with the call. An image ships
 * whatever copy it was built with, so running an installed one breaks as soon
 * as the two versions drift — and a custom image may not bundle it at all.
 */

const session = {
  taskId: "task-1",
  runtimeScope: "archestra",
  workloadName: "workload-1",
  backend: "kubernetes",
} as unknown as AgentRunRecord;

function stubPod() {
  vi.spyOn(
    agentRuntimeManager as unknown as {
      requireRunningPodName: (session: AgentRunRecord) => Promise<string>;
    },
    "requireRunningPodName",
  ).mockResolvedValue("pod-1");
}

function stubExec(result: string | Error) {
  const exec = vi.spyOn(
    agentRuntimeManager as unknown as {
      execInPod: (params: { command: string[] }) => Promise<string>;
    },
    "execInPod",
  );
  if (result instanceof Error) exec.mockRejectedValue(result);
  else exec.mockResolvedValue(result);
  return exec;
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("sends the helper program itself, never a path inside the image", async () => {
  stubPod();
  const exec = stubExec(
    JSON.stringify({ ok: true, path: "notes.txt", size: 0, sha256: "0" }),
  );

  await agentRuntimeManager.runWorkspaceTransferCommand({
    session,
    args: ["stat", "notes.txt"],
    timeoutMs: 1000,
  });

  const command = exec.mock.calls[0]?.[0].command ?? [];
  expect(command.slice(0, 2)).toEqual(["python3", "-c"]);
  // The program, followed by the command it should run.
  expect(command[2]).toContain("def dispatch(argv)");
  expect(command.slice(3)).toEqual(["stat", "notes.txt"]);
  expect(command.join(" ")).not.toContain("/usr/local/bin");
});

test("an image without python3 says so instead of leaking the exec failure", async () => {
  stubPod();
  stubExec(
    new Error(
      'exec failed: unable to start container process: exec: "python3": executable file not found in $PATH',
    ),
  );

  await expect(
    agentRuntimeManager.runWorkspaceTransferCommand({
      session,
      args: ["stat", "notes.txt"],
      timeoutMs: 1000,
    }),
  ).rejects.toThrow(/no python3/);
});

test("captures original binary bytes and bounds a runtime that ignores the helper limit", async () => {
  stubPod();
  const { exec, socket } = stubThreadVolume();
  const data = Buffer.from([0x50, 0x4b, 0, 0xff, 0x80]);
  exec.mockImplementation(async (...args) => {
    args[4]?.write(data);
    args[8]?.({ status: "Success" });
    return socket;
  });
  await expect(
    agentRuntimeManager.readThreadFile({
      session: threadSession(),
      path: "outputs/result.zip",
      maxBytes: data.length,
    }),
  ).resolves.toEqual(data);
  await expect(
    agentRuntimeManager.readThreadFile({
      session: threadSession(),
      path: "outputs/result.zip",
      maxBytes: data.length - 1,
    }),
  ).rejects.toThrow("upload limit");
});

test("temporary file operations reject a retained volume at the expected path", async () => {
  stubPod();
  const { exec, readPod } = stubThreadVolume();
  readPod.mockResolvedValue({
    spec: {
      containers: [
        {
          name: "agent-runtime",
          volumeMounts: [
            { name: "thread-files", mountPath: AGENT_RUNTIME_THREAD_FILES_DIR },
          ],
        },
      ],
      volumes: [
        {
          name: "thread-files",
          persistentVolumeClaim: { claimName: "retained" },
        },
      ],
    },
  });
  await expect(
    agentRuntimeManager.readThreadFile({
      session: threadSession(),
      path: "inputs/private.png",
      maxBytes: 1024,
    }),
  ).rejects.toThrow("no temporary file volume");
  expect(exec).not.toHaveBeenCalled();
});

test("cleanup converges after compute loss without resuming or executing in a replacement volume", async () => {
  const { exec, listPods, pod } = stubThreadVolume();
  for (const items of [
    [],
    [{ ...pod, metadata: { name: "pod-1", deletionTimestamp: new Date() } }],
    [{ ...pod, status: { phase: "Failed" } }],
    [{ ...pod, status: { phase: "Pending" } }],
    [
      {
        ...pod,
        spec: {
          ...pod.spec,
          containers: pod.spec?.containers ?? [],
          volumes: [
            {
              name: "thread-files",
              persistentVolumeClaim: { claimName: "retained" },
            },
          ],
        },
      },
    ],
  ]) {
    listPods.mockResolvedValue({ items });
    await expect(
      agentRuntimeManager.cleanupThreadFiles(threadSession()),
    ).resolves.toBeUndefined();
  }
  expect(exec).not.toHaveBeenCalled();
});

test("cleanup retries permission and transport errors instead of treating them as missing files", async () => {
  const { exec, listPods, socket } = stubThreadVolume();
  const denied = new Error("permission denied");
  listPods.mockRejectedValueOnce(denied);
  await expect(
    agentRuntimeManager.cleanupThreadFiles(threadSession()),
  ).rejects.toBe(denied);
  const disconnected = new Error("network disconnected");
  exec.mockRejectedValueOnce(disconnected);
  await expect(
    agentRuntimeManager.cleanupThreadFiles(threadSession()),
  ).rejects.toBe(disconnected);
  exec.mockImplementation(async (...args) => {
    args[4]?.write('{"ok":true,"removed":true}');
    args[8]?.({ status: "Success" });
    return socket;
  });
  await expect(
    agentRuntimeManager.cleanupThreadFiles(threadSession()),
  ).resolves.toBeUndefined();
});

function threadSession(): AgentRunRecord {
  return {
    ...session,
    taskId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    completionTarget: {
      type: "chatops",
      bindingId: "binding",
      threadId: "1.2",
      ephemeralFiles: true,
    },
  };
}

function stubThreadVolume() {
  const socket = Object.assign(new EventEmitter(), {
    terminate: vi.fn(),
  }) as unknown as WebSocket;
  const exec = vi.fn<Exec["exec"]>().mockResolvedValue(socket);
  const pod: V1Pod = {
    metadata: { name: "pod-1" },
    status: { phase: "Running" },
    spec: {
      containers: [
        {
          name: "agent-runtime",
          volumeMounts: [
            { name: "thread-files", mountPath: AGENT_RUNTIME_THREAD_FILES_DIR },
          ],
        },
      ],
      volumes: [{ name: "thread-files", emptyDir: { sizeLimit: "128Mi" } }],
    },
  };
  const readPod = vi.fn<() => Promise<V1Pod>>().mockResolvedValue(pod);
  const listPods = vi
    .fn<() => Promise<{ items: V1Pod[] }>>()
    .mockResolvedValue({ items: [pod] });
  vi.spyOn(
    agentRuntimeManager as unknown as { requireClients: () => unknown },
    "requireClients",
  ).mockReturnValue({
    exec: { exec },
    coreApi: { readNamespacedPod: readPod, listNamespacedPod: listPods },
  });
  return { exec, socket, readPod, listPods, pod };
}
