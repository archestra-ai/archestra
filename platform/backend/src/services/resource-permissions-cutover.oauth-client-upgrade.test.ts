// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import ManagedOauthClientModel from "@/models/managed-oauth-client";
import OAuthAccessTokenModel from "@/models/oauth-access-token";
import { validateMCPGatewayToken } from "@/routes/mcp-gateway/utils";
import { runScopedResourcePermissionCutover } from "@/services/resource-permissions-cutover";
import { expect, test } from "@/test";

const subsets = [[], ["read"], ["create"], ["read", "create"]];
test("unions every old role action combination, preserves role identity and unrelated permissions", async ({
  makeOrganization,
  makeCustomRole,
}) => {
  const org = await makeOrganization();
  const roles = [];
  for (const mcp of subsets)
    for (const llm of subsets) {
      const role = await makeCustomRole(org.id);
      await db
        .update(schema.organizationRolesTable)
        .set({
          permission: JSON.stringify({
            chat: ["read"],
            mcpOauthClient: mcp,
            llmOauthClient: llm,
          }),
        })
        .where(eq(schema.organizationRolesTable.id, role.id));
      roles.push({
        id: role.id,
        role: role.role,
        expected: [...new Set([...mcp, ...llm])].sort(),
      });
    }
  await runScopedResourcePermissionCutover();
  for (const expected of roles) {
    const [row] = await db
      .select()
      .from(schema.organizationRolesTable)
      .where(eq(schema.organizationRolesTable.id, expected.id));
    expect(row.role).toBe(expected.role);
    expect(JSON.parse(row.permission)).toEqual(
      expected.expected.length
        ? { chat: ["read"], oauthClient: expected.expected }
        : { chat: ["read"] },
    );
  }
});

test("merges wildcard grants by subject and action, and never restores a later revocation", async ({
  makeOrganization,
  makeCustomRole,
}) => {
  const org = await makeOrganization();
  const role = await makeCustomRole(org.id);
  for (const [resource, actions] of [
    ["mcpOauthClient", ["read"]],
    ["llmOauthClient", ["read", "update"]],
  ] as const) {
    await db.insert(schema.resourcePermissionPoliciesTable).values({
      organizationId: org.id,
      resource,
      scope: "*",
      legacySharingMigrated: true,
      grants: [
        { subject: { type: "role", id: role.id }, actions: [...actions] },
      ],
    });
  }
  await runScopedResourcePermissionCutover();
  const find = async () =>
    (
      await db
        .select()
        .from(schema.resourcePermissionPoliciesTable)
        .where(
          and(
            eq(schema.resourcePermissionPoliciesTable.organizationId, org.id),
            eq(schema.resourcePermissionPoliciesTable.resource, "oauthClient"),
            eq(schema.resourcePermissionPoliciesTable.scope, "*"),
          ),
        )
    )[0];
  const migrated = await find();
  expect(
    migrated.grants.find((grant) => grant.subject.id === role.id)?.actions,
  ).toEqual(["read", "update"]);
  expect(migrated.grants.flatMap((grant) => grant.actions)).not.toContain(
    "use",
  );
  const grants = migrated.grants.filter(
    (grant) => grant.subject.id !== role.id,
  );
  await db
    .update(schema.resourcePermissionPoliciesTable)
    .set({ grants, revision: migrated.revision + 1 })
    .where(
      and(
        eq(schema.resourcePermissionPoliciesTable.organizationId, org.id),
        eq(schema.resourcePermissionPoliciesTable.resource, "oauthClient"),
        eq(schema.resourcePermissionPoliciesTable.scope, "*"),
      ),
    );
  const revoked = await find();
  await runScopedResourcePermissionCutover();
  expect(await find()).toEqual(revoked);
  expect(
    (await db.select().from(schema.resourcePermissionPoliciesTable)).some(
      (policy) =>
        policy.resource === "mcpOauthClient" ||
        policy.resource === "llmOauthClient",
    ),
  ).toBe(false);
});

test("preserves old client identity, secret and target configuration while migrating scopes", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const author = await makeUser();
  const gateway = await makeAgent({
    organizationId: org.id,
    agentType: "mcp_gateway",
  });
  const { oauthClient: client, clientSecret } =
    await ManagedOauthClientModel.create({
      organizationId: org.id,
      authorId: author.id,
      name: "Existing automation",
      legacyKind: "mcp",
      scopes: ["mcp"],
      allowedGatewayIds: [gateway.id],
    });
  await db
    .update(schema.oauthClientsTable)
    .set({
      metadata: {
        type: "mcp_oauth_client",
        organizationId: org.id,
        authorId: author.id,
        allowedGatewayIds: [gateway.id],
        grantType: "client_credentials",
      },
    })
    .where(eq(schema.oauthClientsTable.id, client.id));
  await runScopedResourcePermissionCutover();
  const [raw] = await db
    .select()
    .from(schema.oauthClientsTable)
    .where(eq(schema.oauthClientsTable.id, client.id));
  expect(raw.clientId).toBe(client.clientId);
  expect(raw.scopes).toEqual(["mcp", "a2a"]);
  expect(raw.metadata).toMatchObject({
    type: "managed_oauth_client",
    organizationId: org.id,
    authorId: author.id,
    allowedGatewayIds: [gateway.id],
  });
  expect(
    await ManagedOauthClientModel.findClientForCredentials({
      clientId: client.clientId,
      clientSecret,
    }),
  ).toMatchObject({ id: client.id, scopes: ["mcp", "a2a"] });
  const policies = await db
    .select()
    .from(schema.resourcePermissionPoliciesTable);
  await runScopedResourcePermissionCutover();
  expect(
    await db.select().from(schema.resourcePermissionPoliciesTable),
  ).toEqual(policies);
});

test("captures an older admin action before removing legacy role keys", async ({
  makeOrganization,
  makeCustomRole,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
  const role = await makeCustomRole(org.id);
  await db
    .update(schema.organizationRolesTable)
    .set({
      permission: JSON.stringify({
        mcpOauthClient: ["read", "admin"],
        llmOauthClient: ["create"],
        chat: ["read"],
      }),
    })
    .where(eq(schema.organizationRolesTable.id, role.id));
  await runScopedResourcePermissionCutover();
  const [stored] = await db
    .select()
    .from(schema.organizationRolesTable)
    .where(eq(schema.organizationRolesTable.id, role.id));
  expect(JSON.parse(stored.permission)).toEqual({
    oauthClient: ["create", "read"],
    chat: ["read"],
  });
  const [policy] = await db
    .select()
    .from(schema.resourcePermissionPoliciesTable)
    .where(
      and(
        eq(schema.resourcePermissionPoliciesTable.organizationId, org.id),
        eq(schema.resourcePermissionPoliciesTable.resource, "oauthClient"),
        eq(schema.resourcePermissionPoliciesTable.scope, "*"),
      ),
    );
  expect(
    policy.grants.find((grant) => grant.subject.id === role.id)?.actions,
  ).toEqual(["read"]);
});

for (const legacyKind of ["mcp", "llm"] as const)
  test(`legacy ${legacyKind} creation remains private after restart`, async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const { oauthClient: client } = await ManagedOauthClientModel.create({
      organizationId: org.id,
      authorId: author.id,
      name: "Legacy API caller",
      legacyKind,
      scopes: legacyKind === "mcp" ? ["mcp", "a2a"] : ["llm:proxy"],
    });
    const query = () =>
      db
        .select()
        .from(schema.resourcePermissionPoliciesTable)
        .where(
          and(
            eq(schema.resourcePermissionPoliciesTable.organizationId, org.id),
            eq(schema.resourcePermissionPoliciesTable.scope, client.id),
          ),
        );
    const before = await query();
    await runScopedResourcePermissionCutover();
    expect(await query()).toEqual(before);
    expect(before[0].grants).toEqual([
      {
        subject: { type: "user", id: author.id },
        actions: ["read", "update", "delete", "manage-permissions"],
      },
    ]);
  });

test("old user tokens and refresh grants retain A2A, but new mcp-only tokens do not", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: "member" });
  const agent = await makeAgent({ organizationId: org.id, agentType: "agent" });
  const { oauthClient: client } = await ManagedOauthClientModel.create({
    organizationId: org.id,
    authorId: user.id,
    name: "Existing portal",
    legacyKind: "mcp",
    grantType: "authorization_code",
    scopes: ["mcp", "a2a"],
    allowedGatewayIds: [agent.id],
    redirectUris: ["https://portal.example.com/callback"],
  });
  await db
    .update(schema.oauthClientsTable)
    .set({
      metadata: {
        type: "mcp_oauth_client",
        organizationId: org.id,
        authorId: user.id,
        grantType: "authorization_code",
        allowedGatewayIds: [agent.id],
      },
    })
    .where(eq(schema.oauthClientsTable.id, client.id));
  const token = "old-portal-token";
  const expiresAt = new Date(Date.now() + 3600000);
  const oldToken = await OAuthAccessTokenModel.create({
    tokenHash: OAuthAccessTokenModel.hashTokenForLookup(token),
    clientId: client.clientId,
    userId: user.id,
    expiresAt,
    scopes: ["mcp"],
  });
  const refreshId = crypto.randomUUID();
  await db.insert(schema.oauthRefreshTokensTable).values({
    id: refreshId,
    token: "old-refresh",
    clientId: client.clientId,
    userId: user.id,
    expiresAt,
    scopes: ["mcp", "offline_access"],
  });
  await runScopedResourcePermissionCutover();
  expect(
    (
      await db
        .select()
        .from(schema.oauthAccessTokensTable)
        .where(eq(schema.oauthAccessTokensTable.id, oldToken.id))
    )[0].scopes,
  ).toEqual(["mcp", "a2a"]);
  expect(
    (
      await db
        .select()
        .from(schema.oauthRefreshTokensTable)
        .where(eq(schema.oauthRefreshTokensTable.id, refreshId))
    )[0].scopes,
  ).toEqual(["mcp", "offline_access", "a2a"]);
  expect(await validateMCPGatewayToken(agent.id, token, "a2a")).not.toBeNull();
  const narrow = "new-portal-token";
  await OAuthAccessTokenModel.create({
    tokenHash: OAuthAccessTokenModel.hashTokenForLookup(narrow),
    clientId: client.clientId,
    userId: user.id,
    expiresAt,
    scopes: ["mcp"],
  });
  await runScopedResourcePermissionCutover();
  expect(await validateMCPGatewayToken(agent.id, narrow)).not.toBeNull();
  expect(await validateMCPGatewayToken(agent.id, narrow, "a2a")).toBeNull();
});
