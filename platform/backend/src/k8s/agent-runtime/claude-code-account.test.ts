import { KubeConfig } from "@kubernetes/client-node";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { ResolvedAgentRuntime } from "@/types";
import { claudeCodeAccountManager } from "./claude-code-account";
import { execAgentRuntimeCommand } from "./exec";

// Only Kubernetes transport and native subprocess execution are substituted.
vi.mock("@/k8s/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/k8s/shared")>()),
  loadKubeConfig: () => {
    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromOptions({
      clusters: [{ name: "test", server: "https://kubernetes.example.test" }],
      users: [{ name: "test" }],
      contexts: [{ name: "test", cluster: "test", user: "test" }],
      currentContext: "test",
    });
    return { kubeConfig, namespace: "account-tests" };
  },
}));
vi.mock("./exec", () => ({ execAgentRuntimeCommand: vi.fn() }));
// biome-ignore lint/correctness/useHookAtTopLevel: This helper installs Vitest lifecycle hooks, not React hooks.
const server = useMswServer();

beforeEach(() => {
  vi.mocked(execAgentRuntimeCommand).mockReset();
});

describe("Claude Code native account storage", () => {
  test("keeps account and model discovery isolated by user, Agent, organization, and environment", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const organization = await makeOrganization({
      defaultEnvironmentNamespace: "first-environment",
    });
    const otherOrganization = await makeOrganization({
      defaultEnvironmentNamespace: "second-environment",
    });
    const user = await makeUser();
    const otherUser = await makeUser();
    const agent = await makeAgent({ organizationId: organization.id });
    const otherAgent = await makeAgent({ organizationId: organization.id });
    const runtime: ResolvedAgentRuntime = {
      agentId: agent.id,
      organizationId: organization.id,
      secretId: null,
      environmentId: null,
      image: "example.test/agent-claude-code:latest",
      command: ["archestra-claude-code"],
      inferenceProtocol: "anthropic",
      backend: "kubernetes",
      steerMode: "tmux_keys",
      privileged: false,
      environment: [],
      credentials: [],
      resources: null,
      ttlHours: null,
      idleTimeoutMinutes: null,
      maxCostUsd: null,
      claudeCode: { authentication: "subscription" },
    };
    const requested: string[] = [];
    let connectedPod: string | undefined;
    server.use(
      http.get(
        "https://kubernetes.example.test/api/v1/namespaces/:namespace/pods/:name",
        ({ params }) => {
          const resource = `${params.namespace}/${params.name}`;
          requested.push(resource);
          if (resource !== connectedPod)
            return HttpResponse.json(
              { kind: "Status", code: 404, reason: "NotFound" },
              { status: 404 },
            );
          return HttpResponse.json({
            metadata: { name: params.name },
            status: { phase: "Running" },
            spec: { containers: [{ image: runtime.image }] },
          });
        },
      ),
    );
    const owner = { runtime, userId: user.id };
    expect(await claudeCodeAccountManager.status(owner)).toEqual({
      state: "disconnected",
    });
    connectedPod = requested[0];
    vi.mocked(execAgentRuntimeCommand).mockImplementation(async ({ command }) =>
      JSON.stringify(
        command[1] === "models"
          ? {
              models: [
                {
                  value: "new-cli-model",
                  displayName: "New CLI model",
                  description: "Native metadata",
                },
              ],
            }
          : { state: "connected" },
      ),
    );
    expect(await claudeCodeAccountManager.status(owner)).toEqual({
      state: "connected",
    });
    expect((await claudeCodeAccountManager.models(owner)).models[0].value).toBe(
      "new-cli-model",
    );
    for (const isolatedOwner of [
      { runtime, userId: otherUser.id },
      { runtime: { ...runtime, agentId: otherAgent.id }, userId: user.id },
      {
        runtime: { ...runtime, organizationId: otherOrganization.id },
        userId: user.id,
      },
    ]) {
      expect(await claudeCodeAccountManager.status(isolatedOwner)).toEqual({
        state: "disconnected",
      });
      expect(await claudeCodeAccountManager.models(isolatedOwner)).toEqual({
        models: [],
      });
    }
    await expect(
      claudeCodeAccountManager.complete({
        runtime,
        userId: otherUser.id,
        flowId: crypto.randomUUID(),
        code: "another-users-flow",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      claudeCodeAccountManager.requireConnection({
        runtime,
        userId: otherUser.id,
        runtimeScope: "first-environment",
      }),
    ).rejects.toMatchObject({
      code: "AGENT_RUNTIME_CREDENTIALS_REQUIRED",
      agentId: agent.id,
      missing: [
        {
          key: "CLAUDE_CODE_ACCOUNT",
          label: "Claude Code account",
          description: expect.any(String),
        },
      ],
    });
    expect(new Set(requested).size).toBe(4);
    expect(requested).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^first-environment\//),
        expect.stringMatching(/^second-environment\//),
      ]),
    );
    expect(execAgentRuntimeCommand).toHaveBeenCalledTimes(2);
    await expect(
      claudeCodeAccountManager.requireConnection({
        ...owner,
        runtimeScope: "different-environment",
      }),
    ).rejects.toThrow("different environment");
    await expect(
      claudeCodeAccountManager.status({
        ...owner,
        runtime: { ...runtime, command: ["another-harness"] },
      }),
    ).rejects.toThrow("only available in the Claude Code runtime");
  });
});
