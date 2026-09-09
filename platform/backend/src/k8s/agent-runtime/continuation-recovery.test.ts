import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import {
  CustomObjectsApi,
  KubeConfig,
  NetworkingV1Api,
} from "@kubernetes/client-node";
import config from "@/config";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  OrganizationModel,
} from "@/models";
import type { AgentRunLaunchSpec } from "@/services/agent-runtime/backends";
import { cleanupAgentRun } from "@/services/agent-runtime/pod-run";
import { agentRunTranscriptStore } from "@/services/agent-runtime/transcript-store";
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
      effectiveNetworkPolicy: {
        source: "environment",
        policy: {
          egressMode: "restricted",
          domainPreset: "none",
          allowedDomains: [],
          allowedCidrs: ["203.0.113.0/24"],
        },
      },
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
      kubectl(
        ["apply", "-f", "-"],
        JSON.stringify({
          apiVersion: "networking.k8s.io/v1",
          kind: "NetworkPolicy",
          metadata: { name: `${name}-egress` },
          spec: {
            podSelector: {
              matchLabels: { "archestra.io/agent-run-task-id": initialTaskId },
            },
            policyTypes: ["Egress"],
            egress: [{}],
          },
        }),
      );
      // A stale provider allow policy cannot be ignored when switching to the
      // standard policy. Simulate its API refusing deletion; do not wake the
      // workspace or publish a runnable handoff in that case.
      const stalePolicyDelete = vi
        .spyOn(CustomObjectsApi.prototype, "deleteNamespacedCustomObject")
        .mockRejectedValueOnce(new Error("policy deletion forbidden"));
      await expect(manager.continueRun({ session: run, spec })).rejects.toThrow(
        "policy deletion forbidden",
      );
      expect(stalePolicyDelete).toHaveBeenCalledWith(
        expect.objectContaining({
          group: "cilium.io",
          name: `${name}-egress`,
        }),
      );
      stalePolicyDelete.mockRestore();
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
      expect(
        kubectl([
          "get",
          "sandbox",
          name,
          "-o",
          "jsonpath={.spec.operatingMode}",
        ]),
      ).toBe("Suspended");
      const wake = vi
        .spyOn(CustomObjectsApi.prototype, "patchNamespacedCustomObject")
        .mockRejectedValueOnce(new Error("simulated launcher interruption"));
      await expect(manager.continueRun({ session: run, spec })).rejects.toThrow(
        "simulated launcher interruption",
      );
      wake.mockRestore();
      const restrictedPolicy = JSON.parse(
        kubectl(["get", "networkpolicy", `${name}-egress`, "-o", "json"]),
      );
      expect(restrictedPolicy.spec.podSelector.matchLabels).toEqual({
        "archestra.io/agent-run-task-id": initialTaskId,
      });
      expect(restrictedPolicy.spec.egress).not.toContainEqual({});
      expect(JSON.stringify(restrictedPolicy.spec.egress)).toContain(
        "203.0.113.0/24",
      );
      expect(JSON.stringify(restrictedPolicy.spec.egress)).not.toContain(
        '"cidr":"0.0.0.0/0"',
      );
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
      await manager.continueRun({
        session: run,
        spec: {
          ...spec,
          effectiveNetworkPolicy: { source: "built_in", policy: null },
        },
      });
      const relaxedPolicy = JSON.parse(
        kubectl(["get", "networkpolicy", `${name}-egress`, "-o", "json"]),
      );
      expect(JSON.stringify(relaxedPolicy.spec.egress)).toContain(
        '"cidr":"0.0.0.0/0"',
      );
      expect(JSON.stringify(relaxedPolicy.spec.egress)).not.toContain(
        "203.0.113.0/24",
      );
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
      await OrganizationModel.patch(org.id, {
        defaultNetworkPolicy: {
          egressMode: "restricted",
          domainPreset: "none",
          allowedDomains: [],
          allowedCidrs: ["198.51.100.0/24"],
        },
      });
      const deniedWakePolicy = vi
        .spyOn(NetworkingV1Api.prototype, "createNamespacedNetworkPolicy")
        .mockRejectedValueOnce(new Error("Policy update denied"));
      await expect(manager.resumeWorkspace(run)).rejects.toThrow(
        "Policy update denied",
      );
      expect(
        kubectl([
          "get",
          "pod",
          name,
          "--ignore-not-found",
          "-o",
          "name",
        ]).trim(),
      ).toBe("");
      deniedWakePolicy.mockRestore();
      await manager.resumeWorkspace(run);
      const resumedPolicy = JSON.parse(
        kubectl(["get", "networkpolicy", `${name}-egress`, "-o", "json"]),
      );
      expect(JSON.stringify(resumedPolicy.spec.egress)).toContain(
        '"cidr":"198.51.100.0/24"',
      );
      expect(JSON.stringify(resumedPolicy.spec.egress)).not.toContain(
        '"cidr":"0.0.0.0/0"',
      );
      // A continuation can arrive while suspension is still deleting the old
      // Pod. Hold deletion to ensure its terminal phase cannot fail the wake.
      const retiringUid = JSON.parse(
        kubectl(["get", "pod", name, "-o", "json"]),
      ).metadata.uid;
      kubectl([
        "patch",
        "pod",
        name,
        "--type=merge",
        "-p",
        JSON.stringify({
          metadata: { finalizers: ["archestra.io/test-hold-deletion"] },
        }),
      ]);
      await manager.suspendWorkspace(run);
      await until(() =>
        Boolean(
          JSON.parse(kubectl(["get", "pod", name, "-o", "json"])).metadata
            .deletionTimestamp,
        ),
      );
      let wakeSettled = false;
      let wakeError: unknown;
      const resumeAttempt = manager
        .resumeWorkspace(run)
        .catch((error) => {
          wakeError = error;
        })
        .finally(() => {
          wakeSettled = true;
        });
      try {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(wakeSettled).toBe(false);
      } finally {
        kubectl([
          "patch",
          "pod",
          name,
          "--type=merge",
          "-p",
          JSON.stringify({ metadata: { finalizers: [] } }),
        ]);
        await resumeAttempt;
      }
      expect(wakeError).toBeUndefined();
      expect(
        JSON.parse(kubectl(["get", "pod", name, "-o", "json"])).metadata.uid,
      ).not.toBe(retiringUid);
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
      // Archive after the controller independently removes the workload Pod.
      // Recovery must not wake the workspace or change the hard deadline.
      exec(
        `printf 'complete transcript\\n' > /var/run/archestra/turns/${task.id}.log`,
      );
      const shutdownTime = new Date(Date.now() - 1000).toISOString();
      kubectl([
        "patch",
        "sandbox",
        name,
        "--type=merge",
        "-p",
        JSON.stringify({ spec: { shutdownTime } }),
      ]);
      await until(() =>
        JSON.parse(
          kubectl(["get", "sandbox", name, "-o", "json"]),
        ).status?.conditions?.some(
          (condition: { reason?: string }) =>
            condition.reason === "SandboxExpired",
        ),
      );
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
      let recovered = "";
      await manager.snapshotLogs({
        session: run,
        lines: 1,
        destination: new Writable({
          write(chunk, _encoding, callback) {
            recovered += chunk.toString();
            callback();
          },
        }),
      });
      expect(recovered).toBe("complete transcript\n");
      await cleanupAgentRun(run, { requireTranscript: true });
      expect(
        (await AgentRunModel.findByTaskId(task.id))?.endedAt,
      ).not.toBeNull();
      expect(
        kubectl([
          "get",
          "pod",
          name,
          "--ignore-not-found",
          "-o",
          "name",
        ]).trim(),
      ).toBe("");
      expect(
        JSON.parse(kubectl(["get", "sandbox", name, "-o", "json"])).spec
          .shutdownTime,
      ).toBe(shutdownTime);
      await until(
        () =>
          JSON.parse(
            kubectl([
              "get",
              "pods",
              "-l",
              "archestra.io/transcript-recovery",
              "-o",
              "json",
            ]),
          ).items.length === 0,
      );
      await manager.deleteWorkspace(run);
      await until(
        () =>
          !kubectl([
            "get",
            "pvc",
            `workspace-${name}`,
            "--ignore-not-found",
            "-o",
            "name",
          ]).trim(),
      );
      let archived = "";
      await agentRunTranscriptStore.stream({
        runId: run.id,
        onChunk: (chunk) => {
          archived += chunk.toString();
        },
      });
      expect(archived).toBe("complete transcript\n");
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
      kubectl([
        "delete",
        "networkpolicy",
        `${name}-egress`,
        `${name}-np`,
        "--ignore-not-found",
      ]);
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
