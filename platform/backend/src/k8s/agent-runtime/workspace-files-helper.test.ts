import { agentRuntimeManager } from "@/k8s/agent-runtime";
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
