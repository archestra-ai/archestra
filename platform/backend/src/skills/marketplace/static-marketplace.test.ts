import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  ManagedOauthClientModel,
  MemberModel,
  OAuthAccessTokenModel,
  OAuthClientModel,
  OrganizationModel,
  SkillMarketplaceCredentialModel,
  SkillModel,
  UserTokenModel,
  VirtualApiKeyModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { accessGrants, describe, expect, type TestAccess, test } from "@/test";
import {
  loadMarketplaceSkills,
  resolveMarketplaceViewer,
} from "./static-marketplace";

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

async function seedSkill(params: {
  organizationId: string;
  name: string;
  access?: TestAccess;
  authorId?: string | null;
}) {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId: params.organizationId,
      authorId: params.authorId ?? null,
      name: params.name,
      description: `${params.name} description`,
      content: `# ${params.name}`,
      metadata: {},
      sourceType: "manual",
    },
    files: [],
    ...accessGrants(params.access),
  });
  if (!skill) throw new Error("failed to seed skill");
  return skill;
}

describe("resolveMarketplaceViewer", () => {
  test("no credential challenges when anonymous access is off", async ({
    makeOrganization,
  }) => {
    await makeOrganization();
    await expect(
      resolveMarketplaceViewer({ authorization: undefined }),
    ).resolves.toEqual({ status: "unauthenticated" });
  });

  test("no credential resolves the anonymous view when the org publishes it", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization({
      skillMarketplaceAnonymousAccess: true,
    });

    await expect(
      resolveMarketplaceViewer({ authorization: undefined }),
    ).resolves.toEqual({
      status: "ok",
      viewer: { organizationId: org.id, userId: null, isSkillAdmin: false },
    });
  });

  test("the anonymous view resolves the organization that published it, not just any", async ({
    makeOrganization,
  }) => {
    // an organization that did not opt in must never be served anonymously,
    // even when it is the one a bare "first organization" lookup would find
    await makeOrganization({ skillMarketplaceAnonymousAccess: false });
    const publisher = await makeOrganization({
      skillMarketplaceAnonymousAccess: true,
    });

    await expect(
      resolveMarketplaceViewer({ authorization: undefined }),
    ).resolves.toEqual({
      status: "ok",
      viewer: {
        organizationId: publisher.id,
        userId: null,
        isSkillAdmin: false,
      },
    });
  });

  test("a bad credential is rejected rather than downgraded to the anonymous view", async ({
    makeOrganization,
  }) => {
    await makeOrganization({ skillMarketplaceAnonymousAccess: true });

    await expect(
      resolveMarketplaceViewer({ authorization: basic("x", "arch_nope") }),
    ).resolves.toEqual({ status: "unauthenticated" });
  });

  test("accepts a personal token as the Basic password, as the Basic username, and as a Bearer", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const { value: token } = await UserTokenModel.create(user.id, org.id);

    const expected = {
      status: "ok",
      viewer: { organizationId: org.id, userId: user.id, isSkillAdmin: false },
    };

    await expect(
      resolveMarketplaceViewer({ authorization: basic("archestra", token) }),
    ).resolves.toEqual(expected);
    // `git clone https://<token>@host/...` sends the token as the username
    await expect(
      resolveMarketplaceViewer({ authorization: basic(token, "") }),
    ).resolves.toEqual(expected);
    await expect(
      resolveMarketplaceViewer({ authorization: `Bearer ${token}` }),
    ).resolves.toEqual(expected);
  });

  test("a role without skill:read is forbidden, not challenged", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { agent: ["read"] },
    });
    await makeMember(user.id, org.id, { role: role.role });
    const { value: token } = await UserTokenModel.create(user.id, org.id);

    await expect(
      resolveMarketplaceViewer({ authorization: basic("archestra", token) }),
    ).resolves.toEqual({ status: "forbidden" });
  });
});

describe("loadMarketplaceSkills", () => {
  test("a member gets org skills and their own, but not another user's personal skill", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const other = await makeUser({ email: "other@test.com" });
    await makeMember(other.id, org.id);

    await seedSkill({
      organizationId: org.id,
      name: "org-wide",
      access: "org",
    });
    await seedSkill({
      organizationId: org.id,
      name: "mine",
      authorId: user.id,
    });
    await seedSkill({
      organizationId: org.id,
      name: "theirs",
      authorId: other.id,
    });

    const skills = await loadMarketplaceSkills({
      organizationId: org.id,
      userId: user.id,
      isSkillAdmin: false,
    });

    expect(skills.map((s) => s.name).sort()).toEqual(["mine", "org-wide"]);
  });

  test("the anonymous view carries org-scoped skills only", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    await seedSkill({
      organizationId: org.id,
      name: "org-wide",
      access: "org",
    });
    await seedSkill({
      organizationId: org.id,
      name: "mine",
      authorId: user.id,
    });

    const skills = await loadMarketplaceSkills({
      organizationId: org.id,
      userId: null,
      isSkillAdmin: false,
    });

    expect(skills.map((s) => s.name)).toEqual(["org-wide"]);
  });

  test("a skill admin gets every skill in the organization", async ({
    makeOrganization,
    makeAdmin,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const admin = await makeAdmin();
    await makeMember(admin.id, org.id, { role: "admin" });
    const other = await makeUser({ email: "other@test.com" });
    await makeMember(other.id, org.id);

    await seedSkill({
      organizationId: org.id,
      name: "org-wide",
      access: "org",
    });
    await seedSkill({
      organizationId: org.id,
      name: "theirs",
      authorId: other.id,
    });

    const skills = await loadMarketplaceSkills({
      organizationId: org.id,
      userId: admin.id,
      isSkillAdmin: true,
    });

    expect(skills.map((s) => s.name).sort()).toEqual(["org-wide", "theirs"]);
  });

  test("read grants, not the admin flag, decide which private skills show", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    await seedSkill({ organizationId: org.id, name: "shared", access: "org" });
    await seedSkill({ organizationId: org.id, name: "private" });
    const load = () =>
      loadMarketplaceSkills({
        organizationId: org.id,
        userId: user.id,
        isSkillAdmin: true,
      });

    // The flag alone opens nothing: without a grant the private skill stays
    // hidden.
    expect((await load()).map((skill) => skill.name)).toEqual(["shared"]);

    // An update grant at `*` is stored as the Edit preset, which carries read,
    // so every skill now shows.
    const policy = await ResourcePermissionPolicyModel.find({
      organizationId: org.id,
      resource: "skill",
      scope: "*",
    });
    if (!policy) throw new Error("Missing permission policy fixture");
    await ResourcePermissionPolicyModel.replace({
      organizationId: org.id,
      resource: "skill",
      scope: "*",
      revision: policy.revision,
      grants: [
        ...policy.grants,
        { subject: { type: "user", id: user.id }, actions: ["update"] },
      ],
    });
    expect((await load()).map((skill) => skill.name).sort()).toEqual([
      "private",
      "shared",
    ]);
  });

  test("soft-deleted skills drop out of the marketplace", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    const kept = await seedSkill({
      organizationId: org.id,
      name: "kept",
      access: "org",
    });
    const removed = await seedSkill({
      organizationId: org.id,
      name: "removed",
      access: "org",
    });
    await SkillModel.delete(removed.id);

    const skills = await loadMarketplaceSkills({
      organizationId: org.id,
      userId: user.id,
      isSkillAdmin: false,
    });

    expect(skills.map((s) => s.id)).toEqual([kept.id]);
  });

  test("organization scoping keeps another org's skills out", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    await seedSkill({ organizationId: org.id, name: "ours", access: "org" });
    await seedSkill({
      organizationId: otherOrg.id,
      name: "theirs",
      access: "org",
    });

    const skills = await loadMarketplaceSkills({
      organizationId: org.id,
      userId: user.id,
      isSkillAdmin: false,
    });

    expect(skills.map((s) => s.name)).toEqual(["ours"]);
    // sanity: the org row the anonymous view would resolve is a real lookup,
    // not an assumption baked into this test
    expect(await OrganizationModel.getFirst()).not.toBeNull();
  });
});

describe("marketplace credentials", () => {
  test("a marketplace credential resolves its owner's view", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    await seedSkill({
      organizationId: org.id,
      name: "Org Wide",
      access: "org",
    });

    const { rawToken } = await SkillMarketplaceCredentialModel.create({
      organizationId: org.id,
      userId: user.id,
    });

    const resolved = await resolveMarketplaceViewer({
      authorization: basic("token", rawToken),
    });
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;
    expect(resolved.viewer.userId).toBe(user.id);
    expect(resolved.viewer.organizationId).toBe(org.id);

    const skills = await loadMarketplaceSkills(resolved.viewer);
    expect(skills.map((s) => s.name)).toEqual(["Org Wide"]);
  });

  test("a credential grants nothing beyond its owner: another user's personal skill stays out", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const other = await makeUser({ email: "other@test.com" });
    await makeMember(user.id, org.id);
    await makeMember(other.id, org.id);
    await seedSkill({
      organizationId: org.id,
      name: "Org Wide",
      access: "org",
    });
    await seedSkill({
      organizationId: org.id,
      name: "Someone Elses",
      authorId: other.id,
    });

    const { rawToken } = await SkillMarketplaceCredentialModel.create({
      organizationId: org.id,
      userId: user.id,
    });
    const resolved = await resolveMarketplaceViewer({
      authorization: basic("token", rawToken),
    });
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;

    const skills = await loadMarketplaceSkills(resolved.viewer);
    expect(skills.map((s) => s.name)).toEqual(["Org Wide"]);
  });

  test("a deleted credential stops working, and does not fall back to anonymous", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    await seedSkill({
      organizationId: org.id,
      name: "Org Wide",
      access: "org",
    });

    const { rawToken } = await SkillMarketplaceCredentialModel.create({
      organizationId: org.id,
      userId: user.id,
    });
    // what losing a membership does
    await SkillMarketplaceCredentialModel.deleteForMember({
      organizationId: org.id,
      userId: user.id,
    });

    await expect(
      resolveMarketplaceViewer({ authorization: basic("token", rawToken) }),
    ).resolves.toEqual({ status: "unauthenticated" });
  });
});

describe("OAuth marketplace credentials", () => {
  const resolve = (token: string) =>
    resolveMarketplaceViewer({ authorization: `Bearer ${token}` });

  test("browser OAuth uses current client, token and membership state", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeOAuthClient,
    makeOAuthAccessToken,
    makeOAuthRefreshToken,
  }) => {
    const org = await makeOrganization({
      skillMarketplaceAnonymousAccess: true,
    });
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const client = await makeOAuthClient({ scopes: ["mcp", "offline_access"] });
    const value = crypto.randomUUID();
    const tokenHash = OAuthAccessTokenModel.hashTokenForLookup(value);
    const refresh = await makeOAuthRefreshToken(client.clientId, user.id);
    const token = await makeOAuthAccessToken(client.clientId, user.id, {
      token: tokenHash,
      refreshId: refresh.id,
    });
    const denied = { status: "unauthenticated" };
    const allowed = {
      status: "ok",
      viewer: { userId: user.id, organizationId: org.id },
    };
    expect(await resolve(value)).toMatchObject(allowed);
    for (const authorization of [
      `Basic ${Buffer.from(`user:${value}`).toString("base64")}`,
      `Basic ${Buffer.from(`${value}:`).toString("base64")}`,
    ])
      expect(await resolveMarketplaceViewer({ authorization })).toMatchObject(
        allowed,
      );

    // Token scope cannot be supplied by the client's wider capabilities.
    await db
      .update(schema.oauthAccessTokensTable)
      .set({ scopes: ["llm:proxy"] })
      .where(eq(schema.oauthAccessTokensTable.id, token.id));
    expect(await resolve(value)).toEqual(denied);
    await db
      .update(schema.oauthAccessTokensTable)
      .set({ scopes: ["mcp"] })
      .where(eq(schema.oauthAccessTokensTable.id, token.id));
    for (const referenceId of [
      "mcp-resource:gateway",
      "mcp-app-resource:connector",
      "mcp-oauth-client:service",
      "oauth-client:service",
      "unknown-binding",
    ]) {
      await db
        .update(schema.oauthAccessTokensTable)
        .set({ referenceId })
        .where(eq(schema.oauthAccessTokensTable.id, token.id));
      expect(await resolve(value)).toEqual(denied);
    }
    await db
      .update(schema.oauthAccessTokensTable)
      .set({ referenceId: null })
      .where(eq(schema.oauthAccessTokensTable.id, token.id));
    await OAuthAccessTokenModel.updateExpiresAtByTokenHash({
      tokenHash,
      expiresAt: new Date(0),
    });
    expect(await resolve(value)).toEqual(denied);
    await OAuthAccessTokenModel.updateExpiresAtByTokenHash({
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await db
      .update(schema.oauthRefreshTokensTable)
      .set({ revoked: new Date() })
      .where(eq(schema.oauthRefreshTokensTable.id, refresh.id));
    expect(await resolve(value)).toEqual(denied);
    await db
      .update(schema.oauthRefreshTokensTable)
      .set({ revoked: null })
      .where(eq(schema.oauthRefreshTokensTable.id, refresh.id));
    for (const fields of [
      { disabled: true },
      { scopes: ["llm:proxy"] },
      { grantTypes: ["client_credentials"] },
    ]) {
      await db
        .update(schema.oauthClientsTable)
        .set(fields)
        .where(eq(schema.oauthClientsTable.id, client.id));
      expect(await resolve(value)).toEqual(denied);
      await db
        .update(schema.oauthClientsTable)
        .set({
          disabled: false,
          scopes: ["mcp"],
          grantTypes: ["authorization_code", "refresh_token"],
        })
        .where(eq(schema.oauthClientsTable.id, client.id));
    }
    expect(await resolve(value)).toMatchObject(allowed);
    await MemberModel.deleteAllByUserId(user.id);
    expect(await resolve(value)).toEqual(denied);
  });

  test("internal issuers, client credentials and virtual keys cannot become marketplace users", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeOAuthClient,
    makeOAuthAccessToken,
  }) => {
    const org = await makeOrganization({
      skillMarketplaceAnonymousAccess: true,
    });
    const user = await makeUser();
    await makeMember(user.id, org.id);
    for (const clientId of [
      "archestra-agent-runtime",
      "archestra-github-actions",
      "archestra-enterprise-managed",
    ]) {
      await OAuthClientModel.ensurePlatformIssuedClient({
        id: clientId,
        clientId,
        name: "Internal issuer",
      });
      const value = crypto.randomUUID();
      await makeOAuthAccessToken(clientId, user.id, {
        token: OAuthAccessTokenModel.hashTokenForLookup(value),
      });
      expect(await resolve(value)).toEqual({ status: "unauthenticated" });
    }
    const client = await makeOAuthClient({ scopes: ["mcp"] });
    const value = crypto.randomUUID();
    await OAuthAccessTokenModel.createClientCredentialsToken({
      clientId: client.clientId,
      tokenHash: OAuthAccessTokenModel.hashTokenForLookup(value),
      expiresAt: new Date(Date.now() + 60_000),
      scopes: ["mcp"],
    });
    expect(await resolve(value)).toEqual({ status: "unauthenticated" });
    const key = await VirtualApiKeyModel.create({
      organizationId: org.id,
      authorId: user.id,
      name: "Personal LLM key",
    });
    expect(await resolve(key.value)).toEqual({ status: "unauthenticated" });
  });

  test("OAuth cannot bypass marketplace permissions or a managed client's organization", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeOAuthAccessToken,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { agent: ["read"] },
    });
    await makeMember(user.id, org.id, { role: role.role });
    const { oauthClient: client } = await ManagedOauthClientModel.create({
      organizationId: org.id,
      authorId: user.id,
      name: "Browser integration",
      grantType: "authorization_code",
      scopes: ["mcp"],
    });
    const value = crypto.randomUUID();
    await makeOAuthAccessToken(client.clientId, user.id, {
      token: OAuthAccessTokenModel.hashTokenForLookup(value),
    });
    expect(await resolve(value)).toEqual({ status: "forbidden" });
    const other = await makeOrganization();
    await db
      .update(schema.oauthClientsTable)
      .set({
        metadata: {
          ...((await OAuthClientModel.findByClientId(client.clientId))
            ?.metadata as object),
          organizationId: other.id,
        },
      })
      .where(eq(schema.oauthClientsTable.clientId, client.clientId));
    expect(await resolve(value)).toEqual({ status: "unauthenticated" });
  });
});
