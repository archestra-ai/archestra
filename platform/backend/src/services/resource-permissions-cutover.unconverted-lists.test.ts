// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  ARCHESTRA_MCP_CATALOG_ID,
  PLAYWRIGHT_MCP_CATALOG_ID,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import McpCatalogTeamModel from "@/models/mcp-catalog-team";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import SkillTeamModel from "@/models/skill-team";
import { describe, expect, test } from "@/test";

/**
 * Lists read grants alone, so an object with no policy of its own is on no
 * one's list. These used to let such a row through a "not converted yet"
 * branch; the startup conversion writes a policy for every object, so that
 * branch could only ever widen access. The rows that have no per-object
 * policy by design are covered by explicit rules instead, pinned below.
 */
describe("lists read grants alone", () => {
  test("a skill without a policy is on no one's list", async ({
    makeOrganization,
    makeUser,
    makeMember,
    removeObjectPolicies,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const { default: SkillModel } = await import("@/models/skill");
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId: org.id,
        authorId: user.id,
        name: `unconverted-${crypto.randomUUID().slice(0, 8)}`,
        description: "Seeded for the unconverted-list check",
        content: "# Instructions",
        sourceType: "manual",
        scope: "org",
      },
      files: [],
    });
    if (!skill) throw new Error("failed to seed skill");
    const list = () =>
      SkillTeamModel.getUserAccessibleSkillIds({
        organizationId: org.id,
        userId: user.id,
      });
    // The author holds a grant while the policy exists...
    expect(await list()).toContain(skill.id);

    // ...and nothing once it is gone, whatever the retired scope says.
    await removeObjectPolicies(org.id);
    expect(await list()).toEqual([]);
  });

  test("a catalog item without a policy is on no one's list", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
    removeObjectPolicies,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: user.id,
      scope: "org",
    });
    const list = async () =>
      (
        await InternalMcpCatalogModel.findAll({
          expandSecrets: false,
          userId: user.id,
          isAdmin: false,
          organizationId: org.id,
        })
      ).map((item) => item.id);
    expect(await list()).toContain(catalog.id);

    await removeObjectPolicies(org.id);
    expect(await list()).not.toContain(catalog.id);
  });

  test("the built-in catalogs are listed for every member and nobody else", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    const outsider = await makeUser();
    await makeMember(member.id, org.id);
    for (const [id, serverType] of [
      [ARCHESTRA_MCP_CATALOG_ID, "builtin"],
      [PLAYWRIGHT_MCP_CATALOG_ID, "local"],
    ] as const) {
      await db
        .insert(schema.internalMcpCatalogTable)
        .values({ id, name: `builtin-${id.slice(-1)}`, serverType })
        .onConflictDoNothing();
    }

    expect(
      await McpCatalogTeamModel.getUserAccessibleCatalogIds(
        member.id,
        false,
        org.id,
      ),
    ).toEqual(
      expect.arrayContaining([
        ARCHESTRA_MCP_CATALOG_ID,
        PLAYWRIGHT_MCP_CATALOG_ID,
      ]),
    );
    expect(
      await McpCatalogTeamModel.getUserAccessibleCatalogIds(
        outsider.id,
        false,
        org.id,
      ),
    ).not.toContain(ARCHESTRA_MCP_CATALOG_ID);
  });

  test("a runtime variant follows its parent's grants", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const other = await makeUser();
    await makeMember(author.id, org.id);
    await makeMember(other.id, org.id);
    const parent = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: author.id,
      scope: "personal",
    });
    const child = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: author.id,
      scope: "org",
    });
    await db
      .update(schema.internalMcpCatalogTable)
      .set({ parentCatalogItemId: parent.id })
      .where(eq(schema.internalMcpCatalogTable.id, child.id));
    // The variant's own policy says nothing; only the parent's counts.
    await db
      .delete(schema.resourcePermissionPoliciesTable)
      .where(eq(schema.resourcePermissionPoliciesTable.scope, child.id));

    const ids = (userId: string) =>
      McpCatalogTeamModel.getUserAccessibleCatalogIds(userId, false, org.id);
    expect(await ids(author.id)).toContain(child.id);
    expect(await ids(other.id)).not.toContain(child.id);

    await grantRead({
      organizationId: org.id,
      resource: "mcpRegistry",
      scope: parent.id,
      userId: other.id,
    });
    expect(await ids(other.id)).toContain(child.id);
  });

  test("an app's backing catalog follows the app's grants", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeApp,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const other = await makeUser();
    await makeMember(author.id, org.id);
    await makeMember(other.id, org.id);
    const app = await makeApp({
      organizationId: org.id,
      authorId: author.id,
      scope: "personal",
    });
    const [backing] = await db
      .select({ catalogId: schema.mcpServersTable.catalogId })
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, app.mcpServerId as string));
    const catalogId = backing?.catalogId as string;

    const ids = (userId: string) =>
      McpCatalogTeamModel.getUserAccessibleCatalogIds(userId, false, org.id);
    expect(await ids(author.id)).toContain(catalogId);
    expect(await ids(other.id)).not.toContain(catalogId);

    await grantRead({
      organizationId: org.id,
      resource: "app",
      scope: app.id,
      userId: other.id,
    });
    expect(await ids(other.id)).toContain(catalogId);
  });
});

async function grantRead(params: {
  organizationId: string;
  resource: "mcpRegistry" | "app";
  scope: string;
  userId: string;
}) {
  const key = {
    organizationId: params.organizationId,
    resource: params.resource,
    scope: params.scope,
  };
  const policy = await ResourcePermissionPolicyModel.find(key);
  await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: policy?.revision ?? 0,
    grants: [
      ...(policy?.grants ?? []),
      {
        subject: { type: "user", id: params.userId },
        actions: ["read", "use"],
      },
    ],
  });
}
