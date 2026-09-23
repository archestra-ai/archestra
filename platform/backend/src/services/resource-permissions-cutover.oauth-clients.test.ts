// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { ResourcePermissionAction } from "@archestra/shared";
import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { ResourcePermissions } from "@/services/resource-permissions";
import { describe, expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

/**
 * OAuth client registrations keep their owner and audience in the OAuth
 * provider's metadata column, not in columns of their own: `scope`, `authorId`
 * and a `oauth_client_team` junction. The conversion turns that into grants on
 * `mcpOauthClient` / `llmOauthClient`, and the team-admin and admin role
 * actions that used to widen who could manage them into grants too.
 */
describe("OAuth client conversion", () => {
  test("converts every visibility to grants that keep exactly the old reach", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const foreign = await makeOrganization({ legacyPermissions: true });
    const author = await makeUser();
    const editorInTeam = await makeUser();
    const memberInTeam = await makeUser();
    const outsideMember = await makeUser();
    const admin = await makeUser();
    await makeMember(author.id, org.id, { role: "editor" });
    await makeMember(editorInTeam.id, org.id, { role: "editor" });
    await makeMember(memberInTeam.id, org.id, { role: "member" });
    await makeMember(outsideMember.id, org.id, { role: "member" });
    await makeMember(admin.id, org.id, { role: "admin" });
    const reader = await makeCustomRole(org.id, {
      permission: { mcpOauthClient: ["read"], llmOauthClient: ["read"] },
    });
    // Holds neither kind's read, so an organization-wide client never showed.
    const blind = await makeCustomRole(org.id, {
      permission: { agent: ["read"] },
    });
    const manager = await makeCustomRole(org.id, {
      permission: { mcpOauthClient: ["read", "update", "admin"] },
    });
    const team = await makeTeam(org.id, author.id);
    await makeTeamMember(team.id, editorInTeam.id);
    await makeTeamMember(team.id, memberInTeam.id);

    const personal = await insertClient({
      organizationId: org.id,
      type: "mcp_oauth_client",
      scope: "personal",
      authorId: author.id,
    });
    const teamScoped = await insertClient({
      organizationId: org.id,
      type: "llm_oauth_client",
      scope: "team",
      authorId: author.id,
      teamIds: [team.id],
    });
    const orgScoped = await insertClient({
      organizationId: org.id,
      type: "mcp_oauth_client",
      scope: "org",
      authorId: null,
    });
    // Written before scoping existed: no scope, visible to the organization.
    const unscoped = await insertClient({
      organizationId: org.id,
      type: "llm_oauth_client",
    });
    // A client that registered itself is nobody's to share.
    const selfRegistered = await insertClient({ organizationId: org.id });
    const elsewhere = await insertClient({
      organizationId: foreign.id,
      type: "mcp_oauth_client",
      scope: "personal",
      authorId: author.id,
    });

    await runScopedResourcePermissionCutover();

    const grantsOf = async (
      resource: "mcpOauthClient" | "llmOauthClient",
      scope: string,
      organizationId = org.id,
    ) =>
      (
        await ResourcePermissionPolicyModel.find({
          organizationId,
          resource,
          scope,
        })
      )?.grants;
    const full = ["delete", "manage-permissions", "read", "update"];

    expect(await grantsOf("mcpOauthClient", personal)).toEqual([
      { subject: { type: "user", id: author.id }, actions: full },
    ]);
    // Team members saw the client; the editor in the team could also manage
    // it through the team-admin action the built-in editor held. Its author
    // is in none of its teams, and authorship alone never reached a shared
    // client, so the author gains nothing here.
    expect(await grantsOf("llmOauthClient", teamScoped)).toEqual([
      { subject: { type: "team", id: team.id }, actions: ["read"] },
      { subject: { type: "user", id: editorInTeam.id }, actions: full },
    ]);
    const readers = [
      { subject: { type: "role", id: "admin" }, actions: ["read"] },
      { subject: { type: "role", id: "editor" }, actions: ["read"] },
      { subject: { type: "role", id: "member" }, actions: ["read"] },
      { subject: { type: "role", id: "platform_admin" }, actions: ["read"] },
      { subject: { type: "role", id: reader.id }, actions: ["read"] },
    ];
    const byId = <T extends { subject: { id: string } }>(
      grants: T[] | undefined,
    ) =>
      [...(grants ?? [])].sort((a, b) =>
        a.subject.id.localeCompare(b.subject.id),
      );
    // Every role that held the kind's read action, custom roles included.
    expect(byId(await grantsOf("mcpOauthClient", orgScoped))).toEqual(
      byId([
        ...readers,
        { subject: { type: "role", id: manager.id }, actions: ["read"] },
      ]),
    );
    expect(byId(await grantsOf("llmOauthClient", unscoped))).toEqual(
      byId(readers),
    );
    expect(
      (await grantsOf("mcpOauthClient", orgScoped))?.some(
        (grant) => grant.subject.id === blind.id,
      ),
    ).toBe(false);
    expect(await grantsOf("mcpOauthClient", selfRegistered)).toBeUndefined();
    expect(await grantsOf("llmOauthClient", selfRegistered)).toBeUndefined();
    // Converted in its own organization, and only there.
    expect(await grantsOf("mcpOauthClient", elsewhere)).toBeUndefined();
    expect(
      await grantsOf("mcpOauthClient", elsewhere, foreign.id),
    ).toBeDefined();

    // The admin tiers reach every client of both kinds, and a custom role
    // that held `admin` keeps the actions its role actually carried.
    expect(byId(await grantsOf("mcpOauthClient", "*"))).toEqual(
      byId([
        { subject: { type: "role", id: "admin" }, actions: full },
        { subject: { type: "role", id: "platform_admin" }, actions: full },
        // read, update and the manage-permissions update implies sit
        // between two presets; like every grant, it widens to the larger.
        { subject: { type: "role", id: manager.id }, actions: full },
      ]),
    );
    expect(byId(await grantsOf("llmOauthClient", "*"))).toEqual(
      byId([
        { subject: { type: "role", id: "admin" }, actions: full },
        { subject: { type: "role", id: "platform_admin" }, actions: full },
      ]),
    );
    // The role actions are gone once they are grants.
    const [storedManager] = await db
      .select({ permission: schema.organizationRolesTable.permission })
      .from(schema.organizationRolesTable)
      .where(eq(schema.organizationRolesTable.id, manager.id));
    expect(JSON.parse(storedManager.permission).mcpOauthClient).toEqual([
      "read",
      "update",
    ]);

    // No access lost, asked the way the routes ask.
    const allows = (
      userId: string,
      resource: "mcpOauthClient" | "llmOauthClient",
      scope: string,
      action: ResourcePermissionAction,
    ) =>
      ResourcePermissions.allows({
        organizationId: org.id,
        userId,
        resource,
        scope,
        action,
      });
    expect(await allows(author.id, "mcpOauthClient", personal, "delete")).toBe(
      true,
    );
    expect(
      await allows(outsideMember.id, "mcpOauthClient", personal, "read"),
    ).toBe(false);
    expect(
      await allows(memberInTeam.id, "llmOauthClient", teamScoped, "read"),
    ).toBe(true);
    expect(
      await allows(memberInTeam.id, "llmOauthClient", teamScoped, "update"),
    ).toBe(false);
    expect(
      await allows(editorInTeam.id, "llmOauthClient", teamScoped, "delete"),
    ).toBe(true);
    expect(
      await allows(outsideMember.id, "llmOauthClient", teamScoped, "read"),
    ).toBe(false);
    expect(
      await allows(outsideMember.id, "mcpOauthClient", orgScoped, "read"),
    ).toBe(true);
    expect(
      await allows(outsideMember.id, "mcpOauthClient", orgScoped, "update"),
    ).toBe(false);
    expect(await allows(admin.id, "mcpOauthClient", personal, "delete")).toBe(
      true,
    );
  });

  test("a second run changes nothing, and an edit made after the first survives it", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const author = await makeUser();
    const other = await makeUser();
    await makeMember(author.id, org.id, { role: "editor" });
    await makeMember(other.id, org.id, { role: "member" });
    const team = await makeTeam(org.id, author.id);
    const shared = await insertClient({
      organizationId: org.id,
      type: "mcp_oauth_client",
      scope: "team",
      authorId: author.id,
      teamIds: [team.id],
    });
    await insertClient({
      organizationId: org.id,
      type: "llm_oauth_client",
      scope: "org",
    });

    await runScopedResourcePermissionCutover();
    const snapshot = () =>
      db
        .select()
        .from(schema.resourcePermissionPoliciesTable)
        .where(
          and(
            eq(schema.resourcePermissionPoliciesTable.organizationId, org.id),
            inArray(schema.resourcePermissionPoliciesTable.resource, [
              "mcpOauthClient",
              "llmOauthClient",
            ]),
          ),
        )
        .orderBy(
          schema.resourcePermissionPoliciesTable.resource,
          schema.resourcePermissionPoliciesTable.scope,
        );
    const first = await snapshot();
    await runScopedResourcePermissionCutover();
    expect(await snapshot()).toEqual(first);

    // Revoke the team in the editor; the old junction row must not restore it.
    const key = {
      organizationId: org.id,
      resource: "mcpOauthClient" as const,
      scope: shared,
    };
    const policy = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [
        {
          subject: { type: "user", id: other.id },
          actions: ["read"],
        },
      ],
    });
    await runScopedResourcePermissionCutover();
    expect((await ResourcePermissionPolicyModel.find(key))?.grants).toEqual([
      { subject: { type: "user", id: other.id }, actions: ["read"] },
    ]);
  });

  test("a new organization starts with the admin tiers at every OAuth client", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    for (const resource of ["mcpOauthClient", "llmOauthClient"] as const) {
      const policy = await ResourcePermissionPolicyModel.find({
        organizationId: org.id,
        resource,
        scope: "*",
      });
      expect(policy?.grants).toEqual([
        {
          subject: { type: "role", id: "admin" },
          actions: ["read", "update", "delete", "manage-permissions"],
        },
        {
          subject: { type: "role", id: "platform_admin" },
          actions: ["read", "update", "delete", "manage-permissions"],
        },
      ]);
    }
  });
});

/**
 * An `oauth_client` row as the OAuth provider and the two management models
 * store it. Written raw so a test can set the retired metadata fields.
 */
async function insertClient(params: {
  organizationId: string;
  type?: "mcp_oauth_client" | "llm_oauth_client";
  scope?: "personal" | "team" | "org";
  authorId?: string | null;
  teamIds?: string[];
}): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(schema.oauthClientsTable).values({
    id,
    clientId: `test_${id}`,
    name: `client ${id.slice(0, 8)}`,
    redirectUris: [],
    metadata: params.type
      ? {
          type: params.type,
          organizationId: params.organizationId,
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.authorId !== undefined
            ? { authorId: params.authorId }
            : {}),
        }
      : { organizationId: params.organizationId },
  });
  if (params.teamIds?.length)
    await db
      .insert(schema.oauthClientTeamsTable)
      .values(params.teamIds.map((teamId) => ({ oauthClientId: id, teamId })));
  return id;
}
