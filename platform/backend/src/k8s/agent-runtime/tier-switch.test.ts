import type { V1Pod } from "@kubernetes/client-node";
import { describe, expect, test, vi } from "vitest";
import McpDeploymentLeaseModel from "@/models/mcp-deployment-lease";
import type { AgentRuntimeTierSettings } from "@/services/agent-runtime/backends";
import type { AgentRunRecord } from "@/types";
import manager from "./manager";
import {
  AGENT_RUNTIME_CONTAINER_NAME,
  type AgentSandbox,
  buildAgentRuntimeSandbox,
} from "./manifests";
import {
  AGENT_RUNTIME_TIER_ANNOTATION,
  AGENT_RUNTIME_TIER_SWITCH_ANNOTATION,
  AGENT_RUNTIME_WORKSPACE_LABEL,
} from "./naming";
import { agentSandboxApi } from "./sandbox-api";

const TASK_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NAME = "agent-run-lobster-aaaaaaaa";
const SESSION = {
  id: "11111111-2222-4333-8444-555555555555",
  taskId: TASK_ID,
  workloadName: NAME,
  runtimeScope: "agents",
} as AgentRunRecord;
const LIGHT: AgentRuntimeTierSettings = {
  image: "registry.example.test/lobster-env-codex-lite:abc",
  privileged: false,
  resources: { cpuRequest: "2", memoryRequest: "4Gi", memoryLimit: "8Gi" },
};
const FULL: AgentRuntimeTierSettings = {
  image: "registry.example.test/lobster-env-codex:abc",
  privileged: true,
  resources: {
    cpuRequest: "3500m",
    memoryRequest: "12Gi",
    memoryLimit: "18Gi",
  },
};

describe("switchWorkspaceTier", () => {
  test("stops the Pod, moves the template and continues the running turn on the new tier", async () => {
    const cluster = fakeCluster();
    try {
      const switched = await manager.switchWorkspaceTier({
        session: SESSION,
        tier: "full",
        settings: FULL,
        resumePrompt: "continue on full",
        shouldResume: async () => true,
      });
      expect(switched).toBe(true);
      // The note for the running turn lands before the Pod is stopped.
      expect(cluster.events.slice(0, 3)).toEqual([
        "exec:plan-turn-resume",
        `annotate:${AGENT_RUNTIME_TIER_SWITCH_ANNOTATION}=${TASK_ID}`,
        "mode:Suspended",
      ]);
      expect(cluster.resumeNotes).toEqual(["continue on full"]);
      expect(cluster.events).toContain("mode:Running");
      expect(cluster.events.at(-1)).toBe(
        `annotate:${AGENT_RUNTIME_TIER_SWITCH_ANNOTATION}=null`,
      );
      const container = agentContainer(cluster.sandbox);
      expect(container?.image).toBe(FULL.image);
      expect(container?.securityContext).toEqual({ privileged: true });
      expect(container?.env).toEqual(
        expect.arrayContaining([
          { name: "ARCHESTRA_AGENT_RUNTIME_TIER", value: "full" },
          { name: "ARCHESTRA_AGENT_RUNTIME_RESUME_TURN", value: TASK_ID },
        ]),
      );
      expect(
        cluster.sandbox.spec.podTemplate.spec?.initContainers?.[0]?.image,
      ).toBe(FULL.image);
      expect(cluster.sandbox.metadata.annotations).toEqual({
        [AGENT_RUNTIME_TIER_ANNOTATION]: "full",
      });
      expect(cluster.pods[0]?.spec?.containers[0]?.image).toBe(FULL.image);

      // A second request finds the workspace already there.
      expect(
        await manager.switchWorkspaceTier({
          session: SESSION,
          tier: "full",
          settings: FULL,
          resumePrompt: "unused",
          shouldResume: async () => true,
        }),
      ).toBe(false);
    } finally {
      cluster.restore();
    }
  });

  test("writes the note in a Pod the API does not report running yet", async () => {
    const cluster = fakeCluster({ pendingReads: 3 });
    try {
      await manager.switchWorkspaceTier({
        session: SESSION,
        tier: "full",
        settings: FULL,
        resumePrompt: "continue on full",
        shouldResume: async () => true,
      });
      expect(cluster.events[0]).toBe("exec:plan-turn-resume");
      expect(cluster.resumeNotes).toEqual(["continue on full"]);
    } finally {
      cluster.restore();
    }
  });

  test("leaves a workspace that already runs the tier untouched", async () => {
    const cluster = fakeCluster();
    try {
      expect(
        await manager.switchWorkspaceTier({
          session: SESSION,
          tier: "light",
          settings: LIGHT,
          resumePrompt: "unused",
          shouldResume: async () => true,
        }),
      ).toBe(false);
      expect(cluster.events).toEqual([]);
    } finally {
      cluster.restore();
    }
  });

  test("does not wake or name a turn that was canceled while the Pod stopped", async () => {
    const cluster = fakeCluster();
    try {
      await manager.switchWorkspaceTier({
        session: SESSION,
        tier: "full",
        settings: FULL,
        resumePrompt: "continue on full",
        shouldResume: async () => false,
      });
      expect(cluster.sandbox.spec.operatingMode).toBe("Suspended");
      expect(cluster.events).not.toContain("mode:Running");
      expect(agentContainer(cluster.sandbox)?.image).toBe(LIGHT.image);
      expect(
        agentContainer(cluster.sandbox)?.env?.some(
          ({ name }) => name === "ARCHESTRA_AGENT_RUNTIME_RESUME_TURN",
        ),
      ).toBe(false);
      expect(cluster.sandbox.metadata.annotations).toEqual({
        [AGENT_RUNTIME_TIER_ANNOTATION]: "light",
      });
    } finally {
      cluster.restore();
    }
  });

  test("stops the continuation of a turn that ended while the Pod started", async () => {
    const cluster = fakeCluster();
    let checks = 0;
    try {
      await manager.switchWorkspaceTier({
        session: SESSION,
        tier: "full",
        settings: FULL,
        resumePrompt: "continue on full",
        // In progress before the start, ended right after it.
        shouldResume: async () => ++checks === 1,
      });
      expect(cluster.events).toContain("mode:Running");
      expect(cluster.events).toContain("exec:cancel-turn");
    } finally {
      cluster.restore();
    }
  });

  test("puts the previous tier back when the new one cannot start", async () => {
    const cluster = fakeCluster({ failingImage: FULL.image });
    try {
      await expect(
        manager.switchWorkspaceTier({
          session: SESSION,
          tier: "full",
          settings: FULL,
          resumePrompt: "continue",
          shouldResume: async () => true,
        }),
      ).rejects.toThrow();
      const container = agentContainer(cluster.sandbox);
      expect(container?.image).toBe(LIGHT.image);
      expect(container?.securityContext).toEqual({
        allowPrivilegeEscalation: false,
      });
      expect(
        container?.volumeMounts?.some(
          ({ mountPath }) => mountPath === "/var/lib/docker",
        ),
      ).toBe(false);
      // The turn is still named, so it continues on the tier it came from.
      expect(container?.env).toContainEqual({
        name: "ARCHESTRA_AGENT_RUNTIME_RESUME_TURN",
        value: TASK_ID,
      });
      expect(cluster.sandbox.metadata.annotations).toEqual({
        [AGENT_RUNTIME_TIER_ANNOTATION]: "light",
      });
      expect(cluster.sandbox.spec.operatingMode).toBe("Running");
      expect(cluster.pods[0]?.status?.phase).toBe("Running");
    } finally {
      cluster.restore();
    }
  }, 30_000);
});

describe("recoverRun", () => {
  test("leaves a Sandbox to a tier switch that is still running", async () => {
    const cluster = fakeCluster();
    cluster.sandbox.spec.operatingMode = "Suspended";
    cluster.sandbox.metadata.annotations = {
      [AGENT_RUNTIME_TIER_SWITCH_ANNOTATION]: TASK_ID,
    };
    cluster.pods.length = 0;
    try {
      await McpDeploymentLeaseModel.withLease(
        { scope: "agent-run-tier-switch", key: SESSION.id },
        () => manager.recoverRun(SESSION),
      );
      expect(cluster.sandbox.spec.operatingMode).toBe("Suspended");
      expect(cluster.events).toEqual([]);
    } finally {
      cluster.restore();
    }
  });

  test("wakes a Sandbox whose tier switch stopped when its process ended", async () => {
    const cluster = fakeCluster();
    cluster.sandbox.spec.operatingMode = "Suspended";
    cluster.sandbox.metadata.annotations = {
      [AGENT_RUNTIME_TIER_ANNOTATION]: "full",
      [AGENT_RUNTIME_TIER_SWITCH_ANNOTATION]: TASK_ID,
    };
    cluster.pods.length = 0;
    try {
      await manager.recoverRun(SESSION);
      expect(cluster.sandbox.spec.operatingMode).toBe("Running");
      expect(cluster.pods).toHaveLength(1);
      // The turn is named, so the supervisor continues it there.
      expect(agentContainer(cluster.sandbox)?.env).toContainEqual({
        name: "ARCHESTRA_AGENT_RUNTIME_RESUME_TURN",
        value: TASK_ID,
      });
      expect(cluster.sandbox.metadata.annotations).toEqual({
        [AGENT_RUNTIME_TIER_ANNOTATION]: "full",
      });
    } finally {
      cluster.restore();
    }
  });
});

function agentContainer(sandbox: AgentSandbox) {
  return sandbox.spec.podTemplate.spec?.containers.find(
    ({ name }) => name === AGENT_RUNTIME_CONTAINER_NAME,
  );
}

/**
 * A Sandbox and its Pod as the controller keeps them: suspension removes the
 * Pod, Running creates one from the current template. An image in
 * `failingImage` produces a Pod that fails to start.
 */
function fakeCluster(
  options: { failingImage?: string; pendingReads?: number } = {},
) {
  const sandbox = buildAgentRuntimeSandbox({
    taskId: TASK_ID,
    agentRuntimeId: "99999999-8888-4777-8666-555555555555",
    frozenName: NAME,
    namespace: SESSION.runtimeScope,
    command: ["codex"],
    ...LIGHT,
    tier: "light",
    env: {},
    secretEnv: {},
    activeDeadlineSeconds: 3600,
    nodeSelector: {},
    imagePullSecrets: [],
    ownerReferences: undefined,
    effectiveNetworkPolicy: { source: "built_in", policy: null },
    inputFileCount: 0,
  });
  sandbox.metadata.uid = "sandbox-uid";
  const pods: V1Pod[] = [];
  let pendingReads = options.pendingReads ?? 0;
  const events: string[] = [];
  const resumeNotes: string[] = [];
  const startPod = () => {
    const spec = structuredClone(sandbox.spec.podTemplate.spec);
    const failing = spec?.containers.some(
      ({ image }) => image === options.failingImage,
    );
    pods.splice(0, pods.length, {
      metadata: {
        name: `${NAME}-pod`,
        labels: { [AGENT_RUNTIME_WORKSPACE_LABEL]: NAME },
      },
      spec,
      status: { phase: failing ? "Failed" : "Running" },
    });
  };
  startPod();
  const internals = manager as unknown as {
    clients: unknown;
    execInPod: (params: {
      command: string[];
      stdin?: NodeJS.ReadableStream;
    }) => Promise<string>;
  };
  const originalClients = internals.clients;
  const installed = vi
    .spyOn(agentSandboxApi, "isInstalled", "get")
    .mockReturnValue(true);
  const exec = vi
    .spyOn(internals, "execInPod")
    .mockImplementation(async ({ command, stdin }) => {
      const name = command[3];
      events.push(`exec:${name}`);
      if (name === "plan-turn-resume" && stdin) {
        let note = "";
        for await (const chunk of stdin) note += chunk.toString();
        resumeNotes.push(note);
      }
      return name === "check-turn" ? "present" : "";
    });
  internals.clients = {
    customObjectsApi: {
      getNamespacedCustomObject: async () => structuredClone(sandbox),
      patchNamespacedCustomObject: async ({
        body,
      }: {
        body: Record<string, unknown>;
      }) => {
        const patch = body as {
          metadata?: { annotations?: Record<string, string | null> };
          spec?: Partial<AgentSandbox["spec"]>;
        };
        for (const [key, value] of Object.entries(
          patch.metadata?.annotations ?? {},
        )) {
          events.push(`annotate:${key}=${value}`);
          const annotations = { ...sandbox.metadata.annotations };
          if (value === null) delete annotations[key];
          else annotations[key] = value;
          sandbox.metadata.annotations = annotations;
        }
        const podTemplateSpec = patch.spec?.podTemplate?.spec;
        if (podTemplateSpec && sandbox.spec.podTemplate.spec)
          Object.assign(sandbox.spec.podTemplate.spec, podTemplateSpec);
        const mode = patch.spec?.operatingMode;
        if (mode) {
          events.push(`mode:${mode}`);
          sandbox.spec.operatingMode = mode;
          if (mode === "Suspended") pods.splice(0);
          else startPod();
        }
        return sandbox;
      },
    },
    coreApi: {
      listNamespacedPod: async () => {
        // The kubelet reports a started container's Pod a moment later.
        if (pendingReads > 0 && pods[0]?.status) {
          pendingReads--;
          return {
            items: [
              { ...structuredClone(pods[0]), status: { phase: "Pending" } },
            ],
          };
        }
        return { items: structuredClone(pods) };
      },
      readNamespacedSecret: async () => {
        throw { code: 404 };
      },
    },
  };
  return {
    sandbox,
    pods,
    events,
    resumeNotes,
    restore() {
      internals.clients = originalClients;
      installed.mockRestore();
      exec.mockRestore();
    },
  };
}
