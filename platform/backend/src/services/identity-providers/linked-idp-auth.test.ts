import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import {
  completeLinkedIdentityProviderIntent,
  createLinkedIdentityProviderIntent,
} from "./linked-idp-auth";

describe("linked identity provider auth", () => {
  test("links a different-email downstream provider account to the original session user", async ({
    makeAccount,
    makeSession,
    makeUser,
  }) => {
    const originalUser = await makeUser({ email: "primary@example.com" });
    const downstreamUser = await makeUser({
      email: "downstream@example.com",
    });
    const originalSession = await makeSession(originalUser.id);
    const downstreamSession = await makeSession(downstreamUser.id);
    const downstreamAccount = await makeAccount(downstreamUser.id, {
      providerId: "downstream-idp",
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      idToken: "new-id-token",
    });

    const { intentId } = await createLinkedIdentityProviderIntent({
      originalUserId: originalUser.id,
      originalSessionId: originalSession.id,
      providerId: "downstream-idp",
      redirectTo: "/chat/conversation-123",
    });

    const result = await completeLinkedIdentityProviderIntent({
      intentId,
      currentUserId: downstreamUser.id,
      currentSessionId: downstreamSession.id,
    });

    expect(result).toEqual({
      originalSessionToken: originalSession.token,
      redirectTo: "/chat/conversation-123",
    });

    const [linkedAccount] = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.id, downstreamAccount.id));
    expect(linkedAccount?.userId).toBe(originalUser.id);
    expect(linkedAccount?.accessToken).toBe("new-access-token");

    const [deletedDownstreamSession] = await db
      .select()
      .from(schema.sessionsTable)
      .where(eq(schema.sessionsTable.id, downstreamSession.id));
    expect(deletedDownstreamSession).toBeUndefined();

    const [deletedDownstreamUser] = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, downstreamUser.id));
    expect(deletedDownstreamUser).toBeUndefined();

    const [preservedOriginalSession] = await db
      .select()
      .from(schema.sessionsTable)
      .where(eq(schema.sessionsTable.id, originalSession.id));
    expect(preservedOriginalSession?.token).toBe(originalSession.token);
  });

  test("replaces a stale downstream account on the original user with the new SSO account", async ({
    makeAccount,
    makeSession,
    makeUser,
  }) => {
    const originalUser = await makeUser({ email: "primary@example.com" });
    const downstreamUser = await makeUser({
      email: "downstream@example.com",
    });
    const originalSession = await makeSession(originalUser.id);
    const downstreamSession = await makeSession(downstreamUser.id);
    const staleAccount = await makeAccount(originalUser.id, {
      providerId: "downstream-idp",
      accessToken: "stale-access-token",
    });
    const newAccount = await makeAccount(downstreamUser.id, {
      providerId: "downstream-idp",
      accessToken: "fresh-access-token",
    });

    const { intentId } = await createLinkedIdentityProviderIntent({
      originalUserId: originalUser.id,
      originalSessionId: originalSession.id,
      providerId: "downstream-idp",
      redirectTo: "/chat",
    });

    await completeLinkedIdentityProviderIntent({
      intentId,
      currentUserId: downstreamUser.id,
      currentSessionId: downstreamSession.id,
    });

    const accounts = await db
      .select()
      .from(schema.accountsTable)
      .where(
        and(
          eq(schema.accountsTable.userId, originalUser.id),
          eq(schema.accountsTable.providerId, "downstream-idp"),
        ),
      );

    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.id).toBe(newAccount.id);
    expect(accounts[0]?.accessToken).toBe("fresh-access-token");

    const [deletedStaleAccount] = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.id, staleAccount.id));
    expect(deletedStaleAccount).toBeUndefined();
  });

  test("keeps the current session when the provider account is already on the original user", async ({
    makeAccount,
    makeSession,
    makeUser,
  }) => {
    const user = await makeUser({ email: "same@example.com" });
    const session = await makeSession(user.id);
    const account = await makeAccount(user.id, {
      providerId: "downstream-idp",
    });
    const { intentId } = await createLinkedIdentityProviderIntent({
      originalUserId: user.id,
      originalSessionId: session.id,
      providerId: "downstream-idp",
      redirectTo: "/chat",
    });

    const result = await completeLinkedIdentityProviderIntent({
      intentId,
      currentUserId: user.id,
      currentSessionId: session.id,
    });

    expect(result.originalSessionToken).toBe(session.token);

    const [preservedAccount] = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.id, account.id));
    expect(preservedAccount?.userId).toBe(user.id);

    const [preservedSession] = await db
      .select()
      .from(schema.sessionsTable)
      .where(eq(schema.sessionsTable.id, session.id));
    expect(preservedSession?.id).toBe(session.id);
  });

  test("rejects completion when the downstream provider account was not created", async ({
    makeSession,
    makeUser,
  }) => {
    const originalUser = await makeUser({ email: "primary@example.com" });
    const downstreamUser = await makeUser({
      email: "downstream@example.com",
    });
    const originalSession = await makeSession(originalUser.id);
    const downstreamSession = await makeSession(downstreamUser.id);
    const { intentId } = await createLinkedIdentityProviderIntent({
      originalUserId: originalUser.id,
      originalSessionId: originalSession.id,
      providerId: "downstream-idp",
      redirectTo: "/chat",
    });

    await expect(
      completeLinkedIdentityProviderIntent({
        intentId,
        currentUserId: downstreamUser.id,
        currentSessionId: downstreamSession.id,
      }),
    ).rejects.toThrow("Linked identity provider account not found");
  });

  test("rejects completion when the original session expired", async ({
    makeAccount,
    makeSession,
    makeUser,
  }) => {
    const originalUser = await makeUser({ email: "primary@example.com" });
    const downstreamUser = await makeUser({
      email: "downstream@example.com",
    });
    const originalSession = await makeSession(originalUser.id, {
      expiresAt: new Date(Date.now() - 1000),
    });
    const downstreamSession = await makeSession(downstreamUser.id);
    await makeAccount(downstreamUser.id, {
      providerId: "downstream-idp",
    });
    const { intentId } = await createLinkedIdentityProviderIntent({
      originalUserId: originalUser.id,
      originalSessionId: originalSession.id,
      providerId: "downstream-idp",
      redirectTo: "/chat",
    });

    await expect(
      completeLinkedIdentityProviderIntent({
        intentId,
        currentUserId: downstreamUser.id,
        currentSessionId: downstreamSession.id,
      }),
    ).rejects.toThrow("Original session is no longer available");
  });

  test.each([
    ["https://evil.example.com/phish"],
    ["//evil.example.com/phish"],
    ["/\\evil.example.com/phish"],
  ])("normalizes unsafe redirect path %s", async (redirectTo) => {
    const result = await createLinkedIdentityProviderIntent({
      originalUserId: "user-id",
      originalSessionId: "session-id",
      providerId: "downstream-idp",
      redirectTo,
    });

    expect(result.redirectTo).toBe("/chat");
  });
});
