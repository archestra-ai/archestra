import { createHash } from "node:crypto";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import { AgentModel, OrganizationModel } from "@/models";
import ClaudeCodeAccountModel from "@/models/claude-code-account";
import SecretModel from "@/models/secret";
import { secretManager } from "@/secrets-manager";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { ResolvedAgentRuntime } from "@/types";
import { decryptSecretValue } from "@/utils/crypto";
import { claudeCodeAccountManager as manager } from "./claude-code-account";

// Only the provider HTTP boundary is replaced; storage and encryption are real.
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();
beforeEach(() => {
  vi.spyOn(agentRuntimeManager, "isEnabled", "get").mockReturnValue(true);
  server.use(
    http.post(TOKEN_URL, () => HttpResponse.json(tokenResponse())),
    http.get("https://api.anthropic.com/v1/models", () =>
      HttpResponse.json({
        data: [{ id: "test-model", display_name: "Test model" }],
      }),
    ),
  );
});

describe("Claude subscription secret lifecycle", () => {
  test("persists encrypted PKCE and a personal credential without starting a runtime", async ({
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
    expect(pending.state).toBe("awaiting_code");
    const url = new URL(pending.authorizationUrl as string);
    const flow = await ClaudeCodeAccountModel.flow(agentOwner(owner));
    if (!flow?.oauth) throw new Error("Expected OAuth flow");
    const verifier = decryptSecretValue(flow.oauth.verifier).verifier as string;
    expect(JSON.stringify(flow)).not.toContain(verifier);
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        expect(await request.json()).toMatchObject({
          code: "one-time-code",
          state: url.searchParams.get("state"),
          code_verifier: verifier,
          redirect_uri: "https://platform.claude.com/oauth/code/callback",
        });
        return HttpResponse.json(tokenResponse());
      }),
    );
    const result = await manager.complete({
      ...owner,
      flowId: pending.flowId as string,
      code: codeFor(pending),
    });
    expect(result).toMatchObject({
      state: "connected",
      expiresAt: expect.any(String),
    });
    const credential = await requireStoredAccount(owner);
    expect(credential.metadata).toMatchObject({ models: [] });
    expect(JSON.stringify(credential)).not.toContain(TOKEN);
    expect(JSON.stringify(await SecretModel.findAllRaw())).not.toContain(TOKEN);
    expect(
      (await secretManager().getSecret(credential.secretId))?.secret.value,
    ).toBe(TOKEN);
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
    // Finishing from another Agent preserves the same personal OAuth flow.
    await manager.complete({
      ...other,
      flowId: pending.flowId as string,
      code: codeFor(pending),
    });
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
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    server.use(
      http.post(TOKEN_URL, async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json(tokenResponse());
      }),
    );
    const completion = manager.complete({
      ...owner,
      flowId: pending.flowId as string,
      code: codeFor(pending),
    });
    const rejected = expect(completion).rejects.toMatchObject({
      statusCode: 409,
    });
    await started;
    await manager.disconnect({
      ...owner,
      runtime: runtime(await makeAgent({ organizationId: organization.id })),
    });
    release();
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
    await manager.complete({
      ...owner,
      flowId: second.flowId as string,
      code: codeFor(second),
    });
    const old = await requireStoredAccount(owner);
    const third = await manager.start(owner);
    await manager.complete({
      ...owner,
      flowId: third.flowId as string,
      code: codeFor(third),
    });
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

  test("rejects malformed provider tokens without persisting provider data", async ({
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
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          ...tokenResponse(),
          access_token: "private provider output",
        }),
      ),
    );
    await expect(
      manager.complete({
        ...owner,
        flowId: pending.flowId as string,
        code: codeFor(pending),
      }),
    ).rejects.toThrow("invalid sign-in result");
    expect(await SecretModel.findAllRaw()).toHaveLength(0);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 601_000);
      expect((await manager.status(owner)).state).toBe("failed");
      await expect(
        manager.complete({
          ...owner,
          flowId: pending.flowId as string,
          code: codeFor(pending),
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      vi.useRealTimers();
    }
  });
});

test("rejects mismatched codes before exchange and allows only one concurrent completion", async ({
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
  let calls = 0;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  server.use(
    http.post(TOKEN_URL, async () => {
      calls++;
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return HttpResponse.json(tokenResponse());
    }),
  );
  for (const code of [
    "missing-state",
    "code#wrong-state",
    `${codeFor(pending)}#extra`,
  ]) {
    await expect(
      manager.complete({ ...owner, flowId: pending.flowId as string, code }),
    ).rejects.toMatchObject({ statusCode: 400 });
  }
  expect(calls).toBe(0);
  const completion = manager.complete({
    ...owner,
    flowId: pending.flowId as string,
    code: codeFor(pending),
  });
  await started;
  expect(
    await manager.complete({
      ...owner,
      flowId: pending.flowId as string,
      code: codeFor(pending),
    }),
  ).toMatchObject({ state: "connecting" });
  expect((await manager.status(owner)).state).toBe("connecting");
  release();
  expect(await completion).toMatchObject({ state: "connected" });
  expect(calls).toBe(1);
  await expect(
    manager.complete({
      ...owner,
      flowId: pending.flowId as string,
      code: codeFor(pending),
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(calls).toBe(1);
});

test("provider failure is sanitized and requires a fresh flow instead of replaying a code", async ({
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
  let calls = 0;
  server.use(
    http.post(TOKEN_URL, () => {
      calls++;
      return HttpResponse.json(
        { error: "private-provider-response" },
        { status: 400 },
      );
    }),
  );
  await expect(
    manager.complete({
      ...owner,
      flowId: pending.flowId as string,
      code: codeFor(pending),
    }),
  ).rejects.toThrow("Could not contact Claude");
  expect((await manager.status(owner)).state).toBe("failed");
  await expect(
    manager.complete({
      ...owner,
      flowId: pending.flowId as string,
      code: codeFor(pending),
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(calls).toBe(1);
  expect(await SecretModel.findAllRaw()).toHaveLength(0);
  const fresh = await manager.start(owner);
  expect(fresh.state).toBe("awaiting_code");
  expect(fresh.flowId).not.toBe(pending.flowId);
});

test("uses provider expiry and keeps model discovery outside sign-in", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const owner = {
    runtime: runtime(await makeAgent({ organizationId: organization.id })),
    userId: (await makeUser()).id,
  };
  server.use(
    http.get(
      "https://api.anthropic.com/v1/models",
      () => new HttpResponse(null, { status: 503 }),
    ),
  );
  const pending = await manager.start(owner);
  const connected = await manager.complete({
    ...owner,
    flowId: pending.flowId as string,
    code: codeFor(pending),
  });
  expect(connected.state).toBe("connected");
  expect(
    new Date(connected.expiresAt as string).getTime() - Date.now(),
  ).toBeGreaterThan(3590_000);
  expect(
    new Date(connected.expiresAt as string).getTime() - Date.now(),
  ).toBeLessThanOrEqual(3600_000);
  await expect(manager.models(owner)).rejects.toMatchObject({
    statusCode: 502,
  });
  expect((await manager.status(owner)).state).toBe("connected");
});

const TOKEN = `sk-ant-oat01-${"example".repeat(8)}`;
const MODELS = [
  {
    value: "default",
    displayName: "Default",
    description: "Claude Code's default model for your account",
  },
  { value: "test-model", displayName: "Test model", description: "" },
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

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
function tokenResponse() {
  return {
    access_token: TOKEN,
    token_type: "Bearer",
    expires_in: 3600,
    scope: "user:inference",
  };
}
function codeFor(flow: { authorizationUrl?: string }) {
  return `one-time-code#${new URL(flow.authorizationUrl as string).searchParams.get("state")}`;
}
