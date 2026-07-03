import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { LLM_OAUTH_CLIENT_METADATA_TYPE } from "@/types/llm-oauth-client";

/**
 * 3-tier visibility scoping (`personal`/`team`/`org` + `oauth_client_team`)
 * RBAC contract for LLM OAuth clients, mirroring agents/skills/catalog. The
 * behavior under test is driven entirely by each actor's real DB role
 * (admin/editor/member) + team membership — no auth mocking.
 */
describe("LLM OAuth clients — team-scope RBAC", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let currentUser: User;
  let proxyId: string;
  let providerApiKeyId: string;

  beforeEach(
    async ({
      makeOrganization,
      makeAgent,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      organizationId = (await makeOrganization()).id;
      proxyId = (await makeAgent({ organizationId, agentType: "llm_proxy" }))
        .id;
      const secret = await makeSecret({
        secret: { apiKey: "sk-svc-anthropic" },
      });
      providerApiKeyId = (
        await makeLlmProviderApiKey(organizationId, secret.id, {
          provider: "anthropic",
        })
      ).id;

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (request as typeof request & { user: User }).user = currentUser;
        (
          request as typeof request & { organizationId: string }
        ).organizationId = organizationId;
      });

      const { default: routes } = await import("./llm-oauth-clients");
      await app.register(routes);
      const { default: providerApiKeyRoutes } = await import(
        "./llm-provider-api-keys"
      );
      await app.register(providerApiKeyRoutes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      name: `client-${crypto.randomUUID().slice(0, 8)}`,
      allowedLlmProxyIds: [proxyId],
      providerApiKeys: [{ provider: "anthropic", providerApiKeyId }],
      ...overrides,
    };
  }

  function post(body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/llm-oauth-clients",
      payload: body,
    });
  }

  function put(id: string, body: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/api/llm-oauth-clients/${id}`,
      payload: body,
    });
  }

  function list() {
    return app.inject({ method: "GET", url: "/api/llm-oauth-clients" });
  }

  function rotate(id: string) {
    return app.inject({
      method: "POST",
      url: `/api/llm-oauth-clients/${id}/rotate-secret`,
    });
  }

  function del(id: string) {
    return app.inject({
      method: "DELETE",
      url: `/api/llm-oauth-clients/${id}`,
    });
  }

  test("create without scope defaults to personal and records the caller as author", async ({
    makeUser,
    makeMember,
  }) => {
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });

    currentUser = editor;
    const res = await post(payload());

    expect(res.statusCode).toBe(200);
    const created = res.json();
    expect(created.scope).toBe("personal");
    expect(created.authorId).toBe(editor.id);
    expect(created.authorName).toBe(editor.name);
    expect(created.teams).toEqual([]);
  });

  test("editor cannot create an org-scoped client", async ({
    makeUser,
    makeMember,
  }) => {
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });

    currentUser = editor;
    const res = await post(payload({ scope: "org" }));

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/only admins/i);
  });

  test("editor creates a team-scoped client with a team they belong to", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const team = await makeTeam(organizationId, editor.id);
    await makeTeamMember(team.id, editor.id);

    currentUser = editor;
    const res = await post(payload({ scope: "team", teams: [team.id] }));

    expect(res.statusCode).toBe(200);
    expect(res.json().scope).toBe("team");
    expect(res.json().teams.map((t: { id: string }) => t.id)).toEqual([
      team.id,
    ]);
  });

  test("editor cannot create a team-scoped client for a team they are not a member of", async ({
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const otherTeam = await makeTeam(organizationId, editor.id); // not a member

    currentUser = editor;
    const res = await post(payload({ scope: "team", teams: [otherTeam.id] }));

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/teams you are a member of/i);
  });

  test("team scope requires at least one team", async ({
    makeUser,
    makeMember,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });

    currentUser = admin;
    const res = await post(payload({ scope: "team", teams: [] }));

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/at least one team/i);
  });

  test("list filtering: admin sees all; editor sees org + own personal + their teams' clients", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const other = await makeUser();
    await makeMember(other.id, organizationId, { role: EDITOR_ROLE_NAME });
    const myTeam = await makeTeam(organizationId, admin.id);
    await makeTeamMember(myTeam.id, editor.id);
    const otherTeam = await makeTeam(organizationId, admin.id);

    currentUser = admin;
    await post(payload({ name: "org-client", scope: "org" }));
    await post(
      payload({
        name: "other-team-client",
        scope: "team",
        teams: [otherTeam.id],
      }),
    );
    currentUser = editor;
    await post(payload({ name: "my-personal" }));
    await post(
      payload({ name: "my-team-client", scope: "team", teams: [myTeam.id] }),
    );
    currentUser = other;
    await post(payload({ name: "other-personal" }));

    currentUser = admin;
    const adminNames = (await list())
      .json()
      .map((c: { name: string }) => c.name);
    expect(adminNames.sort()).toEqual(
      [
        "org-client",
        "other-team-client",
        "my-personal",
        "my-team-client",
        "other-personal",
      ].sort(),
    );

    currentUser = editor;
    const editorNames = (await list())
      .json()
      .map((c: { name: string }) => c.name);
    expect(editorNames.sort()).toEqual(
      ["org-client", "my-personal", "my-team-client"].sort(),
    );
    expect(editorNames).not.toContain("other-personal");
    expect(editorNames).not.toContain("other-team-client");
  });

  test("legacy row without scope/authorId metadata lists as org-scoped and is visible to everyone", async ({
    makeUser,
    makeMember,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: MEMBER_ROLE_NAME });

    // Simulate a row created before team scoping existed: metadata has no
    // scope/authorId (and no grantType/allowedLlmProxyIds/providerApiKeys).
    await db.insert(schema.oauthClientsTable).values({
      id: crypto.randomUUID(),
      clientId: `llm_oauth_legacy_${crypto.randomUUID().slice(0, 8)}`,
      name: "legacy-client",
      redirectUris: [],
      metadata: { type: LLM_OAUTH_CLIENT_METADATA_TYPE, organizationId },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    currentUser = member;
    const res = await list();

    expect(res.statusCode).toBe(200);
    const legacy = res
      .json()
      .find((c: { name: string }) => c.name === "legacy-client");
    expect(legacy).toBeDefined();
    expect(legacy.scope).toBe("org");
    expect(legacy.authorId).toBeNull();
    expect(legacy.teams).toEqual([]);
  });

  test("non-admin cannot escalate a client to org scope", async ({
    makeUser,
    makeMember,
  }) => {
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });

    currentUser = editor;
    const created = (await post(payload())).json();
    const res = await put(created.id, payload({ scope: "org" }));

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/only admins/i);
  });

  test("a team-scoped client cannot be made personal again", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const team = await makeTeam(organizationId, editor.id);
    await makeTeamMember(team.id, editor.id);

    currentUser = editor;
    const created = (
      await post(payload({ scope: "team", teams: [team.id] }))
    ).json();
    const res = await put(created.id, payload({ scope: "personal" }));

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/cannot be made personal/i);
  });

  test("team-admin team edits preserve teams they don't control", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    const teamA = await makeTeam(organizationId, admin.id);
    const teamB = await makeTeam(organizationId, admin.id);
    const teamC = await makeTeam(organizationId, admin.id);
    await makeTeamMember(teamA.id, editor.id); // editor in A (and C below), never B
    await makeTeamMember(teamC.id, editor.id);

    currentUser = admin;
    const created = (
      await post(payload({ scope: "team", teams: [teamA.id, teamB.id] }))
    ).json();

    // Dropping B from the list must not remove it — the editor doesn't control B.
    currentUser = editor;
    const first = await put(
      created.id,
      payload({ scope: "team", teams: [teamA.id] }),
    );
    expect(first.statusCode).toBe(200);
    expect(
      first
        .json()
        .teams.map((t: { id: string }) => t.id)
        .sort(),
    ).toEqual([teamA.id, teamB.id].sort());

    // Adding C (a team they belong to) keeps B too.
    const second = await put(
      created.id,
      payload({ scope: "team", teams: [teamA.id, teamC.id] }),
    );
    expect(second.statusCode).toBe(200);
    expect(
      second
        .json()
        .teams.map((t: { id: string }) => t.id)
        .sort(),
    ).toEqual([teamA.id, teamB.id, teamC.id].sort());
  });

  test("non-admin cannot rotate or delete another user's personal client", async ({
    makeUser,
    makeMember,
  }) => {
    const author = await makeUser();
    await makeMember(author.id, organizationId, { role: EDITOR_ROLE_NAME });
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });

    currentUser = author;
    const created = (await post(payload())).json();

    currentUser = editor;
    expect((await rotate(created.id)).statusCode).toBe(403);
    expect((await del(created.id)).statusCode).toBe(403);
  });

  test("admin can update, rotate, and delete any client and assign arbitrary org teams", async ({
    makeUser,
    makeMember,
    makeTeam,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const author = await makeUser();
    await makeMember(author.id, organizationId, { role: EDITOR_ROLE_NAME });
    // A team the admin is not a member of.
    const team = await makeTeam(organizationId, author.id);

    currentUser = author;
    const created = (await post(payload())).json();

    currentUser = admin;
    const toTeam = await put(
      created.id,
      payload({ scope: "team", teams: [team.id] }),
    );
    expect(toTeam.statusCode).toBe(200);
    expect(toTeam.json().scope).toBe("team");
    expect(toTeam.json().teams.map((t: { id: string }) => t.id)).toEqual([
      team.id,
    ]);

    const toOrg = await put(created.id, payload({ scope: "org" }));
    expect(toOrg.statusCode).toBe(200);
    expect(toOrg.json().scope).toBe("org");

    expect((await rotate(created.id)).statusCode).toBe(200);
    expect((await del(created.id)).statusCode).toBe(200);
  });

  test("provider-API-key delete guard still sees team-scoped clients invisible to the acting admin", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
    // The admin is NOT a member of this team.
    const team = await makeTeam(organizationId, editor.id);
    await makeTeamMember(team.id, editor.id);

    currentUser = editor;
    const created = await post(
      payload({ name: "team-mapped-client", scope: "team", teams: [team.id] }),
    );
    expect(created.statusCode).toBe(200);

    currentUser = admin;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/llm-provider-api-keys/${providerApiKeyId}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(
      /mapped to one or more OAuth clients/i,
    );
  });
});
