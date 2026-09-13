import { SecretsManagerType } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import { claudeCodeAccountRuntime } from "@/k8s/agent-runtime/claude-code-account";
import ClaudeCodeAccountModel from "@/models/claude-code-account";
import SecretModel from "@/models/secret";
import { secretManagerCoordinator } from "@/secrets-manager";
import { afterEach, beforeEach, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { ResolvedAgentRuntime } from "@/types";
import { claudeCodeAccountManager as manager } from "./claude-code-account";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();
beforeEach(() => {
  vi.spyOn(agentRuntimeManager, "isEnabled", "get").mockReturnValue(true);
  config.enterpriseFeatures.core = true;
  vi.stubEnv("ARCHESTRA_HASHICORP_VAULT_ADDR", "http://vault.example.test");
  vi.stubEnv("ARCHESTRA_HASHICORP_VAULT_TOKEN", "example-vault-token");
  vi.stubEnv("ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD", "TOKEN");
  vi.stubEnv("ARCHESTRA_HASHICORP_VAULT_KV_VERSION", "2");
  vi.spyOn(claudeCodeAccountRuntime, "create").mockResolvedValue(undefined);
  vi.spyOn(claudeCodeAccountRuntime, "delete").mockResolvedValue(undefined);
  vi.spyOn(claudeCodeAccountRuntime, "complete").mockResolvedValue({
    state: "connected",
    models: [],
  });
});
afterEach(async () => {
  await secretManagerCoordinator.initialize(SecretsManagerType.DB);
});

test("read-only Vault keeps only a reference, reads rotated tokens, and never writes or deletes remote data", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  await secretManagerCoordinator.initialize(SecretsManagerType.BYOS_VAULT);
  const organization = await makeOrganization({
    defaultEnvironmentNamespace: "account-tests",
  });
  const agent = await makeAgent({ organizationId: organization.id });
  const user = await makeUser();
  const runtime: ResolvedAgentRuntime = {
    agentId: agent.id,
    organizationId: organization.id,
    secretId: null,
    environmentId: null,
    image: "example.test/claude:test",
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
  };
  const owner = { runtime, userId: user.id };
  let token = `sk-ant-oat01-${"example".repeat(8)}`;
  server.use(
    http.get("http://vault.example.test/v1/secret/data/personal", () =>
      HttpResponse.json({ data: { data: { token } } }),
    ),
  );
  expect(await manager.status(owner)).toMatchObject({
    requiresVaultReference: true,
  });
  await expect(manager.start(owner)).rejects.toThrow("read-only Vault");
  expect(claudeCodeAccountRuntime.create).not.toHaveBeenCalled();
  const pending = await manager.start({
    ...owner,
    vaultReference: "secret/data/personal#token",
  });
  await manager.complete({ ...owner, flowId: pending.flowId as string });
  const credential = await ClaudeCodeAccountModel.find({
    organizationId: organization.id,
    userId: user.id,
  });
  if (!credential) throw new Error("Expected a personal Claude account");
  const secret = await SecretModel.findById(credential.secretId);
  expect(secret).toMatchObject({
    isByosVault: true,
    secret: { value: "secret/data/personal#token" },
  });
  expect(JSON.stringify(await SecretModel.findAllRaw())).not.toContain(token);
  expect(
    await manager.requireConnection({
      ...owner,
      runtimeScope: "account-tests",
    }),
  ).toBe(token);
  token += "rotated";
  expect(
    await manager.requireConnection({
      ...owner,
      runtimeScope: "account-tests",
    }),
  ).toBe(token);
  await manager.disconnect(owner);
  expect(await SecretModel.findById(credential.secretId)).toBeNull();
});

test("managed Vault stores the token remotely and deletes it on disconnect", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  await secretManagerCoordinator.initialize(SecretsManagerType.Vault);
  const organization = await makeOrganization({
    defaultEnvironmentNamespace: "account-tests",
  });
  const agent = await makeAgent({ organizationId: organization.id });
  const user = await makeUser();
  const runtime: ResolvedAgentRuntime = {
    agentId: agent.id,
    organizationId: organization.id,
    secretId: null,
    environmentId: null,
    image: "example.test/claude:test",
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
  };
  const owner = { runtime, userId: user.id };
  const token = `sk-ant-oat01-${"example".repeat(8)}`;
  let stored: unknown;
  let removed = false;
  server.use(
    http.post(
      "http://vault.example.test/v1/secret/data/archestra/:name",
      async ({ request }) => {
        stored = await request.json();
        return HttpResponse.json({ data: {} });
      },
    ),
    http.get("http://vault.example.test/v1/secret/data/archestra/:name", () =>
      HttpResponse.json({
        data: { data: { value: JSON.stringify({ value: token }) } },
      }),
    ),
    http.delete(
      "http://vault.example.test/v1/secret/metadata/archestra/:name",
      () => {
        removed = true;
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
  vi.mocked(claudeCodeAccountRuntime.complete).mockResolvedValue({
    state: "connected",
    token,
    models: [],
  });
  const pending = await manager.start(owner);
  await manager.complete({ ...owner, flowId: pending.flowId as string });
  expect(stored).toEqual({ data: { value: JSON.stringify({ value: token }) } });
  const credential = await ClaudeCodeAccountModel.find({
    organizationId: organization.id,
    userId: user.id,
  });
  if (!credential) throw new Error("Expected a personal Claude account");
  expect(await SecretModel.findById(credential.secretId)).toMatchObject({
    isVault: true,
    secret: {},
  });
  expect(
    await manager.requireConnection({
      ...owner,
      runtimeScope: "account-tests",
    }),
  ).toBe(token);
  await manager.disconnect(owner);
  expect(removed).toBe(true);
});
