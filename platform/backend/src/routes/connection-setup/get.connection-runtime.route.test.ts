import { createHash } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { afterEach, vi } from "vitest";
import config from "@/config";
import db, { schema, withDbTransaction } from "@/database";
import AgentModel from "@/models/agent";
import ConnectedClientModel from "@/models/connected-client";
import ConnectionSetupModel from "@/models/connection-setup";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import MemberModel from "@/models/member";
import ModelModel from "@/models/model";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { issueConnectionInstructionsToken } from "@/services/connection-instructions-token";
import { issueConnectionRuntimeToken } from "@/services/connection-runtime-token";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./connection-setup.routes";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest route fixture registration
const ctx = useRouteTestApp(routes);
setupTestCacheManager();
afterEach(() => vi.useRealTimers());

const fetchRuntime = (credential?: string) =>
  ctx.app.inject({
    method: "GET",
    url: "/api/connection-setups/runtime",
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
  });
const tokenFor = (setupId: string) =>
  issueConnectionRuntimeToken({ setupId, secret: config.auth.secret ?? "" });

test("consumed installations fetch credential-free artifacts after ticket expiry; instructions and render tickets cannot authorize execution", async ({
  makeMember,
  makeAgent,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId);
  const gateway = await makeAgent({
    organizationId: ctx.organizationId,
    authorId: ctx.user.id,
    agentType: "mcp_gateway",
  });
  const { setup, rawToken } = await ConnectionSetupModel.create({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    clientId: "kilo",
    platform: "linux",
    baseUrl: "https://deployment.example.com/v1",
    mcpGatewayId: gateway.id,
    expiresAt: new Date(Date.now() + 60000),
  });
  await ConnectionSetupModel.claimByToken({ rawToken });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.now() + 16 * 60 * 1000));
  const token = tokenFor(setup.id);
  const response = await fetchRuntime(token);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json()).toMatchObject({
    format: 1,
    installation: setup.id,
    clientId: "kilo",
  });
  for (const artifact of Object.values(response.json().artifacts) as {
    source: string;
    sha256: string;
  }[]) {
    expect(createHash("sha256").update(artifact.source).digest("hex")).toBe(
      artifact.sha256,
    );
    expect(artifact.source).not.toContain(token);
    expect(artifact.source).not.toContain(rawToken);
  }
  expect(response.json().artifacts["routing-v1.mjs"].source).toContain(
    "const hasCatalog = false",
  );
  expect(response.json().artifacts["routing-v2.mjs"].source).toContain(
    "const hasCatalog = false",
  );
  expect((await fetchRuntime(rawToken)).statusCode).toBe(401);
  expect(
    (
      await fetchRuntime(
        issueConnectionInstructionsToken({
          setupId: setup.id,
          secret: config.auth.secret ?? "",
        }),
      )
    ).statusCode,
  ).toBe(401);
  expect(
    (await fetchRuntime("archestra_virtual_inference_example")).statusCode,
  ).toBe(401);
  expect((await fetchRuntime()).statusCode).toBe(401);
  expect(
    (await ConnectionSetupModel.findById(setup.id))?.virtualApiKeyId,
  ).toBeNull();
});

test("unconsumed, revoked, unsupported-client and removed-member installations cannot get executable artifacts", async ({
  makeMember,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId);
  const create = (clientId: "opencode" | "claude-code") =>
    ConnectionSetupModel.create({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      clientId,
      baseUrl: "https://deployment.example.com/v1",
      expiresAt: new Date(Date.now() + 60000),
    });
  const pending = await create("opencode");
  expect((await fetchRuntime(tokenFor(pending.setup.id))).statusCode).toBe(403);
  await ConnectionSetupModel.claimByToken({ rawToken: pending.rawToken });
  expect((await fetchRuntime(tokenFor(pending.setup.id))).statusCode).toBe(200);
  await withDbTransaction((tx) =>
    ConnectedClientModel.revokeForUser({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      clientId: "opencode",
      revokedByUserId: ctx.user.id,
      tx,
    }),
  );
  expect((await fetchRuntime(tokenFor(pending.setup.id))).statusCode).toBe(403);
  const unsupported = await create("claude-code");
  await ConnectionSetupModel.claimByToken({ rawToken: unsupported.rawToken });
  expect((await fetchRuntime(tokenFor(unsupported.setup.id))).statusCode).toBe(
    403,
  );
  const active = await create("opencode");
  await ConnectionSetupModel.claimByToken({ rawToken: active.rawToken });
  await MemberModel.deleteAllByUserId(ctx.user.id);
  expect((await fetchRuntime(tokenFor(active.setup.id))).statusCode).toBe(403);
});

test("live resource-use grants, not cached membership or read-only grants, control update delivery", async ({
  makeCustomRole,
  makeMember,
  makeAgent,
  makeUser,
}) => {
  const role = await makeCustomRole(ctx.organizationId, { permission: {} });
  await makeMember(ctx.user.id, ctx.organizationId, { role: role.role });
  const owner = await makeUser();
  const gateway = await makeAgent({
    organizationId: ctx.organizationId,
    authorId: owner.id,
    agentType: "mcp_gateway",
    access: "personal",
  });
  const key = {
    organizationId: ctx.organizationId,
    resource: "mcpGateway" as const,
    scope: gateway.id,
  };
  const policy = await ResourcePermissionPolicyModel.find(key);
  const subject = { type: "user" as const, id: ctx.user.id };
  await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: policy?.revision ?? 0,
    grants: [{ subject, actions: ["use"] }],
  });
  const { setup, rawToken } = await ConnectionSetupModel.create({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    clientId: "opencode",
    baseUrl: "https://deployment.example.com/v1",
    mcpGatewayId: gateway.id,
    expiresAt: new Date(Date.now() + 60000),
  });
  await ConnectionSetupModel.claimByToken({ rawToken });
  const token = tokenFor(setup.id);
  expect((await fetchRuntime(token)).statusCode).toBe(200);
  const updated = await ResourcePermissionPolicyModel.find(key);
  await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: updated?.revision ?? 0,
    grants: [{ subject, actions: ["read"] }],
  });
  expect((await fetchRuntime(token)).statusCode).toBe(403);
  await AgentModel.delete(gateway.id);
  expect((await fetchRuntime(token)).statusCode).toBe(403);
});

test("LLM-only installations recheck live proxy read access without creating or replacing a proxy", async ({
  makeCustomRole,
  makeMember,
  makeAgent,
}) => {
  const role = await makeCustomRole(ctx.organizationId, {
    permission: { llmProxy: ["read"] },
  });
  const noAccess = await makeCustomRole(ctx.organizationId, { permission: {} });
  await makeMember(ctx.user.id, ctx.organizationId, { role: role.role });
  const proxy = await makeAgent({
    organizationId: ctx.organizationId,
    authorId: ctx.user.id,
    agentType: "llm_proxy",
  });
  const { setup, rawToken } = await ConnectionSetupModel.create({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    clientId: "opencode",
    baseUrl: "https://deployment.example.com/v1",
    llmProxyId: proxy.id,
    expiresAt: new Date(Date.now() + 60000),
  });
  await ConnectionSetupModel.claimByToken({ rawToken });
  const credential = tokenFor(setup.id);
  const allowed = await fetchRuntime(credential);
  expect(allowed.statusCode).toBe(200);
  expect(allowed.json().artifacts["routing-v1.mjs"].source).toContain(
    "const hasCatalog = false",
  );
  expect(
    (await ConnectionSetupModel.findById(setup.id))?.virtualApiKeyId,
  ).toBeNull();
  await MemberModel.updateRole(ctx.user.id, ctx.organizationId, noAccess.role);
  expect((await fetchRuntime(credential)).statusCode).toBe(403);
  expect(await AgentModel.findById(proxy.id)).toMatchObject({
    id: proxy.id,
    agentType: "llm_proxy",
  });
});

test("runtime artifacts follow live authorized models without provisioning rows or embedding the key", async ({
  makeMember,
  makeAgent,
  makeSecret,
  makeLlmProviderApiKey,
  makeUser,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId);
  const proxy = await makeAgent({
    organizationId: ctx.organizationId,
    authorId: ctx.user.id,
    agentType: "llm_proxy",
  });
  const secret = await makeSecret();
  const providerKey = await makeLlmProviderApiKey(
    ctx.organizationId,
    secret.id,
    { provider: "perplexity", isPrimary: true },
  );
  const first = await ModelModel.create({
    provider: "perplexity",
    modelId: "fixture/model/one",
    externalId: "fixture-model-one",
    inputModalities: ["text"],
    outputModalities: ["text"],
    contextLength: 4096,
    outputLength: 512,
  });
  const removed = await ModelModel.create({
    provider: "perplexity",
    modelId: "fixture/model/removed",
    externalId: "fixture-model-removed",
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(providerKey.id, [
    first.id,
    removed.id,
  ]);
  const modelPolicy = await ResourcePermissionPolicyModel.find({
    organizationId: ctx.organizationId,
    resource: "llmModel",
    scope: first.id,
  });
  await ResourcePermissionPolicyModel.replace({
    organizationId: ctx.organizationId,
    resource: "llmModel",
    scope: first.id,
    revision: modelPolicy?.revision ?? 0,
    grants: [{ subject: { type: "user", id: ctx.user.id }, actions: ["use"] }],
  });
  const created = await VirtualApiKeyModel.create({
    organizationId: ctx.organizationId,
    name: "Runtime catalog key",
    scope: "personal",
    authorId: ctx.user.id,
    providerApiKeys: [
      { provider: "perplexity", providerApiKeyId: providerKey.id },
    ],
  });
  const { setup, rawToken } = await ConnectionSetupModel.create({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    clientId: "opencode",
    baseUrl: "https://deployment.example.com/v1",
    llmProxyId: proxy.id,
    provider: "perplexity",
    proxyAuth: "virtual-key",
    virtualApiKeyId: created.virtualKey.id,
    expiresAt: new Date(Date.now() + 60000),
  });
  await ConnectionSetupModel.claimByToken({ rawToken });
  const before = await rowCounts();
  const credential = tokenFor(setup.id);
  const initial = await fetchRuntime(credential);
  expect(initial.statusCode, initial.body).toBe(200);
  const initialPlugin = initial.json().artifacts["routing-v1.mjs"]
    .source as string;
  expect(initialPlugin).toContain("fixture/model/one");
  expect(initialPlugin).toContain("perplexity:fixture/model/one");
  expect(initialPlugin).toContain(`/v1/model-router/${proxy.id}`);
  expect(initialPlugin).not.toContain("/connection-setup/");
  expect(initialPlugin).toContain('"perplexity":"archestra-perplexity"');
  expect(initialPlugin).not.toContain(created.value);
  expect(initialPlugin).not.toContain(credential);
  expect(await rowCounts()).toEqual(before);

  await LlmProviderApiKeyModelLinkModel.unlinkModelFromApiKey({
    apiKeyId: providerKey.id,
    provider: "perplexity",
    modelId: removed.modelId,
  });
  const revised = await fetchRuntime(credential);
  expect(revised.statusCode).toBe(200);
  const revisedPlugin = revised.json().artifacts["routing-v1.mjs"] as {
    source: string;
    sha256: string;
  };
  expect(revisedPlugin.sha256).not.toBe(
    initial.json().artifacts["routing-v1.mjs"].sha256,
  );
  expect(revisedPlugin.source).toContain("fixture/model/one");
  expect(revisedPlugin.source).not.toContain("fixture/model/removed");
  expect(revisedPlugin.source).not.toContain("/connection-setup/");

  const added = await ModelModel.create({
    provider: "cohere",
    modelId: "fixture/vendor/added",
    externalId: "fixture-vendor-added",
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
  const cohereKey = await makeLlmProviderApiKey(ctx.organizationId, secret.id, {
    provider: "cohere",
    isPrimary: true,
  });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(cohereKey.id, [
    added.id,
  ]);
  await VirtualApiKeyModel.update({
    id: created.virtualKey.id,
    name: "Runtime catalog key",
    scope: "personal",
    authorId: ctx.user.id,
    teamIds: [],
    providerApiKeys: [
      { provider: "perplexity", providerApiKeyId: providerKey.id },
      { provider: "cohere", providerApiKeyId: cohereKey.id },
    ],
  });
  await db
    .update(schema.connectionSetupsTable)
    .set({ proxyAuth: "primary-providers" })
    .where(eq(schema.connectionSetupsTable.id, setup.id));
  const expanded = await fetchRuntime(credential);
  expect(expanded.statusCode, expanded.body).toBe(200);
  const expandedSource = expanded.json().artifacts["routing-v1.mjs"]
    .source as string;
  expect(expandedSource).toContain("fixture/vendor/added");
  expect(expandedSource).toContain('"cohere":"archestra-cohere"');
  expect(expandedSource).toContain(`/v1/model-router/${proxy.id}`);
  expect(expandedSource).not.toContain(created.value);
  expect(await rowCounts()).toEqual(before);

  const currentPolicy = await ResourcePermissionPolicyModel.find({
    organizationId: ctx.organizationId,
    resource: "llmModel",
    scope: first.id,
  });
  await ResourcePermissionPolicyModel.replace({
    organizationId: ctx.organizationId,
    resource: "llmModel",
    scope: first.id,
    revision: currentPolicy?.revision ?? 0,
    grants: [],
  });
  const revokedModel = await fetchRuntime(credential);
  expect(revokedModel.statusCode, revokedModel.body).toBe(200);
  expect(revokedModel.json().artifacts["routing-v1.mjs"].source).not.toContain(
    "fixture/model/one",
  );
  expect(revokedModel.json().artifacts["routing-v1.mjs"].source).toContain(
    "fixture/vendor/added",
  );
  expect(await rowCounts()).toEqual(before);

  const outsider = await makeUser();
  const foreign = await VirtualApiKeyModel.create({
    organizationId: ctx.organizationId,
    name: "Foreign catalog key",
    scope: "personal",
    authorId: outsider.id,
    providerApiKeys: [
      { provider: "perplexity", providerApiKeyId: providerKey.id },
    ],
  });
  await db
    .update(schema.connectionSetupsTable)
    .set({ virtualApiKeyId: foreign.virtualKey.id })
    .where(eq(schema.connectionSetupsTable.id, setup.id));
  const denied = await fetchRuntime(credential);
  expect(denied.statusCode).toBe(403);
  expect(await rowCounts()).toEqual({
    ...before,
    keys: before.keys + 1,
  });
});

test("a provider key outside the installation user's teams retires models without provisioning", async ({
  makeMember,
  makeAgent,
  makeSecret,
  makeLlmProviderApiKey,
  makeTeam,
  makeUser,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId);
  const owner = await makeUser();
  await makeMember(owner.id, ctx.organizationId);
  const team = await makeTeam(ctx.organizationId, owner.id);
  const proxy = await makeAgent({
    organizationId: ctx.organizationId,
    authorId: ctx.user.id,
    agentType: "llm_proxy",
  });
  const secret = await makeSecret();
  const providerKey = await makeLlmProviderApiKey(
    ctx.organizationId,
    secret.id,
    {
      provider: "perplexity",
      isPrimary: true,
      access: { teams: [{ id: team.id, level: "use" }] },
    },
  );
  const model = await ModelModel.create({
    provider: "perplexity",
    modelId: "fixture/team/hidden",
    externalId: "fixture-team-hidden",
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(providerKey.id, [
    model.id,
  ]);
  const created = await VirtualApiKeyModel.create({
    organizationId: ctx.organizationId,
    name: "Team scoped catalog key",
    scope: "personal",
    authorId: ctx.user.id,
    providerApiKeys: [
      { provider: "perplexity", providerApiKeyId: providerKey.id },
    ],
  });
  const { setup, rawToken } = await ConnectionSetupModel.create({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    clientId: "kilo",
    baseUrl: "https://deployment.example.com/v1",
    llmProxyId: proxy.id,
    provider: "perplexity",
    proxyAuth: "virtual-key",
    virtualApiKeyId: created.virtualKey.id,
    expiresAt: new Date(Date.now() + 60000),
  });
  await ConnectionSetupModel.claimByToken({ rawToken });
  const before = await rowCounts();
  const response = await fetchRuntime(tokenFor(setup.id));
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().artifacts["routing-v1.mjs"].source).not.toContain(
    "fixture/team/hidden",
  );
  expect(response.json().artifacts["routing-v1.mjs"].source).toContain(
    "const hasCatalog = true",
  );
  expect(response.json().artifacts["routing-v1.mjs"].source).not.toContain(
    created.value,
  );
  expect(await rowCounts()).toEqual(before);
});

test("revoking the last model publishes an empty catalog instead of the installed routes", async ({
  makeMember,
  makeAgent,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId);
  const proxy = await makeAgent({
    organizationId: ctx.organizationId,
    authorId: ctx.user.id,
    agentType: "llm_proxy",
  });
  const secret = await makeSecret();
  const providerKey = await makeLlmProviderApiKey(
    ctx.organizationId,
    secret.id,
    {
      provider: "perplexity",
      isPrimary: true,
    },
  );
  const model = await ModelModel.create({
    provider: "perplexity",
    modelId: "fixture/model/last",
    externalId: "fixture-model-last",
    inputModalities: ["text"],
    outputModalities: ["text"],
    contextLength: 2048,
    outputLength: 256,
  });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(providerKey.id, [
    model.id,
  ]);
  const policy = await ResourcePermissionPolicyModel.find({
    organizationId: ctx.organizationId,
    resource: "llmModel",
    scope: model.id,
  });
  await ResourcePermissionPolicyModel.replace({
    organizationId: ctx.organizationId,
    resource: "llmModel",
    scope: model.id,
    revision: policy?.revision ?? 0,
    grants: [{ subject: { type: "user", id: ctx.user.id }, actions: ["use"] }],
  });
  const created = await VirtualApiKeyModel.create({
    organizationId: ctx.organizationId,
    name: "Last model catalog key",
    scope: "personal",
    authorId: ctx.user.id,
    providerApiKeys: [
      { provider: "perplexity", providerApiKeyId: providerKey.id },
    ],
  });
  const { setup, rawToken } = await ConnectionSetupModel.create({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    clientId: "opencode",
    baseUrl: "https://deployment.example.com/v1",
    llmProxyId: proxy.id,
    provider: "perplexity",
    proxyAuth: "virtual-key",
    virtualApiKeyId: created.virtualKey.id,
    expiresAt: new Date(Date.now() + 60000),
  });
  await ConnectionSetupModel.claimByToken({ rawToken });
  const before = await rowCounts();
  const credential = tokenFor(setup.id);
  const granted = await fetchRuntime(credential);
  expect(granted.statusCode, granted.body).toBe(200);
  expect(granted.json().artifacts["routing-v1.mjs"].source).toContain(
    "fixture/model/last",
  );
  const current = await ResourcePermissionPolicyModel.find({
    organizationId: ctx.organizationId,
    resource: "llmModel",
    scope: model.id,
  });
  await ResourcePermissionPolicyModel.replace({
    organizationId: ctx.organizationId,
    resource: "llmModel",
    scope: model.id,
    revision: current?.revision ?? 0,
    grants: [],
  });
  const revoked = await fetchRuntime(credential);
  expect(revoked.statusCode, revoked.body).toBe(200);
  for (const name of ["routing-v1.mjs", "routing-v2.mjs"] as const) {
    const source = revoked.json().artifacts[name].source as string;
    expect(source).toContain("const hasCatalog = true");
    expect(source).not.toContain("fixture/model/last");
    expect(source).not.toContain(created.value);
    expect(source).not.toContain(credential);
  }
  expect(revoked.json().artifacts["repair.cjs"].source).toBeTypeOf("string");
  expect(await rowCounts()).toEqual(before);
});

async function rowCounts() {
  const [keys, agents, setups] = await Promise.all([
    db.select({ value: count() }).from(schema.virtualApiKeysTable),
    db.select({ value: count() }).from(schema.agentsTable),
    db.select({ value: count() }).from(schema.connectionSetupsTable),
  ]);
  return {
    keys: keys[0]?.value ?? 0,
    agents: agents[0]?.value ?? 0,
    setups: setups[0]?.value ?? 0,
  };
}
