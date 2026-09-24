// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { eq } from "drizzle-orm";
import type { TestAPI } from "vitest";
import db, { schema } from "@/database";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import ModelModel from "@/models/model";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import TeamModel from "@/models/team";
import agentRoutes from "@/routes/agent";
import llmProviderApiKeyRoutes from "@/routes/llm-provider-api-keys";
import resourcePermissionRoutes from "@/routes/resource-permission/resource-permission.routes";
import { describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

type Fixtures = Pick<
  typeof test extends TestAPI<infer Context> ? Context : never,
  | "makeOrganization"
  | "makeUser"
  | "makeMember"
  | "makeTeam"
  | "makeTeamMember"
  | "makeAgent"
  | "makeSecret"
  | "makeLlmProviderApiKey"
  | "removeObjectPolicies"
>;

/**
 * Provider keys shared with a team, and keys pinned to an agent, after the
 * upgrade. The world is seeded as it stood before the upgrade, then converted
 * once, and every request passes the real authentication middleware.
 *
 * The rules before the upgrade, for a key shared with a team:
 * - The key list showed it to `llmProviderApiKey:admin` holders and to the
 *   members of its team.
 * - Only members of its team could chat with it, admins included.
 * - Editing, deleting and re-sharing it took the route action
 *   (`llmProviderApiKey:update` or `delete`, which the Editor role held and
 *   the Member role did not) and membership in its team, or `team:create`.
 * - Default key resolution preferred the caller's own key, then a key of one
 *   of the caller's teams, then an organization key.
 *
 * The rule for a key pinned to an agent, the same before and after: chat with
 * the agent uses the pinned key without asking whether the caller may use it.
 * Access to the key comes through access to the agent.
 */
describe("provider keys after the upgrade", () => {
  test("a key shared with a team: list, chat use, edit, delete and share", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
    removeObjectPolicies,
  }) => {
    const fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeTeamMember,
      makeAgent,
      makeSecret,
      makeLlmProviderApiKey,
      removeObjectPolicies,
    };
    // [listed, offered for chat, edit, delete, save permissions]
    const expected: Record<PrincipalName, TeamKeyStatuses> = {
      // Approved: `llmProviderApiKey:admin` became Full access at `*`, so an
      // admin outside the team can now also chat with the key.
      admin: [true, true, 200, 200, 200],
      author: [false, false, 403, 403, 403],
      teammate: [true, true, 403, 403, 403],
      teamEditor: [true, true, 200, 200, 200],
      outsiderEditor: [false, false, 403, 403, 403],
      loner: [false, false, 403, 403, 403],
    };

    // A delete that succeeds removes the key, so each principal gets a world
    // of its own.
    const actual: Record<string, TeamKeyStatuses> = {};
    for (const who of Object.keys(expected) as PrincipalName[]) {
      const world = await seedKeyWorld(fixtures);
      const app = await keyRoutes(world.organizationId);
      const headers = { [USER_HEADER]: world.principals[who].id };
      const teamKeyUrl = `/api/llm-provider-api-keys/${world.keys.team.id}`;
      const list = await app.inject({
        method: "GET",
        url: "/api/llm-provider-api-keys",
        headers,
      });
      const available = await app.inject({
        method: "GET",
        url: "/api/llm-provider-api-keys/available",
        headers,
      });
      const edit = await app.inject({
        method: "PATCH",
        url: teamKeyUrl,
        headers,
        payload: { name: "Renamed" },
      });
      const share = await saveUnchanged({
        app,
        headers,
        organizationId: world.organizationId,
        keyId: world.keys.team.id,
      });
      const remove = await app.inject({
        method: "DELETE",
        url: teamKeyUrl,
        headers,
      });
      actual[who] = [
        containsKey(list.json(), world.keys.team.id),
        containsKey(available.json(), world.keys.team.id),
        edit.statusCode,
        remove.statusCode,
        share,
      ];
      await app.close();
    }
    expect(actual).toEqual(expected);
  });

  test("default key resolution ranks own, then team, then organization keys", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
    removeObjectPolicies,
  }) => {
    const world = await seedKeyWorld({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeTeamMember,
      makeAgent,
      makeSecret,
      makeLlmProviderApiKey,
      removeObjectPolicies,
    });
    const expected: Record<PrincipalName, KeyName> = {
      // The admin reaches the team key through its `*` grant, but is not in
      // the team, so the primary organization key still wins.
      admin: "organization",
      author: "organization",
      teammate: "teammateOwn",
      teamEditor: "team",
      outsiderEditor: "organization",
      loner: "organization",
    };

    const names = new Map(
      Object.entries(world.keys).map(([name, key]) => [key.id, name]),
    );
    const actual: Record<string, string | undefined> = {};
    for (const [who, user] of Object.entries(world.principals)) {
      const resolved = await LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId: world.organizationId,
        userId: user.id,
        userTeamIds: await TeamModel.getUserTeamIds(user.id),
        provider: "anthropic",
        conversationId: null,
      });
      actual[who] = resolved ? names.get(resolved.id) : undefined;
    }
    expect(actual).toEqual(expected);
  });

  test("an agent's pinned key is used whoever chats, whatever the key's own grants", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
    removeObjectPolicies,
  }) => {
    const world = await seedKeyWorld({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeTeamMember,
      makeAgent,
      makeSecret,
      makeLlmProviderApiKey,
      removeObjectPolicies,
    });
    // The organization key loses every grant after it is pinned.
    const organizationPolicy = await ResourcePermissionPolicyModel.find({
      organizationId: world.organizationId,
      resource: "llmProviderApiKey",
      scope: world.keys.organization.id,
    });
    await ResourcePermissionPolicyModel.replace({
      organizationId: world.organizationId,
      resource: "llmProviderApiKey",
      scope: world.keys.organization.id,
      revision: organizationPolicy?.revision ?? 0,
      grants: [],
    });

    // The key each pin resolves to when the loner, who holds no grant on
    // any of them, chats with the agent.
    const expected: Record<string, KeyName> = {
      // Another person's own key.
      teammateOwn: "teammateOwn",
      // A key whose owner is gone, with a policy that grants nobody.
      ownerless: "ownerless",
      // A key whose grants were revoked after it was pinned.
      organization: "organization",
      // A key shared with a team the caller is not in.
      team: "team",
    };

    const names = new Map(
      Object.entries(world.keys).map(([name, key]) => [key.id, name]),
    );
    const actual: Record<string, string | undefined> = {};
    for (const pinned of Object.keys(expected) as KeyName[]) {
      const resolved = await LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId: world.organizationId,
        userId: world.principals.loner.id,
        userTeamIds: [],
        provider: "anthropic",
        conversationId: null,
        agentLlmApiKeyId: world.keys[pinned].id,
      });
      actual[pinned] = resolved ? names.get(resolved.id) : undefined;
    }
    expect(actual).toEqual(expected);
  });

  test("whoever can edit an agent can pin any key of the organization to it", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
    removeObjectPolicies,
  }) => {
    const world = await seedKeyWorld({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeTeamMember,
      makeAgent,
      makeSecret,
      makeLlmProviderApiKey,
      removeObjectPolicies,
    });
    const model = await ModelModel.create({
      externalId: "anthropic/pinned-key-test",
      provider: "anthropic",
      modelId: "pinned-key-test",
      inputModalities: null,
      outputModalities: null,
    });
    const app = await keyRoutes(world.organizationId);

    // The loner's own agent. Main did not check the key for an agent without
    // a runtime either: the pin takes any key id of the organization.
    const expected: Record<string, number> = {
      teammateOwn: 200,
      ownerless: 200,
      team: 200,
      organization: 200,
    };
    const actual: Record<string, number> = {};
    for (const pinned of Object.keys(expected) as KeyName[]) {
      const response = await app.inject({
        method: "PUT",
        url: `/api/agents/${world.lonerAgentId}`,
        headers: { [USER_HEADER]: world.principals.loner.id },
        payload: { llmApiKeyId: world.keys[pinned].id, modelId: model.id },
      });
      actual[pinned] = response.statusCode;
    }
    await app.close();
    expect(actual).toEqual(expected);
  });
});

// ===

type World = Awaited<ReturnType<typeof seedKeyWorld>>;
type PrincipalName = keyof World["principals"];
type KeyName = keyof World["keys"];
type TeamKeyStatuses = [
  listed: boolean,
  offeredForChat: boolean,
  edit: number,
  remove: number,
  savePermissions: number,
];

/**
 * The organization as it stood before the upgrade: a key shared with a team
 * through the retired team column, a primary organization key, a teammate's
 * own key, and a personal key whose owner is gone. No key has a policy until
 * the cutover runs.
 */
async function seedKeyWorld(fx: Fixtures) {
  const org = await fx.makeOrganization({ legacyPermissions: true });
  const principals = {
    admin: await fx.makeUser(),
    author: await fx.makeUser(),
    teammate: await fx.makeUser(),
    teamEditor: await fx.makeUser(),
    outsiderEditor: await fx.makeUser(),
    loner: await fx.makeUser(),
  };
  await fx.makeMember(principals.admin.id, org.id, { role: "admin" });
  for (const user of [
    principals.author,
    principals.teammate,
    principals.loner,
  ]) {
    await fx.makeMember(user.id, org.id);
  }
  for (const user of [principals.teamEditor, principals.outsiderEditor]) {
    await fx.makeMember(user.id, org.id, { role: "editor" });
  }
  // The admin creates both teams, so the author belongs to neither.
  const team = await fx.makeTeam(org.id, principals.admin.id);
  const otherTeam = await fx.makeTeam(org.id, principals.admin.id);
  await fx.makeTeamMember(team.id, principals.teammate.id);
  await fx.makeTeamMember(team.id, principals.teamEditor.id);
  await fx.makeTeamMember(otherTeam.id, principals.outsiderEditor.id);

  const secret = await fx.makeSecret();
  const teamKey = await fx.makeLlmProviderApiKey(org.id, secret.id, {
    isPrimary: false,
  });
  // The retired team column: create no longer writes it.
  await db
    .update(schema.llmProviderApiKeysTable)
    .set({ scope: "team", teamId: team.id })
    .where(eq(schema.llmProviderApiKeysTable.id, teamKey.id));
  const organizationKey = await fx.makeLlmProviderApiKey(org.id, secret.id, {
    isPrimary: true,
  });
  const teammateOwnKey = await fx.makeLlmProviderApiKey(org.id, secret.id, {
    userId: principals.teammate.id,
    isPrimary: true,
  });
  // A personal key whose owner is gone. Deleting the owner deletes the key,
  // so the seed empties the owner column instead.
  const ownerlessKey = await fx.makeLlmProviderApiKey(org.id, secret.id, {
    userId: principals.author.id,
    isPrimary: false,
  });
  await db
    .update(schema.llmProviderApiKeysTable)
    .set({ userId: null, scope: "personal" })
    .where(eq(schema.llmProviderApiKeysTable.id, ownerlessKey.id));
  const lonerAgent = await fx.makeAgent({
    organizationId: org.id,
    agentType: "agent",
    authorId: principals.loner.id,
    access: "personal",
    legacy: { scope: "personal" },
  });
  await fx.removeObjectPolicies(org.id);

  await runScopedResourcePermissionCutover();

  return {
    organizationId: org.id,
    principals,
    lonerAgentId: lonerAgent.id,
    keys: {
      team: teamKey,
      organization: organizationKey,
      teammateOwn: teammateOwnKey,
      ownerless: ownerlessKey,
    },
  };
}

function keyRoutes(organizationId: string) {
  return authenticatedRouteApp({
    organizationId,
    routes: [agentRoutes, llmProviderApiKeyRoutes, resourcePermissionRoutes],
  });
}

function containsKey(body: unknown, keyId: string) {
  return Array.isArray(body) && body.some((key) => key?.id === keyId);
}

/** Save the key's permissions unchanged. It still needs `manage-permissions`. */
async function saveUnchanged(params: {
  app: Awaited<ReturnType<typeof keyRoutes>>;
  headers: Record<string, string>;
  organizationId: string;
  keyId: string;
}) {
  const policy = await ResourcePermissionPolicyModel.find({
    organizationId: params.organizationId,
    resource: "llmProviderApiKey",
    scope: params.keyId,
  });
  const response = await params.app.inject({
    method: "PUT",
    url: `/api/resource-permissions/llmProviderApiKey/${params.keyId}`,
    headers: params.headers,
    payload: { revision: policy?.revision ?? 0, grants: policy?.grants ?? [] },
  });
  return response.statusCode;
}
