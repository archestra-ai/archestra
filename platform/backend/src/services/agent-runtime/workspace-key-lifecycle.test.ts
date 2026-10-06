import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  CoreV1Api,
  CustomObjectsApi,
  Exec,
  KubeConfig,
  NetworkingV1Api,
  type V1ObjectMeta,
} from "@kubernetes/client-node";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import type WebSocket from "ws";
import config from "@/config";
import db, { schema } from "@/database";
import manager from "@/k8s/agent-runtime/manager";
import { AGENT_RUNTIME_CONTAINER_NAME } from "@/k8s/agent-runtime/manifests";
import {
  AGENT_RUNTIME_TASK_LABEL,
  agentRuntimeNames,
} from "@/k8s/agent-runtime/naming";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import { AGENT_RUNTIME_CREDENTIALS_SECRET_KEY } from "@/services/agent-runtime/runtime-contract";
import { afterEach, beforeEach, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { ResolvedAgentRuntime } from "@/types";
import { kubernetesAgentRuntimeBackendDriver as backend } from "./backends/kubernetes";
import { assertRuntimeCredentialLease } from "./credential-lease";
import { resumeAgentRun, runTaskInAgentRuntime } from "./pod-run";
import { agentRunReconciler } from "./reconciler";

// Isolate the manager's real cached clients. Only Kubernetes I/O is stubbed.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    agentRuntime: {
      enabled: true,
      platformBaseUrl: "https://platform.example.test",
    },
    openappa: { enabled: false },
    orchestrator: {
      kubernetes: { kubeconfig: "", loadKubeconfigFromCurrentCluster: false },
    },
  }),
);

const secrets = new Map<
  string,
  { metadata?: V1ObjectMeta; data: Record<string, string> }
>();
let publicationFails = false;
let exitStatus = "0";
let workload = "";
let originalTask = "";
// biome-ignore lint/correctness/useHookAtTopLevel: MSW test lifecycle helper, not React.
const server = useMswServer();

beforeEach(() => {
  config.openappa.enabled = false;
  publicationFails = false;
  exitStatus = "0";
  workload = `key-lifecycle-${randomUUID()}`;
  secrets.clear();
  server.use(
    http.get("https://kubernetes.example.test/*", () =>
      HttpResponse.json({ groups: [], items: [], major: "1", minor: "31" }),
    ),
    http.post("https://api.openai.com/v1/chat/completions", () =>
      HttpResponse.json({
        id: "title",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Turn" },
            finish_reason: "stop",
          },
        ],
      }),
    ),
  );
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
  vi.spyOn(CoreV1Api.prototype, "listNamespacedPod").mockResolvedValue({
    items: [{ metadata: { name: "worker" }, status: { phase: "Running" } }],
  });
  vi.spyOn(
    CustomObjectsApi.prototype,
    "getNamespacedCustomObject",
  ).mockImplementation(async () => ({
    apiVersion: "agents.x-k8s.io/v1beta1",
    kind: "Sandbox",
    metadata: {
      name: workload,
      labels: { [AGENT_RUNTIME_TASK_LABEL]: originalTask },
    },
    spec: {
      podTemplate: {
        metadata: { labels: { [AGENT_RUNTIME_TASK_LABEL]: originalTask } },
        spec: {
          containers: [
            { name: AGENT_RUNTIME_CONTAINER_NAME, image: "test-agent:latest" },
          ],
        },
      },
    },
    status: {},
  }));
  vi.spyOn(
    CustomObjectsApi.prototype,
    "patchNamespacedCustomObject",
  ).mockResolvedValue({});
  vi.spyOn(
    CustomObjectsApi.prototype,
    "deleteNamespacedCustomObject",
  ).mockResolvedValue({});
  vi.spyOn(
    NetworkingV1Api.prototype,
    "createNamespacedNetworkPolicy",
  ).mockResolvedValue({});
  vi.spyOn(
    NetworkingV1Api.prototype,
    "deleteNamespacedNetworkPolicy",
  ).mockResolvedValue({});
  vi.spyOn(CoreV1Api.prototype, "listNamespacedService").mockResolvedValue({
    items: [],
  });
  vi.spyOn(CoreV1Api.prototype, "readNamespacedSecret").mockImplementation(
    async ({ name }) => {
      const secret = secrets.get(name);
      if (!secret)
        throw Object.assign(new Error("Secret not found"), {
          statusCode: 404,
          code: 404,
        });
      return secret;
    },
  );
  vi.spyOn(CoreV1Api.prototype, "patchNamespacedSecret").mockImplementation(
    async ({ name, body }) => {
      const value = secrets.get(name) ?? {
        data: {
          [AGENT_RUNTIME_CREDENTIALS_SECRET_KEY]: "prior-credential-bundle",
          STARTUP_TOKEN: "prior-process-token",
        },
      };
      Object.assign(
        value.data,
        body.data ?? {},
        Object.fromEntries(
          Object.entries(body.stringData ?? {}).map(([key, value]) => [
            key,
            Buffer.from(String(value)).toString("base64"),
          ]),
        ),
      );
      secrets.set(name, value);
      return {};
    },
  );
  vi.spyOn(CoreV1Api.prototype, "createNamespacedSecret").mockImplementation(
    async ({ body }) => {
      if (!body.metadata?.name) throw new Error("Expected handoff secret name");
      secrets.set(body.metadata.name, {
        metadata: body.metadata,
        data: Object.fromEntries(
          Object.entries(body.stringData ?? {}).map(([key, value]) => [
            key,
            Buffer.from(String(value)).toString("base64"),
          ]),
        ),
      });
      return body;
    },
  );
  vi.spyOn(CoreV1Api.prototype, "deleteNamespacedSecret").mockImplementation(
    async ({ name }) => {
      secrets.delete(name);
      return {};
    },
  );
  vi.spyOn(Exec.prototype, "exec").mockImplementation(async (...args) => {
    const command = args[3];
    if (command.includes("enqueue-turn") && publicationFails)
      throw new Error("Publication connection lost");
    args[4]?.write(
      command.includes("read-turn-result")
        ? exitStatus
        : command[0] === "tmux"
          ? "1:"
          : command.includes("check-turn")
            ? "present"
            : "Complete retained transcript",
    );
    setTimeout(() => args[8]?.({ status: "Success" }), 0);
    return Object.assign(new EventEmitter(), {
      close: vi.fn(),
      terminate: vi.fn(),
    }) as unknown as WebSocket;
  });
});
afterEach(() => vi.restoreAllMocks());

for (const outcome of [
  "success",
  "failure",
  "cancel",
  "publication-failure",
  "suspension",
] as const) {
  test(`real manager preserves the leased key through ${outcome} and a later continuation`, async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeAdmin();
    await makeMember(user.id, org.id, { role: "admin" });
    const secret = await makeSecret({
      secret: { apiKey: "fixture-upstream-key" },
    });
    const provider = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });
    const model = await ModelModel.create({
      externalId: "openai/lifecycle-fixture",
      provider: "openai",
      modelId: "lifecycle-fixture",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(provider.id, [
      model.id,
    ]);
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: user.id,
      agentType: "agent",
      modelId: model.id,
      llmApiKeyId: provider.id,
    });
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: user.id,
    });
    const firstTask = await A2ATaskModel.createForRun({
      contextId: context.id,
      agentId: agent.id,
    });
    const deadline = new Date(Date.now() + 3600_000);
    const runtimeScope = backend.resolveRuntimeScope({
      organizationScope: org.defaultEnvironmentNamespace,
    });
    const key = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "leased-runtime-key",
      scope: "personal",
      authorId: user.id,
      expiresAt: deadline,
      providerApiKeys: [{ provider: "openai", providerApiKeyId: provider.id }],
    });
    const first = await AgentRunModel.create({
      organizationId: org.id,
      agentId: agent.id,
      taskId: firstTask.id,
      actorKind: "user",
      actorId: user.id,
      actorUserId: user.id,
      backend: "kubernetes",
      runtimeScope,
      workloadName: workload,
      virtualApiKeyId: key.virtualKey.id,
    });
    originalTask = first.taskId;
    secrets.set(agentRuntimeNames(workload).secret, {
      data: {
        [AGENT_RUNTIME_CREDENTIALS_SECRET_KEY]: "prior-renewable-bundle",
        STARTUP_TOKEN: "prior-process-token",
      },
    });
    await AgentWorkspaceModel.create({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: user.id,
      backend: "kubernetes",
      runtimeScope,
      workloadName: workload,
      state: "active",
      activeTaskId: first.taskId,
      lastTaskId: first.taskId,
      expiresAt: deadline,
    });
    if (outcome === "failure") exitStatus = "1";
    const abort = new AbortController();
    if (outcome === "cancel") abort.abort();
    if (outcome === "failure")
      await expect(
        resumeAgentRun({
          session: first,
          abortSignal: abort.signal,
        }),
      ).rejects.toThrow();
    else
      await resumeAgentRun({
        session: first,
        abortSignal: abort.signal,
      });
    expect(
      (await AgentWorkspaceModel.findByWorkloadName(workload))?.state,
    ).toBe("idle");
    expect(
      (await AgentRunModel.findByTaskId(first.taskId))?.virtualApiKeyId,
    ).toBe(key.virtualKey.id);
    expect(await VirtualApiKeyModel.findById(key.virtualKey.id)).not.toBeNull();
    await expect(
      assertRuntimeCredentialLease({
        organizationId: org.id,
        virtualApiKeyId: key.virtualKey.id,
        agentId: agent.id,
        callerId: `user:${user.id}`,
        sessionId: workload,
        parentId: undefined,
        enforceSession: false,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    if (outcome === "suspension") {
      await A2ATaskModel.updateState(firstTask.id, "TASK_STATE_COMPLETED");
      const workspace = await AgentWorkspaceModel.findByWorkloadName(workload);
      if (!workspace) throw new Error("Expected retained workspace");
      await db
        .update(schema.agentWorkspacesTable)
        .set({
          lastActivityAt: new Date(
            Date.now() -
              (config.agentRuntime.defaultIdleTimeoutMinutes + 1) * 60_000,
          ),
        })
        .where(eq(schema.agentWorkspacesTable.id, workspace.id));
      await agentRunReconciler.reconcile();
      expect(
        (await AgentWorkspaceModel.findByWorkloadName(workload))?.state,
      ).toBe("suspended");
      expect(
        await VirtualApiKeyModel.findById(key.virtualKey.id),
      ).not.toBeNull();
    }
    expect(
      Object.values(
        secrets.get(agentRuntimeNames(workload).secret)?.data ?? {},
      ).every((value) => value === ""),
    ).toBe(true);
    const runtime: ResolvedAgentRuntime = {
      agentId: agent.id,
      organizationId: org.id,
      environmentId: null,
      secretId: null,
      image: "test-agent:latest",
      command: null,
      inferenceProtocol: "openai_chat",
      backend: "kubernetes",
      steerMode: "pipe",
      privileged: false,
      resources: null,
      environment: null,
      credentials: null,
      ttlHours: null,
      maxCostUsd: null,
      idleTimeoutMinutes: null,
    };
    let nextTask = await A2ATaskModel.createForRun({
      contextId: context.id,
      agentId: agent.id,
    });
    publicationFails = outcome === "publication-failure";
    const continuation = () =>
      runTaskInAgentRuntime({
        taskId: nextTask.id,
        runtime,
        agentId: agent.id,
        organizationId: org.id,
        task: "Explicitly authorized next turn",
        runMode: "one_shot",
        modelId: model.id,
        llmApiKeyId: provider.id,
        actor: { kind: "user", id: user.id, organizationId: org.id },
        resumeFromTaskId: first.taskId,
      });
    if (publicationFails) {
      await expect(continuation()).rejects.toThrow(
        "Publication connection lost",
      );
      expect(
        await VirtualApiKeyModel.findById(key.virtualKey.id),
      ).not.toBeNull();
      expect(
        (await AgentWorkspaceModel.findByWorkloadName(workload))?.state,
      ).toBe("idle");
      publicationFails = false;
      nextTask = await A2ATaskModel.createForRun({
        contextId: context.id,
        agentId: agent.id,
      });
    }
    exitStatus = "0";
    await continuation();
    const next = await AgentRunModel.findByTaskId(nextTask.id);
    if (!next) throw new Error("Expected continued run");
    expect(next.virtualApiKeyId).toBe(key.virtualKey.id);
    expect(
      (
        await VirtualApiKeyModel.findById(key.virtualKey.id)
      )?.expiresAt?.getTime(),
    ).toBeLessThanOrEqual(deadline.getTime());
    // Real manager default teardown still revokes; keeping a turn is not immortalizing its key.
    await manager.releaseRun(next);
    expect(await VirtualApiKeyModel.findById(key.virtualKey.id)).toBeNull();
  });
}
