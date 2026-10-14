// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { AUTO_PROVISIONED_INVITATION_STATUS } from "@archestra/shared/consts";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { autoProvisionUser } from "@/agents/chatops/auto-provision";
import config from "@/config";
import db, { schema } from "@/database";
import AccountModel from "@/models/account";
import AgentModel from "@/models/agent";
import AgentWorkspaceModel from "@/models/agent-workspace";
import ChatOpsUserAdmissionModel from "@/models/chatops-user-admission";
import IdentityProviderModel from "@/models/identity-provider.ee";
import UserModel from "@/models/user";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { auth } from "./better-auth";

const ORIGIN = "http://localhost:3000";
const IDP = "https://claim-mapping.example.test";
const EMAIL_A = "original@example.com";
const EMAIL_B = "directory@example.com";
const PROVIDER = "claim-mapping";
const SUBJECT = "stable-directory-subject";

describe("SSO callback after changing the email claim", () => {
  const server = useMswServer();
  let userId: string;
  let organizationId: string;
  let memberId: string;
  let providerId: string;
  let profile: Record<string, unknown>;
  let oidcConfig: NonNullable<
    NonNullable<
      Awaited<ReturnType<typeof IdentityProviderModel.findByProviderId>>
    >["oidcConfig"]
  >;

  beforeEach(
    async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAccount,
      makeIdentityProvider,
    }) => {
      config.enterpriseFeatures.core = true;
      const user = await makeUser({ email: EMAIL_A, emailVerified: true });
      userId = user.id;
      organizationId = (await makeOrganization()).id;
      memberId = (await makeMember(userId, organizationId, { role: "admin" }))
        .id;
      oidcConfig = {
        issuer: IDP,
        discoveryEndpoint: `${IDP}/.well-known/openid-configuration`,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        authorizationEndpoint: `${IDP}/authorize`,
        tokenEndpoint: `${IDP}/token`,
        userInfoEndpoint: `${IDP}/userinfo`,
        jwksEndpoint: `${IDP}/jwks`,
        scopes: ["openid", "email"],
        pkce: false,
        overrideUserInfo: true,
        mapping: { id: "sub", email: "email", name: "name" },
      };
      const provider = await makeIdentityProvider(organizationId, {
        providerId: PROVIDER,
        issuer: IDP,
        oidcConfig,
      });
      providerId = provider.id;
      await makeAccount(userId, { providerId: PROVIDER, accountId: SUBJECT });
      profile = {
        sub: SUBJECT,
        email: EMAIL_A,
        preferred_username: EMAIL_B,
        email_verified: true,
        name: "Directory User",
      };
      server.use(
        http.get(`${IDP}/.well-known/openid-configuration`, () =>
          HttpResponse.json({
            issuer: IDP,
            authorization_endpoint: `${IDP}/authorize`,
            token_endpoint: `${IDP}/token`,
            userinfo_endpoint: `${IDP}/userinfo`,
            jwks_uri: `${IDP}/jwks`,
          }),
        ),
        http.post(`${IDP}/token`, () =>
          HttpResponse.json({
            access_token: "test-access-token",
            token_type: "Bearer",
          }),
        ),
        http.get(`${IDP}/userinfo`, () => HttpResponse.json(profile)),
      );
    },
  );

  async function updateClaim(
    overrides: { overrideUserInfo?: boolean; domain?: string } = {},
  ) {
    const updated = await IdentityProviderModel.update(
      providerId,
      {
        ...(overrides.domain !== undefined ? { domain: overrides.domain } : {}),
        oidcConfig: {
          ...oidcConfig,
          overrideUserInfo: overrides.overrideUserInfo ?? true,
          mapping: { id: "sub", email: "preferred_username", name: "name" },
        },
      },
      organizationId,
    );
    expect(updated?.oidcConfig?.mapping?.email).toBe("preferred_username");
  }

  async function signIn() {
    const start = await auth.handler(
      new Request(`${ORIGIN}/api/auth/sign-in/sso`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          providerId: PROVIDER,
          callbackURL: `${ORIGIN}/chat`,
        }),
      }),
    );
    expect(start.status).toBe(200);
    const { url } = await start.json();
    const state = new URL(url).searchParams.get("state");
    const cookie = cookies(start);
    return auth.handler(
      new Request(
        `${ORIGIN}/api/auth/sso/callback/${PROVIDER}?code=test-code&state=${state}`,
        { headers: { cookie } },
      ),
    );
  }

  async function expectSignedIn(response: Response) {
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/chat`);
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookies(response) }),
    });
    expect(session?.user.id).toBe(userId);
    return session;
  }

  test("updates the same admin on next login, keeps its live session, and is idempotent", async () => {
    const firstLogin = await signIn();
    const oldSession = await expectSignedIn(firstLogin);
    expect(oldSession?.user.email).toBe(EMAIL_A);
    if (!oldSession) throw new Error("Expected an authenticated session");
    const accountsBefore = await AccountModel.getAllByUserId(userId);
    await updateClaim();
    // Saving the mapping is not a user migration or a session revocation.
    expect((await UserModel.getById(userId))?.email).toBe(EMAIL_A);
    expect(
      (
        await auth.api.getSession({
          headers: new Headers({ cookie: cookies(firstLogin) }),
        })
      )?.session.id,
    ).toBe(oldSession?.session.id);
    expect((await expectSignedIn(await signIn()))?.user.email).toBe(EMAIL_B);
    expect((await expectSignedIn(await signIn()))?.user.email).toBe(EMAIL_B);
    expect(
      (await AccountModel.getAllByUserId(userId)).map((row) => row.id),
    ).toEqual(accountsBefore.map((row) => row.id));
    const members = await db.select().from(schema.membersTable);
    expect(members).toEqual([
      expect.objectContaining({ id: memberId, userId, role: "admin" }),
    ]);
    expect(await db.select().from(schema.usersTable)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.sessionsTable)
        .where(eq(schema.sessionsTable.id, oldSession.session.id)),
    ).toHaveLength(1);
  });

  test("reconciles an actual pending Teams user and preserves chats, context ownership, resources, and audit evidence", async ({
    makeConversation,
  }) => {
    await expectSignedIn(await signIn());
    const canonicalGateway = await AgentModel.getPersonalMcpGateway(
      userId,
      organizationId,
    );
    const pending = await autoProvisionUser({
      email: EMAIL_B,
      name: "Teams User",
      provider: "ms-teams",
    });
    const pendingAgentId = await AgentModel.findPersonalChatAgentId({
      userId: pending.userId,
      organizationId,
    });
    expect(pendingAgentId).toBeTruthy();
    if (!pendingAgentId || !pending.invitationId)
      throw new Error("Expected provisioned resources");
    const pendingGateway = await AgentModel.getPersonalMcpGateway(
      pending.userId,
      organizationId,
    );
    if (!pendingGateway) throw new Error("Expected a personal gateway");
    const conversation = await makeConversation(pendingAgentId, {
      userId: pending.userId,
      organizationId,
    });
    const [context] = await db
      .insert(schema.a2aContextsTable)
      .values({ actorKind: "user", actorId: pending.userId })
      .returning();
    const workspace = await AgentWorkspaceModel.create({
      organizationId,
      agentId: pendingAgentId,
      actorKind: "user",
      actorId: pending.userId,
      backend: "kubernetes",
      runtimeScope: "test",
      workloadName: "pending-workspace",
      state: "idle",
      lastTaskId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await updateClaim();
    expect((await expectSignedIn(await signIn()))?.user.email).toBe(EMAIL_B);
    expect(await UserModel.getById(pending.userId)).toBeUndefined();
    expect((await UserModel.findByEmail(EMAIL_B))?.id).toBe(userId);
    expect((await AgentWorkspaceModel.findById(workspace.id))?.actorId).toBe(
      userId,
    );
    expect(await db.select().from(schema.membersTable)).toEqual([
      expect.objectContaining({ id: memberId, userId, role: "admin" }),
    ]);
    expect(
      await db
        .select()
        .from(schema.invitationsTable)
        .where(eq(schema.invitationsTable.id, pending.invitationId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.conversationsTable)
        .where(eq(schema.conversationsTable.id, conversation.id)),
    ).toEqual([expect.objectContaining({ userId, agentId: pendingAgentId })]);
    expect(
      await db
        .select()
        .from(schema.a2aContextsTable)
        .where(eq(schema.a2aContextsTable.id, context.id)),
    ).toEqual([expect.objectContaining({ actorId: userId })]);
    expect(
      await db
        .select()
        .from(schema.agentsTable)
        .where(eq(schema.agentsTable.id, pendingAgentId)),
    ).toEqual([expect.objectContaining({ authorId: userId })]);
    expect(
      (await AgentModel.getPersonalMcpGateway(userId, organizationId))?.id,
    ).toBe(canonicalGateway?.id);
    expect(
      await db
        .select()
        .from(schema.agentsTable)
        .where(eq(schema.agentsTable.id, pendingGateway.id)),
    ).toEqual([
      expect.objectContaining({
        authorId: userId,
        isPersonalGateway: false,
        deletedAt: expect.any(Date),
      }),
    ]);
    const policies = await db
      .select()
      .from(schema.resourcePermissionPoliciesTable);
    expect(
      policies.some((policy) =>
        policy.grants.some(
          (grant) =>
            grant.subject.type === "user" &&
            grant.subject.id === pending.userId,
        ),
      ),
    ).toBe(false);
    const audit = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.action, "member.deleted"));
    expect(audit).toEqual([
      expect.objectContaining({
        actorId: userId,
        before: expect.objectContaining({ userId: pending.userId }),
        after: { reconciledIntoUserId: userId, email: EMAIL_B },
      }),
    ]);
    await expectSignedIn(await signIn());
    expect(await db.select().from(schema.usersTable)).toHaveLength(1);
    expect(await db.select().from(schema.accountsTable)).toHaveLength(1);
  });

  test("waits for admitted Teams work, then re-resolves a stale sender to the canonical identity", async () => {
    const pending = await autoProvisionUser({
      email: EMAIL_B,
      name: "Pending User",
      provider: "ms-teams",
    });
    const admitted = await ChatOpsUserAdmissionModel.acquire(EMAIL_B);
    if (!admitted?.admissionId)
      throw new Error("Expected pending Teams admission");
    await updateClaim();
    const blocked = await signIn();
    expect(blocked.headers.get("location")).toContain(
      "error=SSO_EMAIL_CONFLICT",
    );
    expect(await UserModel.getById(pending.userId)).toBeTruthy();
    // Ordinary approval-only Teams execution has no active A2A task. Its
    // context can be created after the email lookup while admission is held.
    const [context] = await db
      .insert(schema.a2aContextsTable)
      .values({ actorKind: "user", actorId: admitted.user.id })
      .returning();
    await ChatOpsUserAdmissionModel.release(admitted.admissionId);
    await expectSignedIn(await signIn());
    expect(await UserModel.getById(pending.userId)).toBeUndefined();
    expect(
      await db
        .select()
        .from(schema.a2aContextsTable)
        .where(eq(schema.a2aContextsTable.id, context.id)),
    ).toEqual([expect.objectContaining({ actorId: userId })]);
    // The inverse ordering: an earlier sender lookup saw the retired user,
    // but admission re-reads by email before any context or run is written.
    const afterReconciliation =
      await ChatOpsUserAdmissionModel.acquire(EMAIL_B);
    expect(afterReconciliation).toEqual({
      user: expect.objectContaining({ id: userId }),
      admissionId: null,
    });
    expect(
      await db.select().from(schema.chatopsUserAdmissionsTable),
    ).toHaveLength(0);
  });

  test("uses the updated email with the existing password on a linked account", async () => {
    const password = "test-only-password-strong-482!";
    const credential = await AccountModel.createCredentialAccount({
      userId,
      passwordHash: await hashPassword(password),
    });
    await updateClaim();
    await expectSignedIn(await signIn());
    for (const [email, status] of [
      [EMAIL_B, 200],
      [EMAIL_A, 401],
    ] as const) {
      const response = await auth.handler(
        new Request(`${ORIGIN}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({ email, password }),
        }),
      );
      expect(response.status).toBe(status);
      if (status === 200) expect((await response.json()).user.id).toBe(userId);
    }
    expect((await AccountModel.getCredentialAccountByUserId(userId))?.id).toBe(
      credential.id,
    );
    expect(await db.select().from(schema.usersTable)).toHaveLength(1);
  });

  test("leaves the stored profile and pending user unchanged when profile updates are disabled", async () => {
    const pending = await autoProvisionUser({
      email: EMAIL_B,
      name: "Pending User",
      provider: "ms-teams",
    });
    await updateClaim({ overrideUserInfo: false });
    const session = await expectSignedIn(await signIn());
    expect(session?.user.email).toBe(EMAIL_A);
    expect(await UserModel.getById(pending.userId)).toBeTruthy();
    expect(await db.select().from(schema.usersTable)).toHaveLength(2);
  });

  for (const scenario of [
    "signed-up",
    "unmarked",
    "other-organization",
    "live-session",
    "unsupported-resource",
    "active-task",
    "untrusted-email",
    "disallowed-domain",
  ] as const) {
    test(`refuses ${scenario} collisions without removing either user`, async ({
      makeUser,
      makeAccount,
      makeOrganization,
      makeMember,
      makeInvitation,
      makeSession,
      makeAgent,
    }) => {
      const other = await makeUser({ email: EMAIL_B, emailVerified: false });
      const otherOrgId =
        scenario === "other-organization"
          ? (await makeOrganization()).id
          : organizationId;
      await makeMember(other.id, otherOrgId);
      if (scenario !== "unmarked")
        await makeInvitation(otherOrgId, other.id, {
          email: EMAIL_B,
          status: `${AUTO_PROVISIONED_INVITATION_STATUS}:ms-teams`,
        });
      if (scenario === "signed-up")
        await makeAccount(other.id, {
          providerId: "credential",
          accountId: other.id,
        });
      if (scenario === "live-session") await makeSession(other.id);
      if (scenario === "active-task") {
        const [context] = await db
          .insert(schema.a2aContextsTable)
          .values({ actorKind: "user", actorId: other.id })
          .returning();
        await db
          .insert(schema.a2aTasksTable)
          .values({ contextId: context.id, state: "TASK_STATE_WORKING" });
      }
      if (scenario === "unsupported-resource") {
        const agent = await makeAgent({ organizationId });
        await db
          .insert(schema.agentPinsTable)
          .values({ userId: other.id, agentId: agent.id });
      }
      if (scenario === "untrusted-email") {
        profile.email_verified = false;
        await updateClaim({ domain: "" });
      } else if (scenario === "disallowed-domain") {
        await updateClaim({ domain: "different.example.test" });
      } else {
        await updateClaim();
      }
      const response = await signIn();
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        scenario === "disallowed-domain"
          ? "error=SSO_EMAIL_NOT_ALLOWED"
          : "error=SSO_EMAIL_CONFLICT",
      );
      expect((await UserModel.getById(userId))?.email).toBe(EMAIL_A);
      expect((await UserModel.getById(other.id))?.email).toBe(EMAIL_B);
      expect(await db.select().from(schema.membersTable)).toHaveLength(2);
      expect(
        await db
          .select()
          .from(schema.auditLogsTable)
          .where(eq(schema.auditLogsTable.action, "member.deleted")),
      ).toHaveLength(0);
    });
  }
});

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}
