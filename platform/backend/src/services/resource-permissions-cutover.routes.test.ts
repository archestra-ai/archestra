// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { eq } from "drizzle-orm";
import { type TestAPI, vi } from "vitest";
import { betterAuth } from "@/auth";
import { authPlugin } from "@/auth/fastify-plugin";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import McpCatalogTeamModel from "@/models/mcp-catalog-team";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import SkillModel from "@/models/skill";
import SkillTeamModel from "@/models/skill-team";
import agentRoutes from "@/routes/agent";
import internalMcpCatalogRoutes from "@/routes/internal-mcp-catalog";
import knowledgeBaseRoutes from "@/routes/knowledge-base";
import llmProviderApiKeyRoutes from "@/routes/llm-provider-api-keys";
import resourcePermissionRoutes from "@/routes/resource-permission/resource-permission.routes";
import skillRoutes from "@/routes/skill/skill.routes";
import { accessGrants, describe, expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

type Fixtures = Pick<
  typeof test extends TestAPI<infer Context> ? Context : never,
  | "makeOrganization"
  | "makeUser"
  | "makeMember"
  | "makeCustomRole"
  | "makeTeam"
  | "makeTeamMember"
  | "makeAgent"
  | "makeInternalMcpCatalog"
  | "makeKnowledgeBase"
  | "makeSecret"
  | "makeLlmProviderApiKey"
  | "removeObjectPolicies"
>;

/**
 * What the upgrade owes, asked through the real HTTP routes: after the
 * conversion, each person can read, edit, share and delete exactly what they
 * could before it, save the changes the upgrade makes on purpose.
 *
 * The world is seeded as it stood before the upgrade, then converted once.
 * Every request passes the real authentication middleware, so the role gate
 * of each endpoint applies as well as the object grant.
 *
 * The expected statuses are the rules before the upgrade:
 * - A role `admin` action reached every object. It is now Full access at `*`.
 * - A personal agent, skill or catalog entry was its author's.
 * - A team agent or skill was editable by a member of its team whose role
 *   held `team-admin` (the Editor role). Other members could only use it.
 * - An organization agent was editable by admins only.
 * - A knowledge base was editable by a member of its team whose role held
 *   `knowledgeSource:update`. Only `knowledgeSource:admin` changed who sees it.
 * - A personal provider key was its owner's alone. An organization key was
 *   editable by `llmProviderApiKey:admin` only.
 *
 * The approved changes, marked where they apply:
 * - Plain members of a team with `write` on a registry entry can now edit it.
 *   Before, this took a team admin.
 * - A provider key whose owner is gone was reachable by nobody. Admins can now
 *   manage it, but it is never picked as a default key.
 * - Every organization-wide `use` grant widens to the Can use preset, so a
 *   role without `agent:read` can now read an organization agent.
 */
describe("write routes after the upgrade", () => {
  test("reads, edits and permission saves match the rules before the upgrade", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeTeam,
    makeTeamMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeKnowledgeBase,
    makeSecret,
    makeLlmProviderApiKey,
    removeObjectPolicies,
  }) => {
    const world = await seedLegacyWorld({
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
      makeTeam,
      makeTeamMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeKnowledgeBase,
      makeSecret,
      makeLlmProviderApiKey,
      removeObjectPolicies,
    });
    const app = await routesAs(world.organizationId);

    // [read, edit, save permissions] for each principal.
    const expected: Record<ObjectName, Record<PrincipalName, Statuses>> = {
      agentPersonal: {
        admin: [200, 200, 200],
        author: [200, 200, 200],
        teammate: [404, 403, 403],
        teamEditor: [404, 403, 403],
        outsider: [404, 403, 403],
        loner: [404, 403, 403],
        blind: [404, 404, 403],
      },
      agentTeam: {
        admin: [200, 200, 200],
        // Authorship gave nothing once an agent was shared with a team.
        author: [404, 403, 403],
        teammate: [200, 403, 403],
        teamEditor: [200, 200, 200],
        outsider: [404, 403, 403],
        loner: [404, 403, 403],
        blind: [404, 404, 403],
      },
      agentOrg: {
        admin: [200, 200, 200],
        author: [200, 403, 403],
        teammate: [200, 403, 403],
        teamEditor: [200, 403, 403],
        outsider: [200, 403, 403],
        loner: [200, 403, 403],
        // Approved: the widening to the Can use preset.
        blind: [200, 404, 403],
      },
      skill: {
        admin: [200, 200, 200],
        author: [404, 404, 403],
        teammate: [200, 403, 403],
        teamEditor: [200, 200, 200],
        outsider: [404, 404, 403],
        loner: [404, 404, 403],
        blind: [404, 404, 403],
      },
      catalog: {
        admin: [200, 200, 200],
        author: [404, 404, 403],
        // Approved: plain members of a `write` team can now edit the entry.
        teammate: [200, 200, 403],
        teamEditor: [200, 200, 403],
        outsider: [404, 404, 403],
        loner: [404, 404, 403],
        blind: [404, 404, 403],
      },
      knowledgeBase: {
        admin: [200, 200, 200],
        author: [404, 403, 403],
        teammate: [200, 403, 403],
        teamEditor: [200, 200, 403],
        outsider: [404, 403, 403],
        loner: [404, 403, 403],
        blind: [403, 403, 403],
      },
      ownedKey: {
        // An owned key is its owner's alone, admins included.
        admin: [404, 403, 403],
        author: [200, 200, 200],
        teammate: [404, 403, 403],
        teamEditor: [404, 403, 403],
        outsider: [404, 403, 403],
        loner: [404, 403, 403],
        blind: [404, 403, 403],
      },
      organizationKey: {
        admin: [200, 200, 200],
        author: [200, 403, 403],
        teammate: [200, 403, 403],
        teamEditor: [200, 403, 403],
        outsider: [200, 403, 403],
        loner: [200, 403, 403],
        blind: [404, 403, 403],
      },
      ownerlessKey: {
        // Approved: admins manage a key whose owner is gone.
        admin: [200, 200, 200],
        author: [404, 403, 403],
        teammate: [404, 403, 403],
        teamEditor: [404, 403, 403],
        outsider: [404, 403, 403],
        loner: [404, 403, 403],
        blind: [404, 403, 403],
      },
    };

    const actual: Record<string, Record<string, Statuses>> = {};
    for (const [name, object] of Object.entries(world.objects)) {
      actual[name] = {};
      for (const [who, user] of Object.entries(world.principals)) {
        actual[name][who] = await readEditSave({
          app,
          userId: user.id,
          organizationId: world.organizationId,
          object,
        });
      }
    }
    await app.close();
    expect(actual).toEqual(expected);
  });

  test("deletes match the rules before the upgrade", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeTeam,
    makeTeamMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeKnowledgeBase,
    makeSecret,
    makeLlmProviderApiKey,
    removeObjectPolicies,
  }) => {
    const fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
      makeTeam,
      makeTeamMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeKnowledgeBase,
      makeSecret,
      makeLlmProviderApiKey,
      removeObjectPolicies,
    };
    // For each principal, the statuses of deleting every object.
    const expected: Record<PrincipalName, Record<ObjectName, number>> = {
      admin: {
        agentPersonal: 200,
        agentTeam: 200,
        agentOrg: 200,
        skill: 200,
        catalog: 200,
        knowledgeBase: 200,
        ownedKey: 403,
        organizationKey: 200,
        // Approved: admins manage a key whose owner is gone.
        ownerlessKey: 200,
      },
      author: {
        agentPersonal: 200,
        agentTeam: 403,
        agentOrg: 403,
        skill: 404,
        catalog: 404,
        knowledgeBase: 403,
        ownedKey: 200,
        organizationKey: 403,
        ownerlessKey: 403,
      },
      teammate: {
        agentPersonal: 403,
        agentTeam: 403,
        agentOrg: 403,
        skill: 403,
        // The `write` widening covers edits, not deletion.
        catalog: 403,
        knowledgeBase: 403,
        ownedKey: 403,
        organizationKey: 403,
        ownerlessKey: 403,
      },
      teamEditor: {
        agentPersonal: 403,
        agentTeam: 200,
        agentOrg: 403,
        skill: 200,
        catalog: 403,
        knowledgeBase: 200,
        ownedKey: 403,
        organizationKey: 403,
        ownerlessKey: 403,
      },
      outsider: {
        agentPersonal: 403,
        agentTeam: 403,
        agentOrg: 403,
        skill: 404,
        catalog: 404,
        knowledgeBase: 403,
        ownedKey: 403,
        organizationKey: 403,
        ownerlessKey: 403,
      },
      loner: {
        agentPersonal: 403,
        agentTeam: 403,
        agentOrg: 403,
        skill: 404,
        catalog: 404,
        knowledgeBase: 403,
        ownedKey: 403,
        organizationKey: 403,
        ownerlessKey: 403,
      },
      blind: {
        agentPersonal: 404,
        agentTeam: 404,
        agentOrg: 404,
        skill: 404,
        catalog: 404,
        knowledgeBase: 403,
        ownedKey: 403,
        organizationKey: 403,
        ownerlessKey: 403,
      },
    };

    // A delete that succeeds removes the object, so each principal gets a
    // world of its own.
    const actual: Record<string, Record<string, number>> = {};
    for (const who of Object.keys(expected) as PrincipalName[]) {
      const world = await seedLegacyWorld(fixtures);
      const app = await routesAs(world.organizationId);
      actual[who] = {};
      for (const [name, object] of Object.entries(world.objects)) {
        const response = await app.inject({
          method: "DELETE",
          url: object.url,
          headers: { [USER_HEADER]: world.principals[who].id },
        });
        actual[who][name] = response.statusCode;
      }
      await app.close();
    }
    expect(actual).toEqual(expected);
  });

  test("a key whose owner is gone is never the default key, even as the only primary", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeTeam,
    makeTeamMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeKnowledgeBase,
    makeSecret,
    makeLlmProviderApiKey,
    removeObjectPolicies,
  }) => {
    const world = await seedLegacyWorld({
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
      makeTeam,
      makeTeamMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeKnowledgeBase,
      makeSecret,
      makeLlmProviderApiKey,
      removeObjectPolicies,
    });
    const [ownerless] = await db
      .select({ isPrimary: schema.llmProviderApiKeysTable.isPrimary })
      .from(schema.llmProviderApiKeysTable)
      .where(
        eq(schema.llmProviderApiKeysTable.id, world.objects.ownerlessKey.id),
      );
    // The upgrade left it the primary Anthropic key without an owner, as on a
    // deployment whose key owner was deleted.
    expect(ownerless?.isPrimary).toBe(true);

    const resolved = await LlmProviderApiKeyModel.getCurrentApiKey({
      organizationId: world.organizationId,
      userId: world.principals.admin.id,
      userTeamIds: [],
      provider: "anthropic",
      conversationId: null,
    });

    expect(resolved?.id).toBe(world.objects.organizationKey.id);
  });
});

// ===

const USER_HEADER = "x-test-user";

type Statuses = [read: number, edit: number, savePermissions: number];
type World = Awaited<ReturnType<typeof seedLegacyWorld>>;
type ObjectName = keyof World["objects"];
type PrincipalName = keyof World["principals"];

type WorldObject = {
  url: string;
  resource:
    | "agent"
    | "skill"
    | "mcpRegistry"
    | "knowledgeBase"
    | "llmProviderApiKey";
  id: string;
  updateMethod: "PUT" | "PATCH";
  update: Record<string, unknown>;
};

/**
 * The organization as it stood before the upgrade: sharing lives in the
 * retired columns and team rows, and no object has a policy. The cutover then
 * runs once, as it does at the first start after the upgrade.
 */
async function seedLegacyWorld(fx: Fixtures) {
  const org = await fx.makeOrganization({ legacyPermissions: true });
  const principals = {
    admin: await fx.makeUser(),
    author: await fx.makeUser(),
    teammate: await fx.makeUser(),
    teamEditor: await fx.makeUser(),
    outsider: await fx.makeUser(),
    loner: await fx.makeUser(),
    blind: await fx.makeUser(),
  };
  await fx.makeMember(principals.admin.id, org.id, { role: "admin" });
  for (const user of [
    principals.author,
    principals.teammate,
    principals.outsider,
    principals.loner,
  ]) {
    await fx.makeMember(user.id, org.id);
  }
  await fx.makeMember(principals.teamEditor.id, org.id, { role: "editor" });
  const blindRole = await fx.makeCustomRole(org.id, { permission: {} });
  await fx.makeMember(principals.blind.id, org.id, { role: blindRole.role });
  // The admin creates both teams, so the author belongs to neither.
  const team = await fx.makeTeam(org.id, principals.admin.id);
  const otherTeam = await fx.makeTeam(org.id, principals.admin.id);
  await fx.makeTeamMember(team.id, principals.teammate.id);
  await fx.makeTeamMember(team.id, principals.teamEditor.id);
  await fx.makeTeamMember(otherTeam.id, principals.outsider.id);

  const agentPersonal = await fx.makeAgent({
    organizationId: org.id,
    agentType: "agent",
    authorId: principals.author.id,
    access: "personal",
    legacy: { scope: "personal" },
  });
  const agentTeam = await fx.makeAgent({
    organizationId: org.id,
    agentType: "agent",
    authorId: principals.author.id,
    access: { teams: [] },
    legacy: { scope: "team", teams: [team.id] },
  });
  const agentOrg = await fx.makeAgent({
    organizationId: org.id,
    agentType: "agent",
    authorId: principals.author.id,
    legacy: { scope: "org" },
  });
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId: org.id,
      authorId: principals.author.id,
      name: "team-skill",
      description: "Shared with one team",
      content: "# Instructions",
      sourceType: "manual",
    },
    files: [],
    ...accessGrants("personal"),
  });
  if (!skill) throw new Error("failed to seed skill");
  await db
    .update(schema.skillsTable)
    .set({ scope: "team" })
    .where(eq(schema.skillsTable.id, skill.id));
  await SkillTeamModel.syncSkillTeams(skill.id, [team.id]);
  const catalog = await fx.makeInternalMcpCatalog({
    organizationId: org.id,
    authorId: principals.author.id,
    access: { teams: [] },
    legacy: { scope: "team" },
  });
  await McpCatalogTeamModel.syncCatalogTeams(catalog.id, [
    { id: team.id, level: "write" },
  ]);
  const knowledgeBase = await fx.makeKnowledgeBase(org.id, {
    createdBy: principals.author.id,
    legacy: { visibility: "team-scoped", teamIds: [team.id] },
  });
  const secret = await fx.makeSecret();
  const ownedKey = await fx.makeLlmProviderApiKey(org.id, secret.id, {
    userId: principals.author.id,
    isPrimary: false,
  });
  const organizationKey = await fx.makeLlmProviderApiKey(org.id, secret.id, {
    isPrimary: false,
  });
  // A personal key whose owner is gone: the owner column is empty and the
  // scope column still says personal. Deleting the owner would delete the
  // key too, so the seed empties the column instead. It stays primary, so it
  // becomes the only primary Anthropic key without an owner.
  const ownerlessKey = await fx.makeLlmProviderApiKey(org.id, secret.id, {
    userId: principals.author.id,
    isPrimary: true,
  });
  await db
    .update(schema.llmProviderApiKeysTable)
    .set({ userId: null, scope: "personal" })
    .where(eq(schema.llmProviderApiKeysTable.id, ownerlessKey.id));
  await fx.removeObjectPolicies(org.id);

  await runScopedResourcePermissionCutover();

  const rename = { name: "Renamed" };
  const objects = {
    agentPersonal: {
      url: `/api/agents/${agentPersonal.id}`,
      resource: "agent",
      id: agentPersonal.id,
      updateMethod: "PUT",
      update: rename,
    },
    agentTeam: {
      url: `/api/agents/${agentTeam.id}`,
      resource: "agent",
      id: agentTeam.id,
      updateMethod: "PUT",
      update: rename,
    },
    agentOrg: {
      url: `/api/agents/${agentOrg.id}`,
      resource: "agent",
      id: agentOrg.id,
      updateMethod: "PUT",
      update: rename,
    },
    skill: {
      url: `/api/skills/${skill.id}`,
      resource: "skill",
      id: skill.id,
      updateMethod: "PUT",
      update: {
        content:
          "---\nname: team-skill\ndescription: Edited\n---\n\nInstructions.",
      },
    },
    catalog: {
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      resource: "mcpRegistry",
      id: catalog.id,
      updateMethod: "PUT",
      update: { description: "Edited" },
    },
    knowledgeBase: {
      url: `/api/knowledge-bases/${knowledgeBase.id}`,
      resource: "knowledgeBase",
      id: knowledgeBase.id,
      updateMethod: "PUT",
      update: rename,
    },
    ownedKey: {
      url: `/api/llm-provider-api-keys/${ownedKey.id}`,
      resource: "llmProviderApiKey",
      id: ownedKey.id,
      updateMethod: "PATCH",
      update: rename,
    },
    organizationKey: {
      url: `/api/llm-provider-api-keys/${organizationKey.id}`,
      resource: "llmProviderApiKey",
      id: organizationKey.id,
      updateMethod: "PATCH",
      update: rename,
    },
    ownerlessKey: {
      url: `/api/llm-provider-api-keys/${ownerlessKey.id}`,
      resource: "llmProviderApiKey",
      id: ownerlessKey.id,
      updateMethod: "PATCH",
      update: rename,
    },
  } satisfies Record<string, WorldObject>;

  return { organizationId: org.id, principals, objects };
}

/**
 * The routes behind the real authentication middleware, so the role gate of
 * each endpoint applies as well as the object grant. Only the session lookup
 * is stubbed: it names the user in a test header.
 */
async function routesAs(organizationId: string) {
  vi.spyOn(betterAuth.api, "getSession").mockImplementation((async ({
    headers,
  }: {
    headers: Headers;
  }) => {
    const userId = headers.get(USER_HEADER);
    return {
      response: userId
        ? {
            user: { id: userId },
            session: {
              id: `session-${userId}`,
              createdAt: new Date(),
              activeOrganizationId: organizationId,
            },
          }
        : null,
      headers: new Headers(),
    };
  }) as unknown as typeof betterAuth.api.getSession);
  const app = createFastifyInstance();
  await app.register(authPlugin);
  for (const routes of [
    agentRoutes,
    skillRoutes,
    internalMcpCatalogRoutes,
    knowledgeBaseRoutes,
    llmProviderApiKeyRoutes,
    resourcePermissionRoutes,
  ]) {
    await app.register(routes);
  }
  return app;
}

/**
 * Read the object, edit it, and save its permissions unchanged. The save
 * sends the grants the object already has, so it changes nothing, and it
 * still needs `manage-permissions`.
 */
async function readEditSave(params: {
  app: Awaited<ReturnType<typeof routesAs>>;
  userId: string;
  organizationId: string;
  object: WorldObject;
}) {
  const { app, userId, organizationId, object } = params;
  const headers = { [USER_HEADER]: userId };
  const read = await app.inject({ method: "GET", url: object.url, headers });
  const update = await app.inject({
    method: object.updateMethod,
    url: object.url,
    headers,
    payload: object.update,
  });
  const policy = await ResourcePermissionPolicyModel.find({
    organizationId,
    resource: object.resource,
    scope: object.id,
  });
  const share = await app.inject({
    method: "PUT",
    url: `/api/resource-permissions/${object.resource}/${object.id}`,
    headers,
    payload: { revision: policy?.revision ?? 0, grants: policy?.grants ?? [] },
  });
  return [read.statusCode, update.statusCode, share.statusCode] as Statuses;
}
