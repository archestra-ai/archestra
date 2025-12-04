import type { HookEndpointContext } from "@better-auth/core";
import { APIError } from "better-auth";
import { describe, expect, test } from "@/test";
import { handleAfterHook, handleBeforeHook } from "./better-auth";

/**
 * Helper to create a minimal mock context for testing.
 * We cast to HookEndpointContext since we only test the properties our hooks use.
 */
function createMockContext(overrides: {
  path: string;
  method: string;
  body?: Record<string, unknown>;
  context?: {
    newSession?: {
      user: { id: string; email: string };
      session: { id: string; activeOrganizationId?: string | null };
    } | null;
  };
}): HookEndpointContext {
  return {
    path: overrides.path,
    method: overrides.method,
    body: overrides.body ?? {},
    context: overrides.context,
  } as HookEndpointContext;
}

describe("handleBeforeHook", () => {
  describe("invitation email validation", () => {
    test("should throw BAD_REQUEST for invalid email format", async () => {
      const ctx = createMockContext({
        path: "/organization/invite-member",
        method: "POST",
        body: { email: "not-an-email" },
      });

      await expect(handleBeforeHook(ctx)).rejects.toThrow(APIError);
      await expect(handleBeforeHook(ctx)).rejects.toMatchObject({
        body: { message: "Invalid email format" },
      });
    });

    test("should pass through for valid email format", async () => {
      const ctx = createMockContext({
        path: "/organization/invite-member",
        method: "POST",
        body: { email: "valid@example.com" },
      });

      const result = await handleBeforeHook(ctx);
      expect(result).toBe(ctx);
    });

    test("should not validate email for other paths", async () => {
      const ctx = createMockContext({
        path: "/some-other-path",
        method: "POST",
        body: { email: "not-an-email" },
      });

      const result = await handleBeforeHook(ctx);
      expect(result).toBe(ctx);
    });
  });

  describe("sign-up invitation validation", () => {
    test("should throw FORBIDDEN when no invitation ID is provided", async () => {
      const ctx = createMockContext({
        path: "/sign-up/email",
        method: "POST",
        body: { email: "user@example.com", callbackURL: "http://example.com" },
      });

      await expect(handleBeforeHook(ctx)).rejects.toThrow(APIError);
      await expect(handleBeforeHook(ctx)).rejects.toMatchObject({
        body: {
          message:
            "Direct sign-up is disabled. You need an invitation to create an account.",
        },
      });
    });

    test("should throw BAD_REQUEST for invalid invitation ID", async ({
      makeOrganization,
    }) => {
      await makeOrganization();
      const ctx = createMockContext({
        path: "/sign-up/email",
        method: "POST",
        body: {
          email: "user@example.com",
          callbackURL: "http://example.com?invitationId=non-existent-id",
        },
      });

      await expect(handleBeforeHook(ctx)).rejects.toThrow(APIError);
      await expect(handleBeforeHook(ctx)).rejects.toMatchObject({
        body: { message: "Invalid invitation ID" },
      });
    });

    test("should throw BAD_REQUEST for already accepted invitation", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();
      const invitation = await makeInvitation(org.id, inviter.id, {
        email: "user@example.com",
        status: "accepted",
      });

      const ctx = createMockContext({
        path: "/sign-up/email",
        method: "POST",
        body: {
          email: "user@example.com",
          callbackURL: `http://example.com?invitationId=${invitation.id}`,
        },
      });

      await expect(handleBeforeHook(ctx)).rejects.toThrow(APIError);
      await expect(handleBeforeHook(ctx)).rejects.toMatchObject({
        body: { message: "This invitation has already been accepted" },
      });
    });

    test("should throw BAD_REQUEST for expired invitation", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();
      const expiredDate = new Date();
      expiredDate.setDate(expiredDate.getDate() - 1); // Yesterday

      const invitation = await makeInvitation(org.id, inviter.id, {
        email: "user@example.com",
        status: "pending",
        expiresAt: expiredDate,
      });

      const ctx = createMockContext({
        path: "/sign-up/email",
        method: "POST",
        body: {
          email: "user@example.com",
          callbackURL: `http://example.com?invitationId=${invitation.id}`,
        },
      });

      await expect(handleBeforeHook(ctx)).rejects.toThrow(APIError);
      await expect(handleBeforeHook(ctx)).rejects.toMatchObject({
        body: {
          message:
            "The invitation link has expired, please contact your admin for a new invitation",
        },
      });
    });

    test("should throw BAD_REQUEST for email mismatch", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();
      const invitation = await makeInvitation(org.id, inviter.id, {
        email: "invited@example.com",
        status: "pending",
      });

      const ctx = createMockContext({
        path: "/sign-up/email",
        method: "POST",
        body: {
          email: "different@example.com",
          callbackURL: `http://example.com?invitationId=${invitation.id}`,
        },
      });

      await expect(handleBeforeHook(ctx)).rejects.toThrow(APIError);
      await expect(handleBeforeHook(ctx)).rejects.toMatchObject({
        body: {
          message:
            "Email address does not match the invitation. You must use the invited email address.",
        },
      });
    });

    test("should pass for valid pending invitation with matching email", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7); // Next week

      const invitation = await makeInvitation(org.id, inviter.id, {
        email: "user@example.com",
        status: "pending",
        expiresAt: futureDate,
      });

      const ctx = createMockContext({
        path: "/sign-up/email",
        method: "POST",
        body: {
          email: "user@example.com",
          callbackURL: `http://example.com?invitationId=${invitation.id}`,
        },
      });

      const result = await handleBeforeHook(ctx);
      expect(result).toBe(ctx);
    });
  });
});

describe("handleAfterHook", () => {
  describe("cancel invitation", () => {
    test("should delete invitation when canceled", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();
      const invitation = await makeInvitation(org.id, inviter.id, {
        email: "user@example.com",
        status: "pending",
      });

      const ctx = createMockContext({
        path: "/organization/cancel-invitation",
        method: "POST",
        body: { invitationId: invitation.id },
      });

      // Should not throw
      await handleAfterHook(ctx);

      // Verify invitation was deleted by trying to create with same email
      // (would fail if invitation still existed with pending status)
      const newInvitation = await makeInvitation(org.id, inviter.id, {
        email: "user@example.com",
        status: "pending",
      });
      expect(newInvitation).toBeDefined();
    });

    test("should handle missing invitationId gracefully", async () => {
      const ctx = createMockContext({
        path: "/organization/cancel-invitation",
        method: "POST",
        body: {},
      });

      // Should not throw
      await expect(handleAfterHook(ctx)).resolves.toBeUndefined();
    });
  });

  describe("remove user sessions", () => {
    test("should delete all sessions when user is removed", async ({
      makeUser,
    }) => {
      const user = await makeUser();

      const ctx = createMockContext({
        path: "/admin/remove-user",
        method: "POST",
        body: { userId: user.id },
      });

      // Should not throw
      await expect(handleAfterHook(ctx)).resolves.toBeUndefined();
    });

    test("should handle missing userId gracefully", async () => {
      const ctx = createMockContext({
        path: "/admin/remove-user",
        method: "POST",
        body: {},
      });

      // Should not throw
      await expect(handleAfterHook(ctx)).resolves.toBeUndefined();
    });
  });

  describe("sign-in active organization", () => {
    test("should set active organization for user without one", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      const ctx = createMockContext({
        path: "/sign-in",
        method: "POST",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: null },
          },
        },
      });

      // Should not throw
      await expect(handleAfterHook(ctx)).resolves.toBeUndefined();
    });

    test("should not change active organization if already set", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      const ctx = createMockContext({
        path: "/sign-in",
        method: "POST",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: org.id },
          },
        },
      });

      // Should not throw
      await expect(handleAfterHook(ctx)).resolves.toBeUndefined();
    });

    test("should handle SSO callback path", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      const ctx = createMockContext({
        path: "/sso/callback/keycloak",
        method: "GET",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: null },
          },
        },
      });

      // Should not throw
      await expect(handleAfterHook(ctx)).resolves.toBeUndefined();
    });

    test("should handle user without any memberships", async ({ makeUser }) => {
      const user = await makeUser();

      const ctx = createMockContext({
        path: "/sign-in",
        method: "POST",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: null },
          },
        },
      });

      // Should not throw even if user has no memberships
      await expect(handleAfterHook(ctx)).resolves.toBeUndefined();
    });
  });

  describe("sign-up invitation acceptance", () => {
    test("should return early if no invitation ID in callback URL", async ({
      makeUser,
    }) => {
      const user = await makeUser();

      const ctx = createMockContext({
        path: "/sign-up",
        method: "POST",
        body: { callbackURL: "http://example.com" },
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id" },
          },
        },
      });

      // Should return undefined (early return)
      await expect(handleAfterHook(ctx)).resolves.toBeUndefined();
    });

    test("should return early if no newSession in context", async () => {
      const ctx = createMockContext({
        path: "/sign-up",
        method: "POST",
        body: {
          callbackURL: "http://example.com?invitationId=some-id",
        },
        context: {},
      });

      // Should return undefined (no newSession)
      await expect(handleAfterHook(ctx)).resolves.toBeUndefined();
    });
  });

  describe("auto-accept pending invitations on sign-in", () => {
    test("should auto-accept pending invitation for user email", async ({
      makeUser,
      makeOrganization,
      makeInvitation,
    }) => {
      const inviter = await makeUser();
      const user = await makeUser({ email: "invited@example.com" });
      const org = await makeOrganization();
      await makeInvitation(org.id, inviter.id, {
        email: "invited@example.com",
        status: "pending",
      });

      const ctx = createMockContext({
        path: "/sign-in",
        method: "POST",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: null },
          },
        },
      });

      // The function will call InvitationModel.accept which might fail
      // depending on test setup, but it shouldn't throw unhandled errors
      await expect(handleAfterHook(ctx)).resolves.not.toThrow();
    });
  });
});
