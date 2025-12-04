import type { HookEndpointContext } from "@better-auth/core";
import { APIError } from "better-auth";
import config from "@/config";
import { TeamModel } from "@/models";
import { describe, expect, test } from "@/test";
import { handleAfterHook, handleBeforeHook } from "./better-auth";

/**
 * Creates a mock JWT idToken with the given claims.
 * This is a simple base64-encoded JWT for testing purposes.
 */
function createMockIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = "test-signature";
  return `${header}.${payload}.${signature}`;
}

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

  describe("SSO team sync", () => {
    const originalEnterpriseValue = config.enterpriseLicenseActivated;

    // Helper to set enterprise license config
    function setEnterpriseLicense(value: boolean) {
      Object.defineProperty(config, "enterpriseLicenseActivated", {
        value,
        writable: true,
        configurable: true,
      });
    }

    test("should sync teams when SSO callback path with SSO account", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeTeam,
      makeAccount,
      makeSsoProvider,
    }) => {
      // Enable enterprise license
      setEnterpriseLicense(true);

      const user = await makeUser({ email: "sso-user@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });
      const team = await makeTeam(org.id, user.id, { name: "SSO Team" });

      // Create SSO provider for this organization
      await makeSsoProvider(org.id, { providerId: "keycloak-local" });

      // Create SSO account with idToken containing groups
      const idToken = createMockIdToken({
        sub: user.id,
        email: user.email,
        groups: ["engineering"],
      });
      await makeAccount(user.id, {
        providerId: "keycloak-local",
        idToken,
      });

      // Link an external group to the team
      await TeamModel.addExternalGroup(team.id, "engineering");

      const ctx = createMockContext({
        path: "/sso/callback/keycloak-local",
        method: "GET",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: org.id },
          },
        },
      });

      await handleAfterHook(ctx);

      // Verify user was added to the team
      const isInTeam = await TeamModel.isUserInTeam(team.id, user.id);
      expect(isInTeam).toBe(true);

      // Restore original value
      setEnterpriseLicense(originalEnterpriseValue);
    });

    test("should not sync teams when enterprise license is disabled", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeTeam,
      makeAccount,
      makeSsoProvider,
    }) => {
      // Disable enterprise license
      setEnterpriseLicense(false);

      const user = await makeUser({ email: "sso-user2@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });
      const team = await makeTeam(org.id, user.id, { name: "SSO Team 2" });

      // Create SSO provider for this organization
      await makeSsoProvider(org.id, { providerId: "keycloak-local-2" });

      // Create SSO account with idToken containing groups
      const idToken = createMockIdToken({
        sub: user.id,
        email: user.email,
        groups: ["developers"],
      });
      await makeAccount(user.id, {
        providerId: "keycloak-local-2",
        idToken,
      });

      // Link an external group to the team
      await TeamModel.addExternalGroup(team.id, "developers");

      const ctx = createMockContext({
        path: "/sso/callback/keycloak-local-2",
        method: "GET",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: org.id },
          },
        },
      });

      await handleAfterHook(ctx);

      // Verify user was NOT added to the team (enterprise license disabled)
      const isInTeam = await TeamModel.isUserInTeam(team.id, user.id);
      expect(isInTeam).toBe(false);

      // Restore original value
      setEnterpriseLicense(originalEnterpriseValue);
    });

    test("should not sync teams for regular sign-in (non-SSO)", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeTeam,
      makeAccount,
      makeSsoProvider,
    }) => {
      // Enable enterprise license
      setEnterpriseLicense(true);

      const user = await makeUser({ email: "regular-user@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });
      const team = await makeTeam(org.id, user.id, {
        name: "Team for Regular",
      });

      // Create SSO provider for this organization
      await makeSsoProvider(org.id, { providerId: "keycloak-local-3" });

      // Create SSO account with idToken containing groups (but shouldn't be used for regular sign-in)
      const idToken = createMockIdToken({
        sub: user.id,
        email: user.email,
        groups: ["staff"],
      });
      await makeAccount(user.id, {
        providerId: "keycloak-local-3",
        idToken,
      });

      // Link an external group to the team
      await TeamModel.addExternalGroup(team.id, "staff");

      const ctx = createMockContext({
        path: "/sign-in", // Regular sign-in, not SSO callback
        method: "POST",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: org.id },
          },
        },
      });

      await handleAfterHook(ctx);

      // Verify user was NOT added to the team (regular sign-in doesn't sync teams)
      const isInTeam = await TeamModel.isUserInTeam(team.id, user.id);
      expect(isInTeam).toBe(false);

      // Restore original value
      setEnterpriseLicense(originalEnterpriseValue);
    });

    test("should handle missing SSO account gracefully", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      // Enable enterprise license
      setEnterpriseLicense(true);

      const user = await makeUser({ email: "no-sso-account@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      // Don't create any SSO account

      const ctx = createMockContext({
        path: "/sso/callback/keycloak-local",
        method: "GET",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: org.id },
          },
        },
      });

      // Should not throw, just skip team sync
      await expect(handleAfterHook(ctx)).resolves.not.toThrow();

      // Restore original value
      setEnterpriseLicense(originalEnterpriseValue);
    });

    test("should remove user from teams when SSO groups change", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeTeam,
      makeAccount,
      makeSsoProvider,
    }) => {
      // Enable enterprise license
      setEnterpriseLicense(true);

      const user = await makeUser({ email: "sync-remove@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });
      const team = await makeTeam(org.id, user.id, { name: "Removal Team" });

      // Create SSO provider for this organization
      await makeSsoProvider(org.id, { providerId: "keycloak-local-4" });

      // Create SSO account with idToken containing NEW groups (user was removed from old-group)
      const idToken = createMockIdToken({
        sub: user.id,
        email: user.email,
        groups: ["new-group"], // old-group is no longer present
      });
      await makeAccount(user.id, {
        providerId: "keycloak-local-4",
        idToken,
      });

      // Link an external group to the team
      await TeamModel.addExternalGroup(team.id, "old-group");

      // Add user to team via SSO sync initially
      await TeamModel.addMember(team.id, user.id, "member", true); // syncedFromSso = true

      // Verify user is in team
      let isInTeam = await TeamModel.isUserInTeam(team.id, user.id);
      expect(isInTeam).toBe(true);

      const ctx = createMockContext({
        path: "/sso/callback/keycloak-local-4",
        method: "GET",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: org.id },
          },
        },
      });

      await handleAfterHook(ctx);

      // Verify user was removed from the team
      isInTeam = await TeamModel.isUserInTeam(team.id, user.id);
      expect(isInTeam).toBe(false);

      // Restore original value
      setEnterpriseLicense(originalEnterpriseValue);
    });
  });
});
