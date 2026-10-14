import { createHash } from "node:crypto";
import { afterEach, vi } from "vitest";
import config from "@/config";
import { withDbTransaction } from "@/database";
import AgentModel from "@/models/agent";
import ConnectedClientModel from "@/models/connected-client";
import ConnectionSetupModel from "@/models/connection-setup";
import MemberModel from "@/models/member";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
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
  expect((await fetchRuntime(credential)).statusCode).toBe(200);
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
