import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import ManagedOauthClientModel from "@/models/managed-oauth-client";
import { validateMCPGatewayToken } from "@/routes/mcp-gateway/utils";
import { validateLlmOAuthAccessToken } from "@/routes/proxy/llm-proxy-auth";
import { issueManagedOauthClientAccessToken } from "@/services/oauth-client-credentials";
import { expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import { grantRoleEverywhere } from "@/test/wildcard-grants";
import routes from "./oauth-client.routes";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest route fixture registration, not a React hook.
const ctx = useRouteTestApp(routes);

test("current and future provider access requires a wildcard use grant and accepts no fixed mappings", async ({
  makeMember,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId, { role: "member" });
  const payload = {
    name: "Automatic providers",
    scopes: ["llm:proxy"],
    includeFutureProviders: true,
    providerApiKeys: [],
  };
  const denied = await ctx.app.inject({
    method: "POST",
    url: "/api/oauth-clients",
    payload,
  });
  expect(denied.statusCode).toBe(403);
  expect(
    await ManagedOauthClientModel.findAllByOrganization({
      organizationId: ctx.organizationId,
    }),
  ).toEqual([]);
  await grantRoleEverywhere({
    organizationId: ctx.organizationId,
    resource: "llmProviderApiKey",
    roleId: "member",
    actions: ["use"],
  });
  const allowed = await ctx.app.inject({
    method: "POST",
    url: "/api/oauth-clients",
    payload,
  });
  expect(allowed.statusCode, allowed.body).toBe(200);
  expect(allowed.json()).toMatchObject({
    includeFutureProviders: true,
    providerApiKeys: [],
  });
});

test.each([
  {
    grantType: "authorization_code",
    scopes: ["llm:proxy"],
    redirectUris: ["https://app.example.com/callback"],
  },
  {
    grantType: "authorization_code",
    scopes: ["mcp"],
    redirectUris: ["https://app.example.com/callback"],
  },
  { grantType: "client_credentials", scopes: ["mcp"] },
])("rejects automatic providers for incompatible configuration %j", async (configuration) => {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/oauth-clients",
    payload: {
      name: "Invalid automatic access",
      ...configuration,
      includeFutureProviders: true,
    },
  });
  expect(response.statusCode).toBe(400);
});

test("unified bindings require account management and changing principal revokes issued tokens", async ({
  makeMember,
  makeAgent,
  makeServiceAccount,
  makeOrganization,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId, { role: "member" });
  const agent = await makeAgent({
    organizationId: ctx.organizationId,
    agentType: "agent",
  });
  const account = await makeServiceAccount(ctx.organizationId);
  const body = {
    name: "Bound agent",
    scopes: ["mcp", "a2a"],
    allowedGatewayIds: [agent.id],
    serviceAccountId: account.id,
  };
  expect(
    (
      await ctx.app.inject({
        method: "POST",
        url: "/api/oauth-clients",
        payload: body,
      })
    ).statusCode,
  ).toBe(403);
  const foreign = await makeOrganization();
  const foreignAccount = await makeServiceAccount(foreign.id);
  expect(
    (
      await ctx.app.inject({
        method: "POST",
        url: "/api/oauth-clients",
        payload: { ...body, serviceAccountId: foreignAccount.id },
      })
    ).statusCode,
  ).toBe(400);
  await db
    .update(schema.membersTable)
    .set({ role: "admin" })
    .where(eq(schema.membersTable.userId, ctx.user.id));
  const created = await ctx.app.inject({
    method: "POST",
    url: "/api/oauth-clients",
    payload: body,
  });
  expect(created.statusCode, created.body).toBe(200);
  const client = created.json();
  expect(client.serviceAccountId).toBe(account.id);
  const minted = await issueManagedOauthClientAccessToken({
    clientId: client.clientId,
    clientSecret: client.clientSecret,
  });
  expect(minted.ok).toBe(true);
  expect(
    await validateMCPGatewayToken(
      agent.id,
      minted.body.access_token as string,
      "a2a",
    ),
  ).toMatchObject({ serviceAccountId: account.id });
  expect(
    (
      await ctx.app.inject({
        method: "PUT",
        url: `/api/oauth-clients/${client.id}`,
        payload: { ...body, serviceAccountId: null },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    await validateMCPGatewayToken(
      agent.id,
      minted.body.access_token as string,
      "a2a",
    ),
  ).toBeNull();
});

test("one client and one secret reach MCP, A2A and LLM, with independent token subsets", async ({
  makeMember,
  makeAgent,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  const gateway = await makeAgent({
    organizationId: ctx.organizationId,
    agentType: "mcp_gateway",
  });
  const agent = await makeAgent({
    organizationId: ctx.organizationId,
    agentType: "agent",
  });
  const proxy = await makeAgent({
    organizationId: ctx.organizationId,
    agentType: "llm_proxy",
  });
  const secret = await makeSecret({ secret: { apiKey: "sk-fixture" } });
  const key = await makeLlmProviderApiKey(ctx.organizationId, secret.id, {
    provider: "openai",
  });
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/oauth-clients",
    payload: {
      name: "Combined service",
      scopes: ["mcp", "a2a", "llm:proxy"],
      allowedGatewayIds: [gateway.id, agent.id],
      providerApiKeys: [{ provider: "openai", providerApiKeyId: key.id }],
    },
  });
  expect(response.statusCode).toBe(200);
  const client = response.json();
  expect(client.scopes).toEqual(["mcp", "a2a", "llm:proxy"]);
  const credentials = {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
  };
  const all = await issueManagedOauthClientAccessToken(credentials);
  expect(all.ok).toBe(true);
  const token = all.body.access_token as string;
  expect(await validateMCPGatewayToken(gateway.id, token)).not.toBeNull();
  expect(await validateMCPGatewayToken(agent.id, token, "a2a")).not.toBeNull();
  expect(
    await validateLlmOAuthAccessToken({
      tokenValue: token,
      expectedProvider: "openai",
      agent: proxy,
    }),
  ).toMatchObject({
    authenticatedApp: { id: client.id },
    chatApiKeyId: key.id,
  });
  const mcpOnly = await issueManagedOauthClientAccessToken({
    ...credentials,
    scope: "mcp",
  });
  const narrow = mcpOnly.body.access_token as string;
  expect(await validateMCPGatewayToken(agent.id, narrow)).not.toBeNull();
  // Same agent and token were just admitted over MCP: a cache hit cannot admit A2A.
  expect(await validateMCPGatewayToken(agent.id, narrow, "a2a")).toBeNull();
  await expect(
    validateLlmOAuthAccessToken({
      tokenValue: narrow,
      expectedProvider: "openai",
      agent: proxy,
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(
    (
      await issueManagedOauthClientAccessToken({
        ...credentials,
        scope: "openid",
      })
    ).body,
  ).toMatchObject({ error: "invalid_scope" });
});

test("a narrowed token and a removed live capability cannot reach the other API", async ({
  makeMember,
  makeAgent,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  const agent = await makeAgent({
    organizationId: ctx.organizationId,
    agentType: "agent",
  });
  const { oauthClient: client, clientSecret } =
    await ManagedOauthClientModel.create({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      name: "Agent automation",
      scopes: ["mcp", "a2a"],
      allowedGatewayIds: [agent.id],
    });
  const token = (
    await issueManagedOauthClientAccessToken({
      clientId: client.clientId,
      clientSecret,
      scope: "a2a",
    })
  ).body.access_token as string;
  expect(await validateMCPGatewayToken(agent.id, token, "a2a")).not.toBeNull();
  expect(await validateMCPGatewayToken(agent.id, token)).toBeNull();
  await ManagedOauthClientModel.update({
    id: client.id,
    organizationId: ctx.organizationId,
    name: client.name,
    scopes: ["mcp"],
  });
  const next = await issueManagedOauthClientAccessToken({
    clientId: client.clientId,
    clientSecret,
    scope: "a2a",
  });
  expect(next).toMatchObject({ ok: false, statusCode: 400 });
});

test("validates capability-specific targets and refuses foreign organization bindings", async ({
  makeMember,
  makeAgent,
  makeOrganization,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  const foreign = await makeOrganization();
  const foreignAgent = await makeAgent({
    organizationId: foreign.id,
    agentType: "agent",
  });
  const localAgent = await makeAgent({
    organizationId: ctx.organizationId,
    agentType: "mcp_gateway",
  });
  for (const [id, scopes, status] of [
    [foreignAgent.id, ["a2a"], 404],
    [localAgent.id, ["a2a"], 400],
  ] as const) {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/oauth-clients",
      payload: { name: "Invalid binding", scopes, allowedGatewayIds: [id] },
    });
    expect(response.statusCode).toBe(status);
  }
});

test.each([
  [[]],
  [["unknown"]],
  [["mcp", "mcp"]],
])("rejects invalid scope grants %j", async (scopes) => {
  expect(
    (
      await ctx.app.inject({
        method: "POST",
        url: "/api/oauth-clients",
        payload: { name: "Invalid scopes", scopes },
      })
    ).statusCode,
  ).toBe(400);
});

test("edits scopes without changing client identity, sign-in mode or secret", async ({
  makeMember,
  makeAgent,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  const target = await makeAgent({
    organizationId: ctx.organizationId,
    agentType: "agent",
  });
  const { oauthClient: client, clientSecret } =
    await ManagedOauthClientModel.create({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      name: "Editable client",
      scopes: ["mcp", "a2a"],
      allowedGatewayIds: [target.id],
    });
  const edited = await ctx.app.inject({
    method: "PUT",
    url: `/api/oauth-clients/${client.id}`,
    payload: {
      name: "Updated client",
      grantType: "client_credentials",
      scopes: ["a2a"],
      allowedGatewayIds: [target.id],
    },
  });
  expect(edited.statusCode).toBe(200);
  expect(edited.json()).toMatchObject({
    id: client.id,
    clientId: client.clientId,
    scopes: ["a2a"],
  });
  expect(
    await ManagedOauthClientModel.findClientForCredentials({
      clientId: client.clientId,
      clientSecret,
    }),
  ).not.toBeNull();
  expect(
    (
      await ctx.app.inject({
        method: "PUT",
        url: `/api/oauth-clients/${client.id}`,
        payload: {
          name: "Changed identity",
          scopes: ["a2a"],
          grantType: "authorization_code",
          redirectUris: ["https://app.example.com/callback"],
        },
      })
    ).statusCode,
  ).toBe(400);
});

test("creation, capability edits and deletion are audited without exposing secrets", async ({
  makeMember,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  registerAuditLogHook(ctx.app);
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/oauth-clients",
    payload: {
      name: "Audited app",
      scopes: ["mcp", "a2a"],
      grantType: "authorization_code",
      redirectUris: ["https://app.example.com/callback"],
    },
  });
  expect(response.statusCode).toBe(200);
  const client = response.json();
  expect(
    (
      await ctx.app.inject({
        method: "PUT",
        url: `/api/oauth-clients/${client.id}`,
        payload: {
          name: "Audited app renamed",
          scopes: ["a2a"],
          grantType: "authorization_code",
          redirectUris: client.redirectUris,
        },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await ctx.app.inject({
        method: "DELETE",
        url: `/api/oauth-clients/${client.id}`,
      })
    ).statusCode,
  ).toBe(200);
  await vi.waitFor(async () => {
    expect(
      await db
        .select()
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.resourceId, client.id),
            eq(schema.auditLogsTable.resourceType, "oauthClient"),
          ),
        ),
    ).toHaveLength(3);
  });
  const audits = await db
    .select()
    .from(schema.auditLogsTable)
    .where(eq(schema.auditLogsTable.resourceId, client.id));
  expect(audits.map((row) => row.action).sort()).toEqual([
    "oauthClient.created",
    "oauthClient.deleted",
    "oauthClient.updated",
  ]);
  expect(JSON.stringify(audits)).not.toContain(client.clientSecret);
  expect(
    audits.find((row) => row.action === "oauthClient.updated")?.after,
  ).toMatchObject({ scopes: ["a2a"] });
});
