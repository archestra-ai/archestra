import { AUTO_PROVISIONED_INVITATION_STATUS } from "@archestra/shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { UserModel } from "@/models";
import { describe, expect, test, vi } from "@/test";
import { ensureProvisionedUser } from "./auto-provision";

describe("ensureProvisionedUser", () => {
  test("existing user is returned without provisioning or resolving a display name", async ({
    makeUser,
  }) => {
    const email = `existing-${crypto.randomUUID()}@example.com`;
    const existing = await makeUser({ email });
    const resolveDisplayName = vi.fn(async () => "Should Not Be Called");

    const result = await ensureProvisionedUser({
      email,
      resolveDisplayName,
      provider: "slack",
    });

    expect(result).not.toBeNull();
    expect(result?.user.id).toBe(existing.id);
    expect(result?.invitationId).toBeNull();
    expect(resolveDisplayName).not.toHaveBeenCalled();
  });

  test("existing user is matched case-insensitively", async ({ makeUser }) => {
    const email = `mixedcase-${crypto.randomUUID()}@example.com`;
    const existing = await makeUser({ email: email.toLowerCase() });
    const resolveDisplayName = vi.fn(async () => "unused");

    const result = await ensureProvisionedUser({
      email: email.toUpperCase(),
      resolveDisplayName,
      provider: "slack",
    });

    expect(result?.user.id).toBe(existing.id);
    expect(result?.invitationId).toBeNull();
    expect(resolveDisplayName).not.toHaveBeenCalled();
  });

  test("new user is provisioned and the real invitation id is returned", async ({
    makeOrganization,
  }) => {
    await makeOrganization();
    const email = `new-${crypto.randomUUID()}@example.com`;
    const resolveDisplayName = vi.fn(async () => "Fresh User");

    const result = await ensureProvisionedUser({
      email,
      resolveDisplayName,
      provider: "slack",
    });

    expect(result).not.toBeNull();
    expect(resolveDisplayName).toHaveBeenCalledTimes(1);

    const normalizedEmail = email.toLowerCase();
    const persisted = await UserModel.findByEmail(normalizedEmail);
    expect(persisted).toBeTruthy();
    expect(result?.user.id).toBe(persisted?.id);
    expect(result?.user.name).toBe("Fresh User");

    expect(result?.invitationId).toBeTruthy();
    const [invitation] = await db
      .select()
      .from(schema.invitationsTable)
      .where(eq(schema.invitationsTable.id, result?.invitationId ?? ""));
    expect(invitation).toBeTruthy();
    expect(invitation.email).toBe(normalizedEmail);
    expect(invitation.status).toBe(
      `${AUTO_PROVISIONED_INVITATION_STATUS}:slack`,
    );
  });

  test("concurrent race resolves to the existing user with no invitation (suppresses the welcome)", async ({
    makeOrganization,
  }) => {
    await makeOrganization();
    const email = `race-${crypto.randomUUID()}@example.com`;
    const normalizedEmail = email.toLowerCase();

    // Simulate a concurrent arrival: another worker registers the same email in
    // the window between the initial findByEmail miss and autoProvisionUser's
    // insert, tripping the unique-constraint fallback inside autoProvisionUser.
    const racingUserId = crypto.randomUUID();
    const resolveDisplayName = vi.fn(async () => {
      await db.insert(schema.usersTable).values({
        id: racingUserId,
        name: "Racing User",
        email: normalizedEmail,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return "Loser User";
    });

    const result = await ensureProvisionedUser({
      email,
      resolveDisplayName,
      provider: "slack",
    });

    expect(result).not.toBeNull();
    expect(result?.user.id).toBe(racingUserId);
    // The already-existing user must come back with a null invitation so the
    // caller's `invitationId !== null` gate skips the welcome DM (an empty
    // string would pass that gate and send a broken signup link).
    expect(result?.invitationId).toBeNull();
  });
});
