import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import ManagedOauthClientModel from "@/models/managed-oauth-client";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { resolveOauthClientProviderMappings } from "@/services/oauth-client-providers";
import { expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import { grantRoleEverywhere } from "@/test/wildcard-grants";
import routes from "./oauth-client.routes";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest route fixture registration, not a React hook.
const ctx = useRouteTestApp(routes);

test("enabling needs wildcard authority, unchanged automatic access survives rename, and disabling restores only explicit mappings", async ({
  makeMember,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId, { role: "member" });
  const secret = await makeSecret();
  const explicit = await makeLlmProviderApiKey(ctx.organizationId, secret.id, {
    provider: "openai",
  });
  const automatic = await makeLlmProviderApiKey(ctx.organizationId, secret.id, {
    provider: "gemini",
    isPrimary: true,
  });
  const { oauthClient } = await ManagedOauthClientModel.create({
    organizationId: ctx.organizationId,
    authorId: ctx.user.id,
    name: "Selected providers",
    providerApiKeys: [{ provider: "openai", providerApiKeyId: explicit.id }],
  });
  const update = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: "PUT",
      url: `/api/oauth-clients/${oauthClient.id}`,
      payload: { name: oauthClient.name, scopes: ["llm:proxy"], ...payload },
    });
  expect((await update({ includeFutureProviders: true })).statusCode).toBe(403);
  expect(
    (
      await ManagedOauthClientModel.findById({
        id: oauthClient.id,
        organizationId: ctx.organizationId,
      })
    )?.includeFutureProviders,
  ).toBe(false);
  await grantRoleEverywhere({
    organizationId: ctx.organizationId,
    resource: "llmProviderApiKey",
    roleId: "member",
    actions: ["use"],
  });
  const enabled = await update({ includeFutureProviders: true });
  expect(enabled.statusCode, enabled.body).toBe(200);
  expect(
    (await resolveOauthClientProviderMappings(enabled.json())).map(
      (key) => key.providerApiKeyId,
    ),
  ).toEqual([explicit.id, automatic.id]);
  const policyKey = {
    organizationId: ctx.organizationId,
    resource: "llmProviderApiKey",
    scope: "*",
  } as const;
  const policy = await ResourcePermissionPolicyModel.find(policyKey);
  await ResourcePermissionPolicyModel.replace({
    ...policyKey,
    revision: policy?.revision ?? 0,
    grants: [],
  });
  const renamed = await update({ name: "Renamed automatic" });
  expect(renamed.statusCode, renamed.body).toBe(200);
  expect(renamed.json().includeFutureProviders).toBe(true);
  expect((await update({ includeFutureProviders: true })).statusCode).toBe(200);
  const disabled = await update({ includeFutureProviders: false });
  expect(disabled.statusCode, disabled.body).toBe(200);
  expect(disabled.json().includeFutureProviders).toBe(false);
  expect(
    (await resolveOauthClientProviderMappings(disabled.json())).map(
      (key) => key.providerApiKeyId,
    ),
  ).toEqual([explicit.id]);
  expect((await update({ includeFutureProviders: true })).statusCode).toBe(403);
});

test("an automatic-only client may rename without mappings but disabling it requires selected keys", async ({
  makeMember,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  const { oauthClient } = await ManagedOauthClientModel.create({
    organizationId: ctx.organizationId,
    authorId: ctx.user.id,
    name: "Automatic only",
    includeFutureProviders: true,
    providerApiKeys: [],
  });
  const update = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: "PUT",
      url: `/api/oauth-clients/${oauthClient.id}`,
      payload: { name: "Updated automatic", scopes: ["llm:proxy"], ...payload },
    });
  const renamed = await update({});
  expect(renamed.statusCode, renamed.body).toBe(200);
  expect(renamed.json()).toMatchObject({
    includeFutureProviders: true,
    providerApiKeys: [],
  });
  expect((await update({ includeFutureProviders: false })).statusCode).toBe(
    400,
  );
  expect((await update({ scopes: ["mcp"] })).statusCode).toBe(400);
  const secret = await makeSecret();
  const key = await makeLlmProviderApiKey(ctx.organizationId, secret.id, {
    provider: "openai",
  });
  const selected = await update({
    includeFutureProviders: false,
    providerApiKeys: [{ provider: "openai", providerApiKeyId: key.id }],
  });
  expect(selected.statusCode, selected.body).toBe(200);
  expect(selected.json()).toMatchObject({
    includeFutureProviders: false,
    providerApiKeys: [{ providerApiKeyId: key.id }],
  });
});

test("provider mode changes produce non-secret audit diffs", async ({
  makeMember,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  const secret = await makeSecret({ secret: { apiKey: "sk-audit-secret" } });
  const key = await makeLlmProviderApiKey(ctx.organizationId, secret.id, {
    provider: "openai",
  });
  const { oauthClient } = await ManagedOauthClientModel.create({
    organizationId: ctx.organizationId,
    authorId: ctx.user.id,
    name: "Audited mode",
    providerApiKeys: [{ provider: "openai", providerApiKeyId: key.id }],
  });
  registerAuditLogHook(ctx.app);
  const response = await ctx.app.inject({
    method: "PUT",
    url: `/api/oauth-clients/${oauthClient.id}`,
    payload: {
      name: oauthClient.name,
      scopes: ["llm:proxy"],
      includeFutureProviders: true,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  await vi.waitFor(async () => {
    const audits = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, oauthClient.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "oauthClient.updated",
      before: { includeFutureProviders: false },
      after: { includeFutureProviders: true },
    });
    expect(JSON.stringify(audits)).not.toContain("sk-audit-secret");
  });
});
