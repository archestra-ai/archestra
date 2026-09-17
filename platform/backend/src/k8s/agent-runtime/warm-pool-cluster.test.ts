import { spawnSync } from "node:child_process";
import path from "node:path";
import { vi } from "vitest";
import config from "@/config";
import { A2AContextModel, A2ATaskModel, AgentRunModel } from "@/models";
import type { AgentRunLaunchSpec } from "@/services/agent-runtime/backends";
import { expect, test } from "@/test";
import manager from "./manager";
import { agentWarmPoolManager } from "./warm-pool";

const { testNamespace } = vi.hoisted(() => ({
  testNamespace: `warm-test-${process.pid}`,
}));
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    orchestrator: {
      kubernetes: {
        namespace: testNamespace,
        kubeconfig: `${process.cwd()}/../node_modules/.cache/agent-sandbox.kubeconfig`,
        loadKubeconfigFromCurrentCluster: false,
      },
    },
  }),
);

// Real controller allocation, PVCs, and exec; never use the ambient kubectl context.
test.skipIf(process.env.ARCHESTRA_TEST_SANDBOX_CONTEXT !== "orbstack")(
  "claims ready workspaces exclusively, replenishes, and preserves files across resume and continuation",
  async ({ makeOrganization, makeUser, makeAgent }) => {
    const namespace = testNamespace;
    kubectl(["create", "namespace", namespace]);
    config.agentRuntime.enabled = true;
    config.agentRuntime.warmPoolSize = 1;
    config.agentRuntime.warmPoolMaxPools = 1;
    config.agentRuntime.workspaceStorageSize = "1Gi";
    config.agentRuntime.workspaceStorageClass = undefined;
    config.agentRuntime.nodeSelector = {};
    config.orchestrator.kubernetes.namespace = namespace;
    config.orchestrator.kubernetes.kubeconfig = path.resolve(
      "../node_modules/.cache/agent-sandbox.kubeconfig",
    );
    const org = await makeOrganization({
      defaultEnvironmentNamespace: namespace,
    });
    const user = await makeUser();
    const runtime = {
      image: "archestra-transcript-agent:test",
      command: ["/bin/sh"],
      inferenceProtocol: "anthropic" as const,
      backend: "kubernetes" as const,
      steerMode: "tmux_keys" as const,
      privileged: false,
      resources: { cpuRequest: "100m", memoryRequest: "128Mi" },
      environment: null,
      credentials: null,
      ttlHours: 1,
      idleTimeoutMinutes: 5,
    };
    const agent = await makeAgent({ organizationId: org.id, runtime });
    // A second definition with the same configuration must not allocate another pool.
    await makeAgent({ organizationId: org.id, runtime });
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: user.id,
    });
    const specBase = {
      poolScope: `${org.id}:default`,
      agentRuntimeId: agent.id,
      runtimeScope: namespace,
      image: runtime.image,
      privileged: false,
      resources: runtime.resources,
      secretEnv: { TEST_PRIVATE_VALUE: "isolated-test-value" },
      activeDeadlineSeconds: 600,
      workspaceStorageSize: "1Gi",
      nodeSelector: {},
      imagePullSecrets: [],
      inputFileCount: 0,
      effectiveNetworkPolicy: { source: "built_in" as const, policy: null },
    };
    async function makeRun(name?: string) {
      const task = await A2ATaskModel.create({
        contextId: context.id,
        agentId: agent.id,
        state: "TASK_STATE_WORKING",
      });
      const workloadName = name ?? `workspace-${task.id.slice(0, 8)}`;
      const session = await AgentRunModel.create({
        taskId: task.id,
        agentId: agent.id,
        organizationId: org.id,
        actorKind: "user",
        actorId: user.id,
        actorUserId: user.id,
        backend: "kubernetes",
        runtimeScope: namespace,
        workloadName,
      });
      const spec: AgentRunLaunchSpec = {
        ...specBase,
        taskId: task.id,
        frozenName: workloadName,
        env: { ARCHESTRA_AGENT_RUNTIME_TASK_ID: task.id },
        command: [
          "/bin/sh",
          "-c",
          'printf "%s\\n" "$TEST_PRIVATE_VALUE" >> /home/node/result; echo WARM_OK',
        ],
      };
      return { session, spec };
    }
    function objects(kind: string) {
      return JSON.parse(kubectl(["-n", namespace, "get", kind, "-o", "json"]))
        .items;
    }
    function podFor(name: string) {
      return objects("pods").find(
        (pod: { metadata: { labels?: Record<string, string> } }) =>
          pod.metadata.labels?.["archestra.io/agent-workspace"] === name,
      );
    }
    function exec(name: string, command: string) {
      return kubectl([
        "-n",
        namespace,
        "exec",
        podFor(name).metadata.name,
        "-c",
        "agent-runtime",
        "--",
        "/bin/sh",
        "-c",
        command,
      ]).trim();
    }
    try {
      await agentWarmPoolManager.reconcile();
      await until(
        () => objects("sandboxwarmpools")[0]?.status?.readyReplicas === 1,
      );
      expect(objects("sandboxwarmpools")).toHaveLength(1);
      const warmPod = objects("pods")[0];
      expect(JSON.stringify(warmPod.spec)).not.toContain("TEST_PRIVATE_VALUE");
      expect(JSON.stringify(warmPod.spec)).not.toContain(agent.id);
      const first = await makeRun();
      const second = await makeRun();
      first.spec.renewableCredentials = {
        TEST_RENEWABLE: {
          credentialId: "test-binding",
          value: "projected-value",
          expiresAt: Date.now() + 60 * 60_000,
        },
      };
      const start = Date.now();
      await Promise.all([
        manager.launch(first.spec),
        manager.launch(second.spec),
      ]);
      const elapsed = Date.now() - start;
      for (const run of [first, second])
        await until(
          () =>
            exec(
              run.session.workloadName,
              `cat /var/run/archestra/turns/${run.session.taskId}.exit`,
            ) === "0",
        );
      for (const run of [first, second]) {
        expect(
          await manager.waitForCompletion({ session: run.session }),
        ).toEqual({ outcome: "succeeded" });
      }
      const firstPod = podFor(first.session.workloadName);
      const secondPod = podFor(second.session.workloadName);
      expect(firstPod.metadata.uid).not.toBe(secondPod.metadata.uid);
      expect([firstPod.metadata.uid, secondPod.metadata.uid]).toContain(
        warmPod.metadata.uid,
      );
      expect(exec(first.session.workloadName, "cat /home/node/result")).toBe(
        "isolated-test-value",
      );
      expect(exec(second.session.workloadName, "cat /home/node/result")).toBe(
        "isolated-test-value",
      );
      await until(
        () => objects("sandboxwarmpools")[0]?.status?.readyReplicas === 1,
      );
      expect(objects("sandboxclaims")).toHaveLength(2);
      const connection = await manager.getWorkspaceConnection(first.session);
      expect(connection?.shellCommand).toContain(firstPod.metadata.name);
      expect(
        JSON.parse(
          exec(
            first.session.workloadName,
            "cat /var/run/archestra/credentials/current.json",
          ),
        ).credentials.TEST_RENEWABLE.value,
      ).toBe("projected-value");
      exec(
        first.session.workloadName,
        "rm /var/run/archestra/credentials/current.json",
      );
      await manager.refreshCredentials(first.session);
      expect(
        JSON.parse(
          exec(
            first.session.workloadName,
            "cat /var/run/archestra/credentials/current.json",
          ),
        ).credentials.TEST_RENEWABLE.value,
      ).toBe("projected-value");
      await manager.releaseRun(first.session);
      expect(
        JSON.parse(
          exec(
            first.session.workloadName,
            "cat /var/run/archestra/credentials/current.json",
          ),
        ),
      ).toEqual({});
      config.agentRuntime.warmPoolSize = 0;
      await agentWarmPoolManager.reconcile();
      expect(objects("sandboxwarmpools")[0].spec.replicas).toBe(0);
      await until(() => objects("persistentvolumeclaims").length === 2);
      await manager.suspendWorkspace(first.session);
      await until(() => !podFor(first.session.workloadName));
      await manager.resumeWorkspace(first.session);
      expect(exec(first.session.workloadName, "cat /home/node/result")).toBe(
        "isolated-test-value",
      );
      const next = await makeRun(first.session.workloadName);
      next.spec.command = [
        "/bin/sh",
        "-c",
        'test "$ARCHESTRA_AGENT_RUNTIME_CONTINUE" = 1; printf continued >> /home/node/result',
      ];
      next.spec.secretEnv = {};
      await manager.continueRun(next);
      await until(
        () =>
          exec(
            next.session.workloadName,
            `cat /var/run/archestra/turns/${next.session.taskId}.exit`,
          ) === "0",
      );
      await manager.recoverRun(next.session);
      expect(exec(next.session.workloadName, "cat /home/node/result")).toBe(
        "isolated-test-value\ncontinued",
      );
      await manager.deleteWorkspace(first.session);
      await manager.deleteWorkspace(second.session);
      await until(
        () =>
          objects("sandboxclaims").length === 0 &&
          objects("persistentvolumeclaims").length === 0,
      );
      await agentWarmPoolManager.reconcile();
      expect(objects("sandboxwarmpools")).toHaveLength(0);
      expect(objects("sandboxtemplates")).toHaveLength(0);
      process.stdout.write(
        `Warm allocation plus concurrent cold fallback: ${elapsed}ms; original pod reused, lifecycle and cleanup verified.\n`,
      );
    } finally {
      kubectl(["delete", "namespace", namespace, "--wait=false"]);
    }
  },
  240_000,
);

function kubectl(args: string[]) {
  const result = spawnSync("kubectl", ["--context=orbstack", ...args], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.status !== 0)
    throw new Error(result.stderr || String(result.error));
  return result.stdout;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 90_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${String(lastError)}`);
}
