import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  AGENT_CATALOG_IMAGE_REGISTRY,
  getAgentCatalogImages,
} from "@archestra/shared";
import { KubeConfig } from "@kubernetes/client-node";
import config from "@/config";
import { A2AContextModel, A2ATaskModel, AgentRunModel } from "@/models";
import type { AgentRunLaunchSpec } from "@/services/agent-runtime/backends";
import { expect, test, vi } from "@/test";
import manager from "./manager";
import { buildAgentRuntimeSandbox } from "./manifests";
import { agentSandboxApi } from "./sandbox-api";

// Real controller/PVC/exec integration. Never target the ambient context.
// Uses two published maintained tags, so the first run pulls them.
test.skipIf(process.env.ARCHESTRA_TEST_SANDBOX_CONTEXT !== "orbstack")(
  "continues a workspace on the current maintained image after an upgrade",
  async ({ makeOrganization, makeUser, makeAgent }) => {
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
    expect(config.orchestrator.kubernetes.kubeconfig).toBeFalsy();
    const load = KubeConfig.prototype.loadFromDefault;
    vi.spyOn(KubeConfig.prototype, "loadFromDefault").mockImplementation(
      function (this: KubeConfig) {
        load.call(this);
        this.setCurrentContext("orbstack");
      },
    );
    const savedImage = `${AGENT_CATALOG_IMAGE_REGISTRY}/agent-claude-code:1.4.0-rc.36`;
    const currentImages = getAgentCatalogImages({
      registry: AGENT_CATALOG_IMAGE_REGISTRY,
      tag: "1.4.0-rc.37",
    });
    const originalImages = config.agentRuntime.catalogImages;
    config.agentRuntime.catalogImages = currentImages;

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
    const name = `image-move-${task.id.slice(0, 8)}`;
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
      image: currentImages["claude-code"],
      command: ["/bin/sh", "-c", "printf after >> /home/node/image-move"],
      privileged: false,
      resources: { cpuRequest: "100m", memoryRequest: "128Mi" },
      env: { ARCHESTRA_AGENT_RUNTIME_TASK_ID: task.id },
      secretEnv: {},
      activeDeadlineSeconds: 600,
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
          stringData: {
            ARCHESTRA_AGENT_RUNTIME_RENEWABLE_CREDENTIALS: JSON.stringify({
              taskId: initialTaskId,
              credentials: {},
            }),
          },
        }),
      );
      kubectl(
        ["apply", "-f", "-"],
        JSON.stringify(
          buildAgentRuntimeSandbox({
            ...manifestSpec,
            image: savedImage,
            namespace: runtimeScope,
            taskId: initialTaskId,
            env: { ARCHESTRA_AGENT_RUNTIME_TASK_ID: initialTaskId },
            command: ["/bin/sh", "-c", "printf before > /home/node/image-move"],
            ownerReferences: undefined,
          }),
        ),
      );
      await until(
        () =>
          exec(`cat /var/run/archestra/turns/${initialTaskId}.exit`).trim() ===
          "0",
      );

      // An image the author chose is still theirs to change deliberately.
      await expect(
        manager.continueRun({
          session: run,
          spec: { ...spec, image: "registry.example/team/custom-agent:2" },
        }),
      ).rejects.toThrow("start a new workspace instead");
      expect(podImages()).toEqual([savedImage, savedImage]);

      await manager.continueRun({ session: run, spec });
      await until(
        () =>
          exec(`cat /var/run/archestra/turns/${task.id}.exit`).trim() === "0",
      );
      expect(podImages()).toEqual([
        currentImages["claude-code"],
        currentImages["claude-code"],
      ]);
      expect(exec("cat /home/node/image-move")).toBe("beforeafter");
    } finally {
      config.agentRuntime.catalogImages = originalImages;
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

    function podImages() {
      const pod = JSON.parse(kubectl(["get", "pod", name, "-o", "json"]));
      return [pod.spec.initContainers[0].image, pod.spec.containers[0].image];
    }
  },
  300_000,
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
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      if (check()) return;
    } catch {
      /* Pod may not exist yet, or is moving to the new image. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Disposable Sandbox did not reach the expected state");
}
