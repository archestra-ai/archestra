import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import db, { schema } from "@/database";
import MemberModel from "@/models/member";
import { describe, expect, test } from "@/test";
import { syncSsoRole } from "./idp.ee";

function encodeIdToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

async function seedSsoAccount(params: {
  userId: string;
  providerId: string;
  idTokenClaims: Record<string, unknown>;
}): Promise<void> {
  await db.insert(schema.accountsTable).values({
    id: crypto.randomUUID(),
    accountId: `account-${params.userId}`,
    providerId: params.providerId,
    userId: params.userId,
    idToken: encodeIdToken(params.idTokenClaims),
    updatedAt: new Date(),
  });
}

describe("syncSsoRole", () => {
  test("leaves an existing admin's role unchanged when role mapping has no matching rules", async ({
    makeIdentityProvider,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: "admin@example.com" });
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });

    const provider = await makeIdentityProvider(org.id, {
      providerId: "sso-no-rules",
      roleMapping: { rules: [], defaultRole: MEMBER_ROLE_NAME },
    });

    await seedSsoAccount({
      userId: user.id,
      providerId: provider.providerId,
      idTokenClaims: { email: user.email },
    });

    await syncSsoRole(user.id, user.email, provider.providerId);

    const member = await MemberModel.getByUserId(user.id, org.id);
    expect(member?.role).toBe(ADMIN_ROLE_NAME);
  });

  test("leaves the existing role unchanged when configured rules do not match the token claims", async ({
    makeIdentityProvider,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: "admin2@example.com" });
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });

    const provider = await makeIdentityProvider(org.id, {
      providerId: "sso-no-match",
      roleMapping: {
        rules: [
          {
            expression: '{{#equals groups "platform-admins"}}true{{/equals}}',
            role: ADMIN_ROLE_NAME,
          },
        ],
        defaultRole: MEMBER_ROLE_NAME,
      },
    });

    await seedSsoAccount({
      userId: user.id,
      providerId: provider.providerId,
      idTokenClaims: { email: user.email, groups: "outsiders" },
    });

    await syncSsoRole(user.id, user.email, provider.providerId);

    const member = await MemberModel.getByUserId(user.id, org.id);
    expect(member?.role).toBe(ADMIN_ROLE_NAME);
  });

  test("applies the resolved role when a mapping rule explicitly matches", async ({
    makeIdentityProvider,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: "downgrade-me@example.com" });
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });

    const provider = await makeIdentityProvider(org.id, {
      providerId: "sso-match",
      roleMapping: {
        rules: [
          {
            expression: '{{#equals groups "members-only"}}true{{/equals}}',
            role: MEMBER_ROLE_NAME,
          },
        ],
      },
    });

    await seedSsoAccount({
      userId: user.id,
      providerId: provider.providerId,
      idTokenClaims: { email: user.email, groups: "members-only" },
    });

    await syncSsoRole(user.id, user.email, provider.providerId);

    const member = await MemberModel.getByUserId(user.id, org.id);
    expect(member?.role).toBe(MEMBER_ROLE_NAME);
  });
});
