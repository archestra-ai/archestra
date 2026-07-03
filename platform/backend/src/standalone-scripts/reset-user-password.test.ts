import { hashPassword, verifyPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { CREDENTIAL_PROVIDER_ID } from "@/constants";
import db, { schema } from "@/database";
import { AccountModel, AuditLogModel, SessionModel } from "@/models";
import { describe, expect, test } from "@/test";
import { resetUserPassword } from "./reset-user-password";

const OLD_PASSWORD = "old-password-123";
const NEW_PASSWORD = "new-password-456";

/** Fetch the credential password hash, asserting it exists. */
async function getCredentialHash(userId: string): Promise<string> {
  const account = await AccountModel.getCredentialAccountByUserId(userId);
  const hash = account?.password;
  expect(hash).toBeTruthy();
  return hash ?? "";
}

describe("resetUserPassword", () => {
  test("resets an org admin's password and revokes their sessions", async ({
    makeAdmin,
    makeOrganization,
    makeMember,
    makeSession,
  }) => {
    const admin = await makeAdmin();
    const org = await makeOrganization();
    await makeMember(admin.id, org.id, { role: "admin" });
    await AccountModel.createCredentialAccount({
      userId: admin.id,
      passwordHash: await hashPassword(OLD_PASSWORD),
    });
    await makeSession(admin.id);
    await makeSession(admin.id);

    const result = await resetUserPassword({
      email: admin.email,
      newPassword: NEW_PASSWORD,
    });

    expect(result).toMatchObject({
      userId: admin.id,
      email: admin.email,
      credentialAccountCreated: false,
      twoFactorCleared: false,
      userIsBanned: false,
    });

    const hash = await getCredentialHash(admin.id);
    await expect(
      verifyPassword({ password: NEW_PASSWORD, hash }),
    ).resolves.toBe(true);
    await expect(
      verifyPassword({ password: OLD_PASSWORD, hash }),
    ).resolves.toBe(false);

    await expect(SessionModel.getByUserId(admin.id)).resolves.toEqual([]);
  });

  test("resets a non-admin member's password (no in-app role gate)", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeSession,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "member" });
    await AccountModel.createCredentialAccount({
      userId: user.id,
      passwordHash: await hashPassword(OLD_PASSWORD),
    });
    await makeSession(user.id);

    const result = await resetUserPassword({
      email: user.email,
      newPassword: NEW_PASSWORD,
    });

    expect(result.userId).toBe(user.id);
    const hash = await getCredentialHash(user.id);
    await expect(
      verifyPassword({ password: NEW_PASSWORD, hash }),
    ).resolves.toBe(true);
    await expect(SessionModel.getByUserId(user.id)).resolves.toEqual([]);

    // The reset is audited under the member's organization.
    const [auditRow] = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, user.id));
    expect(auditRow?.organizationId).toBe(org.id);
  });

  test("creates a credential account for an SSO-only user", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeAccount,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "member" });
    // SSO account only — no credential account.
    await makeAccount(user.id);

    const result = await resetUserPassword({
      email: user.email,
      newPassword: NEW_PASSWORD,
    });

    expect(result.credentialAccountCreated).toBe(true);

    const account = await AccountModel.getCredentialAccountByUserId(user.id);
    expect(account?.providerId).toBe(CREDENTIAL_PROVIDER_ID);
    expect(account?.accountId).toBe(user.id);
    const hash = await getCredentialHash(user.id);
    await expect(
      verifyPassword({ password: NEW_PASSWORD, hash }),
    ).resolves.toBe(true);
  });

  test("resets a user who has no organization membership (no audit row)", async ({
    makeUser,
  }) => {
    const user = await makeUser();

    const result = await resetUserPassword({
      email: user.email,
      newPassword: NEW_PASSWORD,
    });

    expect(result.userId).toBe(user.id);
    const hash = await getCredentialHash(user.id);
    await expect(
      verifyPassword({ password: NEW_PASSWORD, hash }),
    ).resolves.toBe(true);
    const auditRows = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, user.id));
    expect(auditRows).toEqual([]);
  });

  test("matches the email case-insensitively", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser({ email: "locked.out.user@test.com" });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "member" });

    const result = await resetUserPassword({
      email: "  Locked.Out.User@TEST.com ",
      newPassword: NEW_PASSWORD,
    });

    expect(result.userId).toBe(user.id);
  });

  test("writes a user.password_reset audit row for the user's org", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "member" });

    await resetUserPassword({
      email: user.email,
      newPassword: NEW_PASSWORD,
    });

    const [auditRow] = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, user.id));
    expect(auditRow).toMatchObject({
      organizationId: org.id,
      actorType: "system",
      actorName: "reset-user-password CLI",
      action: "user.password_reset",
      outcome: "success",
      resourceType: "user",
      after: {
        email: user.email,
        credentialAccountCreated: true,
        twoFactorCleared: false,
        sessionsRevoked: true,
      },
    });
  });

  test("does not throw when the audit write fails; the password is still reset", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "member" });

    // vi.spyOn keeps this file in the fast "clean" vitest project (only
    // vi.mock/doMock/hoisted move a file to the isolated project). Restore in
    // finally so the shared worker isn't left with a poisoned AuditLogModel.
    const spy = vi
      .spyOn(AuditLogModel, "create")
      .mockRejectedValue(new Error("audit boom"));
    try {
      const result = await resetUserPassword({
        email: user.email,
        newPassword: NEW_PASSWORD,
      });
      expect(result.userId).toBe(user.id);
    } finally {
      spy.mockRestore();
    }

    const hash = await getCredentialHash(user.id);
    await expect(
      verifyPassword({ password: NEW_PASSWORD, hash }),
    ).resolves.toBe(true);
  });

  test("rolls back the password change if a later step fails (atomicity)", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeSession,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "member" });
    await AccountModel.createCredentialAccount({
      userId: user.id,
      passwordHash: await hashPassword(OLD_PASSWORD),
    });
    await makeSession(user.id);

    // Force the final step (session revocation) to blow up mid-transaction.
    // vi.spyOn keeps this file in the fast "clean" vitest project; restore in
    // finally so the shared worker isn't left with a poisoned SessionModel.
    const spy = vi
      .spyOn(SessionModel, "deleteAllByUserId")
      .mockRejectedValue(new Error("session revoke boom"));
    try {
      await expect(
        resetUserPassword({ email: user.email, newPassword: NEW_PASSWORD }),
      ).rejects.toThrow("session revoke boom");
    } finally {
      spy.mockRestore();
    }

    // The whole transaction rolled back: the password is still the old one and
    // the user's session survives.
    const hash = await getCredentialHash(user.id);
    await expect(
      verifyPassword({ password: OLD_PASSWORD, hash }),
    ).resolves.toBe(true);
    await expect(
      verifyPassword({ password: NEW_PASSWORD, hash }),
    ).resolves.toBe(false);
    await expect(SessionModel.getByUserId(user.id)).resolves.toHaveLength(1);
  });

  test("rejects an unknown email", async () => {
    await expect(
      resetUserPassword({
        email: "nobody@test.com",
        newPassword: NEW_PASSWORD,
      }),
    ).rejects.toThrow('No user found with email "nobody@test.com"');
  });

  test("rejects passwords outside Better Auth's length bounds", async () => {
    await expect(
      resetUserPassword({ email: "whoever@test.com", newPassword: "short" }),
    ).rejects.toThrow("between 8 and 128 characters");
    await expect(
      resetUserPassword({
        email: "whoever@test.com",
        newPassword: "x".repeat(129),
      }),
    ).rejects.toThrow("between 8 and 128 characters");
  });

  test("keeps two-factor enrollment unless --disable-two-factor is passed", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser({ twoFactorEnabled: true });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "member" });
    await db.insert(schema.twoFactorsTable).values({
      id: crypto.randomUUID(),
      secret: "totp-secret",
      backupCodes: "backup-codes",
      userId: user.id,
    });

    const result = await resetUserPassword({
      email: user.email,
      newPassword: NEW_PASSWORD,
    });

    expect(result.twoFactorCleared).toBe(false);
    const [updated] = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, user.id));
    expect(updated?.twoFactorEnabled).toBe(true);
    const enrollments = await db
      .select()
      .from(schema.twoFactorsTable)
      .where(eq(schema.twoFactorsTable.userId, user.id));
    expect(enrollments).toHaveLength(1);
  });

  test("clears two-factor enrollment with disableTwoFactor", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser({ twoFactorEnabled: true });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "member" });
    await db.insert(schema.twoFactorsTable).values({
      id: crypto.randomUUID(),
      secret: "totp-secret",
      backupCodes: "backup-codes",
      userId: user.id,
    });

    const result = await resetUserPassword({
      email: user.email,
      newPassword: NEW_PASSWORD,
      disableTwoFactor: true,
    });

    expect(result.twoFactorCleared).toBe(true);
    const [updated] = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, user.id));
    expect(updated?.twoFactorEnabled).toBe(false);
    const enrollments = await db
      .select()
      .from(schema.twoFactorsTable)
      .where(eq(schema.twoFactorsTable.userId, user.id));
    expect(enrollments).toHaveLength(0);
  });
});
