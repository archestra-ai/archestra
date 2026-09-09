import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CustomObjectsApi, KubeConfig } from "@kubernetes/client-node";
import config from "@/config";
import { A2AContextModel, A2ATaskModel, AgentRunModel } from "@/models";
import type { AgentRunLaunchSpec } from "@/services/agent-runtime/backends";
import { expect, test, vi } from "@/test";
import manager from "./manager";
import { buildAgentRuntimeSandbox } from "./manifests";

// Real controller/Secret/PVC/exec integration. Never target the ambient context.
test.skipIf(process.env.ARCHESTRA_TEST_SANDBOX_CONTEXT !== "orbstack")(
  "recovers a continuation interrupted before Pod wake-up without replaying it",
  async ({ makeOrganization, makeUser, makeAgent }) => {
    config.agentRuntime.enabled = true;
    expect(config.orchestrator.kubernetes.kubeconfig).toBeFalsy();
    expect(
      config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster,
    ).toBe(false);
    const load = KubeConfig.prototype.loadFromDefault;
    vi.spyOn(KubeConfig.prototype, "loadFromDefault").mockImplementation(
      function (this: KubeConfig) {
        load.call(this);
        this.setCurrentContext("orbstack");
      },
    );
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: user.id,
    });
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_WORKING",
    });
    const initialTaskId = randomUUID();
    const name = `sandbox-recovery-${task.id.slice(0, 8)}`;
    const run = await AgentRunModel.create({
      taskId: task.id,
      agentId: agent.id,
      organizationId: org.id,
      actorKind: "user",
      actorId: user.id,
      actorUserId: user.id,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      workloadName: name,
    });
    const spec: AgentRunLaunchSpec = {
      taskId: task.id,
      agentRuntimeId: agent.id,
      frozenName: name,
      runtimeScope: "archestra-dev",
      image: "archestra-transcript-agent:test",
      command: [
        "/bin/sh",
        "-c",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
        'test -z "${OPENAI_API_KEY+x}" && printf continued >> /home/node/recovery-result',
      ],
      privileged: false,
      resources: { cpuRequest: "100m", memoryRequest: "128Mi" },
      env: { ARCHESTRA_AGENT_RUNTIME_TASK_ID: task.id },
      secretEnv: {},
      activeDeadlineSeconds: 600,
      ephemeralStorageLimit: "1Gi",
      workspaceStorageSize: "1Gi",
      nodeSelector: {},
      imagePullSecrets: [],
      inputFileCount: 0,
      effectiveNetworkPolicy: { source: "built_in", policy: null },
    };
    const { runtimeScope, ...manifestSpec } = spec;
    try {
      kubectl(
        ["apply", "-f", "-"],
        JSON.stringify({
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: `${name}-env` },
          stringData: { OPENAI_API_KEY: "revoked-test-key" },
        }),
      );
      kubectl(
        ["apply", "-f", "-"],
        JSON.stringify(
          buildAgentRuntimeSandbox({
            ...manifestSpec,
            namespace: runtimeScope,
            taskId: initialTaskId,
            env: { ARCHESTRA_AGENT_RUNTIME_TASK_ID: initialTaskId },
            secretEnv: { OPENAI_API_KEY: "revoked-test-key" },
            command: [
              "/bin/sh",
              "-c",
              "printf initial > /home/node/recovery-result",
            ],
            ownerReferences: undefined,
          }),
        ),
      );
      await until(
        () =>
          exec(`cat /var/run/archestra/turns/${initialTaskId}.exit`).trim() ===
          "0",
      );
      kubectl([
        "patch",
        "sandbox",
        name,
        "--type=merge",
        "-p",
        JSON.stringify({ spec: { operatingMode: "Suspended" } }),
      ]);
      await until(
        () =>
          !kubectl([
            "get",
            "pod",
            name,
            "--ignore-not-found",
            "-o",
            "name",
          ]).trim(),
      );
      // Lose the launching process at the external wake-up boundary, after
      // saving its intent but before any continuation command can execute.
      const wake = vi
        .spyOn(CustomObjectsApi.prototype, "patchNamespacedCustomObject")
        .mockRejectedValueOnce(new Error("simulated launcher interruption"));
      await expect(manager.continueRun({ session: run, spec })).rejects.toThrow(
        "simulated launcher interruption",
      );
      wake.mockRestore();
      expect(
        kubectl([
          "get",
          "secret",
          `agent-turn-${task.id}`,
          "-o",
          "name",
        ]).trim(),
      ).toBe(`secret/agent-turn-${task.id}`);
      await manager.recoverRun(run);
      await until(
        () =>
          exec(`cat /var/run/archestra/turns/${task.id}.exit`).trim() === "0",
      );
      expect(exec("cat /home/node/recovery-result")).toBe("initialcontinued");
      await manager.recoverRun(run);
      expect(exec("cat /home/node/recovery-result")).toBe("initialcontinued");
      await manager.suspendWorkspace(run);
      await until(
        () =>
          !kubectl([
            "get",
            "pod",
            name,
            "--ignore-not-found",
            "-o",
            "name",
          ]).trim(),
      );
      await manager.resumeWorkspace(run);
      expect(exec("cat /home/node/recovery-result")).toBe("initialcontinued");
      expect(exec(`cat /var/run/archestra/turns/${task.id}.exit`).trim()).toBe(
        "0",
      );
      await manager.releaseRun(run);
      expect(
        kubectl([
          "get",
          "secret",
          `agent-turn-${task.id}`,
          "--ignore-not-found",
          "-o",
          "name",
        ]).trim(),
      ).toBe("");
      await manager.recoverRun(run);
      expect(exec("cat /home/node/recovery-result")).toBe("initialcontinued");
    } finally {
      vi.restoreAllMocks();
      kubectl([
        "delete",
        "sandbox",
        name,
        "--ignore-not-found",
        "--wait=false",
      ]);
      kubectl(["delete", "secret", `${name}-env`, "--ignore-not-found"]);
    }
    function exec(command: string) {
      return kubectl([
        "exec",
        name,
        "-c",
        "agent-runtime",
        "--",
        "/bin/sh",
        "-c",
        command,
      ]);
    }
  },
  180_000,
);

function kubectl(args: string[], input?: string) {
  const result = spawnSync(
    "kubectl",
    ["--context=orbstack", "-n", "archestra-dev", ...args],
    { input, encoding: "utf8", timeout: 15_000 },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || String(result.error));
  return result.stdout;
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if (check()) return;
    } catch {
      /* Pod may not exist yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Disposable Sandbox did not reach the expected state");
}
