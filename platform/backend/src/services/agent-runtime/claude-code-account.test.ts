import { getAgentCatalogImages } from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import { claudeCodeAccountRuntime } from "@/k8s/agent-runtime/claude-code-account";
import { AgentModel, OrganizationModel } from "@/models";
import ClaudeCodeAccountModel from "@/models/claude-code-account";
import SecretModel from "@/models/secret";
import { secretManager } from "@/secrets-manager";
import { beforeEach, describe, expect, test } from "@/test";
import type { ResolvedAgentRuntime } from "@/types";
import { claudeCodeAccountManager as manager } from "./claude-code-account";

// Only Kubernetes availability and the disposable CLI process are replaced. All connection,
// verification, encryption, and secret operations use the real database.
beforeEach(() => {
  vi.spyOn(agentRuntimeManager, "isEnabled", "get").mockReturnValue(true);
  vi.spyOn(claudeCodeAccountRuntime, "create").mockResolvedValue(undefined);
  vi.spyOn(claudeCodeAccountRuntime, "delete").mockResolvedValue(undefined);
  vi.spyOn(claudeCodeAccountRuntime, "status").mockResolvedValue({
    state: "connecting",
  });
  vi.spyOn(claudeCodeAccountRuntime, "complete").mockResolvedValue({
    state: "connected",
    token: TOKEN,
    models: MODELS,
  });
});

describe("Claude subscription secret lifecycle", () => {
  test("persists an encrypted personal credential and survives loss of the sign-in process", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const organization = await makeOrganization({
      defaultEnvironmentNamespace: "account-tests",
    });
    const agent = await makeAgent({ organizationId: organization.id });
    const user = await makeUser();
    const owner = { runtime: runtime(agent), userId: user.id };
    const pending = await manager.start(owner);
    expect(await ClaudeCodeAccountModel.find(agentOwner(owner))).toBeNull();
    expect(claudeCodeAccountRuntime.create).toHaveBeenCalledWith(
      expect.objectContaining({
        image: getAgentCatalogImages(config.agentRuntime.defaultImage)[
          "claude-code"
        ],
      }),
    );
    const result = await manager.complete({
      ...owner,
      flowId: pending.flowId as string,
      code: "one-time-code",
    });
    expect(result).toMatchObject({
      state: "connected",
      expiresAt: expect.any(String),
    });
    const credential = await requireStoredAccount(owner);
    expect(credential.metadata).toMatchObject({ models: MODELS });
    expect(JSON.stringify(credential)).not.toContain(TOKEN);
    expect(JSON.stringify(await SecretModel.findAllRaw())).not.toContain(TOKEN);
    expect(
      (await secretManager().getSecret(credential.secretId))?.secret.value,
    ).toBe(TOKEN);
    expect(claudeCodeAccountRuntime.delete).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: pending.flowId }),
    );
    vi.mocked(claudeCodeAccountRuntime.status).mockRejectedValue(
      new Error("Pod is gone"),
    );
    expect((await manager.status(owner)).state).toBe("connected");
    expect(await manager.models(owner)).toEqual({ models: MODELS });
    expect(
      await manager.requireConnection({
        ...owner,
        runtimeScope: "account-tests",
      }),
    ).toBe(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    await manager.disconnect(owner);
    expect((await manager.status(owner)).state).toBe("disconnected");
    expect(
      await secretManager().getSecret(credential.secretId, { skipCache: true }),
    ).toBeNull();
    await expect(
      manager.requireConnection({ ...owner, runtimeScope: "account-tests" }),
    ).rejects.toMatchObject({ code: "AGENT_RUNTIME_CREDENTIALS_REQUIRED" });
  });

  test("reuses one personal connection across Agents, images and environments while isolating users and organizations", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const organization = await makeOrganization({
      defaultEnvironmentNamespace: "account-tests",
    });
    const agent = await makeAgent({ organizationId: organization.id });
    const otherAgent = await makeAgent({ organizationId: organization.id });
    const owner = { runtime: runtime(agent), userId: (await makeUser()).id };
    const other = {
      ...owner,
      runtime: { ...runtime(otherAgent), image: "different-image" },
    };
    const isolatedOwners = [
      { ...owner, userId: (await makeUser()).id },
      {
        ...owner,
        runtime: {
          ...owner.runtime,
          organizationId: (await makeOrganization()).id,
        },
      },
    ];
    const pending = await manager.start(owner);
    for (const isolated of isolatedOwners) {
      await expect(
        manager.complete({ ...isolated, flowId: pending.flowId as string }),
      ).rejects.toMatchObject({ statusCode: 409 });
    }
    await OrganizationModel.patch(organization.id, {
      defaultEnvironmentNamespace: "changed-tests",
    });
    // Finishing from another Agent still talks to the original sign-in Job.
    await manager.complete({ ...other, flowId: pending.flowId as string });
    expect(claudeCodeAccountRuntime.complete).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "account-tests" }),
    );
    for (const connected of [owner, other]) {
      expect((await manager.status(connected)).state).toBe("connected");
      expect(await manager.models(connected)).toEqual({ models: MODELS });
      expect(
        await manager.requireConnection({
          ...connected,
          runtimeScope: "changed-tests",
        }),
      ).toBe(TOKEN);
    }
    expect(claudeCodeAccountRuntime.create).toHaveBeenCalledTimes(1);
    await expect(
      manager.requireConnection({
        ...other,
        runtime: { ...other.runtime, command: ["custom-runtime"] },
        runtimeScope: "changed-tests",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    for (const isolated of isolatedOwners) {
      expect((await manager.status(isolated)).state).toBe("disconnected");
      await expect(
        manager.requireConnection({
          ...isolated,
          runtimeScope: "changed-tests",
        }),
      ).rejects.toThrow();
    }
    await AgentModel.delete(agent.id);
    expect((await manager.status(other)).state).toBe("connected");
    await manager.disconnect(other);
    expect((await manager.status(owner)).state).toBe("disconnected");
    await expect(
      manager.requireConnection({ ...other, runtimeScope: "changed-tests" }),
    ).rejects.toMatchObject({ code: "AGENT_RUNTIME_CREDENTIALS_REQUIRED" });
  });

  test("a disconnected in-flight completion cannot reconnect or leak its temporary secret", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = {
      runtime: runtime(await makeAgent({ organizationId: organization.id })),
      userId: (await makeUser()).id,
    };
    const pending = await manager.start(owner);
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(claudeCodeAccountRuntime.complete).mockImplementation(() => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const completion = manager.complete({
      ...owner,
      flowId: pending.flowId as string,
    });
    const rejected = expect(completion).rejects.toMatchObject({
      statusCode: 409,
    });
    await started;
    await manager.disconnect({
      ...owner,
      runtime: runtime(await makeAgent({ organizationId: organization.id })),
    });
    release({ state: "connected", token: TOKEN, models: MODELS });
    await rejected;
    expect((await manager.status(owner)).state).toBe("disconnected");
    expect(await SecretModel.findAllRaw()).toHaveLength(0);
  });

  test("replaced flows cannot finish; renewing deletes the old secret and expiry requires reconnect", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const organization = await makeOrganization({
      defaultEnvironmentNamespace: "account-tests",
    });
    const owner = {
      runtime: runtime(await makeAgent({ organizationId: organization.id })),
      userId: (await makeUser()).id,
    };
    const first = await manager.start(owner);
    const second = await manager.start(owner);
    await expect(
      manager.complete({ ...owner, flowId: first.flowId as string }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await manager.complete({ ...owner, flowId: second.flowId as string });
    const old = await requireStoredAccount(owner);
    const third = await manager.start(owner);
    await manager.complete({ ...owner, flowId: third.flowId as string });
    expect(
      await secretManager().getSecret(old.secretId, { skipCache: true }),
    ).toBeNull();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 366 * 24 * 3600 * 1000);
      expect((await manager.status(owner)).state).toBe("expired");
      expect(await manager.models(owner)).toEqual({ models: [] });
      await expect(
        manager.requireConnection({ ...owner, runtimeScope: "account-tests" }),
      ).rejects.toMatchObject({ code: "AGENT_RUNTIME_CREDENTIALS_REQUIRED" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects malformed native tokens without persisting terminal data", async ({
    makeOrganization,
    makeAgent,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = {
      runtime: runtime(await makeAgent({ organizationId: organization.id })),
      userId: (await makeUser()).id,
    };
    const pending = await manager.start(owner);
    vi.mocked(claudeCodeAccountRuntime.complete).mockResolvedValue({
      state: "connected",
      token: "private terminal output",
      models: MODELS,
    });
    await expect(
      manager.complete({ ...owner, flowId: pending.flowId as string }),
    ).rejects.toThrow("invalid sign-in result");
    expect(await SecretModel.findAllRaw()).toHaveLength(0);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 601_000);
      expect((await manager.status(owner)).state).toBe("failed");
      await expect(
        manager.complete({ ...owner, flowId: pending.flowId as string }),
      ).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      vi.useRealTimers();
    }
  });
});

const TOKEN = `sk-ant-oat01-${"example".repeat(8)}`;
const MODELS = [
  { value: "test-model", displayName: "Test model", description: "CLI model" },
];
function agentOwner(owner: { runtime: ResolvedAgentRuntime; userId: string }) {
  return {
    organizationId: owner.runtime.organizationId,
    agentId: owner.runtime.agentId,
    userId: owner.userId,
  };
}
async function requireStoredAccount(owner: {
  runtime: ResolvedAgentRuntime;
  userId: string;
}) {
  const account = await ClaudeCodeAccountModel.find(agentOwner(owner));
  if (!account) throw new Error("Expected a stored Claude account");
  return account;
}
function runtime(agent: {
  id: string;
  organizationId: string;
}): ResolvedAgentRuntime {
  return {
    agentId: agent.id,
    organizationId: agent.organizationId,
    secretId: null,
    environmentId: null,
    image: "example.test/claude-code:test",
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
}
