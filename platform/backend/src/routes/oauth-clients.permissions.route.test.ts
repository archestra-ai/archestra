// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/**
 * OAuth client registrations are scoped by grants like every other shared
 * object: the creator gets full access, the admin tiers reach every client at
 * `*`, and sharing with a team, a role or the organization is one more grant.
 * Both kinds follow the same rules; each actor's real membership decides.
 */
describe.each([
  {
    kind: "MCP",
    resource: "mcpOauthClient",
    path: "/api/mcp-oauth-clients",
    notFound: "MCP OAuth client not found",
  },
  {
    kind: "LLM",
    resource: "llmOauthClient",
    path: "/api/llm-oauth-clients",
    notFound: "LLM OAuth client not found",
  },
] as const)("$kind OAuth client grants", ({ resource, path, notFound }) => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let currentUser: User;

  beforeEach(async ({ makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    const { default: routes } = await import(
      resource === "mcpOauthClient"
        ? "./mcp-oauth-clients"
        : "./llm-oauth-clients"
    );
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  // authorization_code clients need no gateway or provider-key fixtures, and
  // the permission rules are the same for either grant type.
  const body = (overrides: Record<string, unknown> = {}) => ({
    name: `client-${crypto.randomUUID().slice(0, 8)}`,
    grantType: "authorization_code",
    redirectUris: ["https://app.example.com/callback"],
    ...overrides,
  });
  const create = (overrides: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: path, payload: body(overrides) });
  const listNames = async (): Promise<string[]> => {
    const response = await app.inject({ method: "GET", url: path });
    expect(response.statusCode).toBe(200);
    const json = response.json();
    return (Array.isArray(json) ? json : json.data).map(
      (client: { name: string }) => client.name,
    );
  };
  const update = (id: string) =>
    app.inject({
      method: "PUT",
      url: `${path}/${id}`,
      payload: body({ name: `renamed-${id.slice(0, 8)}` }),
    });
  const rotate = (id: string) =>
    app.inject({ method: "POST", url: `${path}/${id}/rotate-secret` });
  const remove = (id: string) =>
    app.inject({ method: "DELETE", url: `${path}/${id}` });

  async function actor(
    fixtures: {
      makeUser: () => Promise<User>;
      makeMember: (
        userId: string,
        organizationId: string,
        overrides?: { role?: string },
      ) => Promise<unknown>;
    },
    role: string,
  ) {
    const user = await fixtures.makeUser();
    await fixtures.makeMember(user.id, organizationId, { role });
    return user;
  }

  test("the creator gets full access and nobody else is named", async ({
    makeUser,
    makeMember,
  }) => {
    currentUser = await actor({ makeUser, makeMember }, EDITOR_ROLE_NAME);
    const response = await create();

    expect(response.statusCode).toBe(200);
    const created = response.json();
    expect(created.authorId).toBe(currentUser.id);
    // The retired visibility fields are gone from the response too.
    expect(created).not.toHaveProperty("scope");
    expect(created).not.toHaveProperty("teams");
    const policy = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource,
      scope: created.id,
    });
    expect(policy?.grants).toEqual([
      {
        subject: { type: "user", id: currentUser.id },
        actions: ["read", "update", "delete", "manage-permissions"],
      },
    ]);
  });

  test("the retired scope and team fields are refused, not ignored", async ({
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    currentUser = await actor({ makeUser, makeMember }, ADMIN_ROLE_NAME);
    const team = await makeTeam(organizationId, currentUser.id);

    expect((await create({ scope: "org" })).statusCode).toBe(400);
    expect((await create({ teams: [team.id] })).statusCode).toBe(400);

    const created = (await create()).json();
    const legacyUpdate = await app.inject({
      method: "PUT",
      url: `${path}/${created.id}`,
      payload: body({ scope: "team", teams: [team.id] }),
    });
    expect(legacyUpdate.statusCode).toBe(400);
  });

  test("sharing with a team at creation lets its members see the client and nothing more", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const author = await actor({ makeUser, makeMember }, EDITOR_ROLE_NAME);
    const teammate = await actor({ makeUser, makeMember }, MEMBER_ROLE_NAME);
    const outsider = await actor({ makeUser, makeMember }, MEMBER_ROLE_NAME);
    const team = await makeTeam(organizationId, author.id);
    await makeTeamMember(team.id, author.id);
    await makeTeamMember(team.id, teammate.id);

    currentUser = author;
    const response = await create({
      name: "Shared with the team",
      initialGrants: [
        { subject: { type: "team", id: team.id }, actions: ["read"] },
      ],
    });
    expect(response.statusCode).toBe(200);
    const shared = response.json();

    currentUser = teammate;
    expect(await listNames()).toEqual(["Shared with the team"]);
    // Seeing a client is not editing it.
    expect((await update(shared.id)).statusCode).toBe(403);
    expect((await remove(shared.id)).statusCode).toBe(403);

    // A member with no grant cannot tell the client exists.
    currentUser = outsider;
    expect(await listNames()).toEqual([]);
    expect((await update(shared.id)).json().error.message).toBe(notFound);
    expect((await remove(shared.id)).statusCode).toBe(404);
    expect((await rotate(shared.id)).statusCode).toBe(404);
  });

  test("a grant level that is not one of the client's presets is refused", async ({
    makeUser,
    makeMember,
  }) => {
    currentUser = await actor({ makeUser, makeMember }, EDITOR_ROLE_NAME);
    const other = await actor({ makeUser, makeMember }, MEMBER_ROLE_NAME);
    // Nothing is done "with" a registration, so there is no Can use level.
    const response = await create({
      initialGrants: [
        { subject: { type: "user", id: other.id }, actions: ["read", "use"] },
      ],
    });
    expect(response.statusCode).toBe(400);
  });

  test("the level granted decides update, rotate and delete", async ({
    makeUser,
    makeMember,
  }) => {
    const author = await actor({ makeUser, makeMember }, EDITOR_ROLE_NAME);
    const editor = await actor({ makeUser, makeMember }, MEMBER_ROLE_NAME);
    const manager = await actor({ makeUser, makeMember }, MEMBER_ROLE_NAME);

    currentUser = author;
    const created = (
      await create({
        initialGrants: [
          {
            subject: { type: "user", id: editor.id },
            actions: ["read", "update"],
          },
          {
            subject: { type: "user", id: manager.id },
            actions: ["read", "update", "delete", "manage-permissions"],
          },
        ],
      })
    ).json();

    currentUser = editor;
    expect((await update(created.id)).statusCode).toBe(200);
    expect((await rotate(created.id)).statusCode).toBe(200);
    expect((await remove(created.id)).statusCode).toBe(403);

    currentUser = manager;
    expect((await remove(created.id)).statusCode).toBe(200);
    // The policy goes with the client, so a reused id inherits nothing.
    expect(
      await ResourcePermissionPolicyModel.find({
        organizationId,
        resource,
        scope: created.id,
      }),
    ).toBeNull();
  });

  test("the built-in admin reaches every client through its grant at *", async ({
    makeUser,
    makeMember,
  }) => {
    const author = await actor({ makeUser, makeMember }, EDITOR_ROLE_NAME);
    const admin = await actor({ makeUser, makeMember }, ADMIN_ROLE_NAME);

    currentUser = author;
    const created = (await create({ name: "Private client" })).json();

    currentUser = admin;
    expect(await listNames()).toEqual(["Private client"]);
    expect((await update(created.id)).statusCode).toBe(200);
    expect((await rotate(created.id)).statusCode).toBe(200);
    expect((await remove(created.id)).statusCode).toBe(200);
  });

  test("a member without grants sees none of another member's clients", async ({
    makeUser,
    makeMember,
  }) => {
    const author = await actor({ makeUser, makeMember }, EDITOR_ROLE_NAME);
    const member = await actor({ makeUser, makeMember }, MEMBER_ROLE_NAME);

    currentUser = author;
    const created = (await create()).json();

    currentUser = member;
    expect(await listNames()).toEqual([]);
    expect((await update(created.id)).statusCode).toBe(404);
  });
});
