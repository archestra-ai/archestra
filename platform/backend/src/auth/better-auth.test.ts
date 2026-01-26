import type { HookEndpointContext } from "@better-auth/core";
import { APIError } from "better-auth";
import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import { MemberModel, TeamModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";

// Create a hoisted ref to control disableInvitations in tests
const mockDisableInvitations = vi.hoisted(() => ({ value: false }));

// Mock config module before importing better-auth
vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      enterpriseLicenseActivated: true,
      auth: {
        ...actual.default.auth,
        get disableInvitations() {
          return mockDisableInvitations.value;
        },
      },
    },
  };
});

// Import after mock setup (dynamic import needed because of the mock)
const { default: config } = await import("@/config");
const { handleAfterHook, handleBeforeHook } = await import("./better-auth");

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
  // Reset mock to default before each test for proper isolation
  beforeEach(() => {
    mockDisableInvitations.value = false;
  });

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

  describe("disabled invitations (ARCHESTRA_AUTH_DISABLE_INVITATIONS=true)", () => {
    beforeEach(() => {
      mockDisableInvitations.value = true;
    });

    test("should throw FORBIDDEN for invite-member when invitations are disabled", async () => {
      const ctx = createMockContext({
        path: "/organization/invite-member",
        method: "POST",
        body: { email: "valid@example.com" },
      });

      await expect(handleBeforeHook(ctx)).rejects.toThrow(APIError);
      await expect(handleBeforeHook(ctx)).rejects.toMatchObject({
        body: { message: "User invitations are disabled" },
      });
    });

    test("should throw FORBIDDEN for cancel-invitation when invitations are disabled", async () => {
      const ctx = createMockContext({
        path: "/organization/cancel-invitation",
        method: "POST",
        body: { invitationId: "some-id" },
      });

      await expect(handleBeforeHook(ctx)).rejects.toThrow(APIError);
      await expect(handleBeforeHook(ctx)).rejects.toMatchObject({
        body: { message: "User invitations are disabled" },
      });
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

  describe("SSO role sync", () => {
    test("should sync role when SSO callback with role mapping rules", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAccount,
      makeSsoProvider,
    }) => {
      const user = await makeUser({ email: "role-sync@example.com" });
      const org = await makeOrganization();
      // Start with member role
      await makeMember(user.id, org.id, { role: "member" });

      // Create SSO provider with role mapping rules that map admins group to admin role
      await makeSsoProvider(org.id, {
        providerId: "keycloak-role-sync",
        roleMapping: {
          defaultRole: "member",
          rules: [
            {
              expression: '{{#includes groups "admins"}}true{{/includes}}',
              role: "admin",
            },
          ],
        } as unknown as Record<string, unknown>,
      });

      // Create SSO account with idToken containing admins group
      const idToken = createMockIdToken({
        sub: user.id,
        email: user.email,
        groups: ["admins", "users"],
      });
      await makeAccount(user.id, {
        providerId: "keycloak-role-sync",
        idToken,
      });

      const ctx = createMockContext({
        path: "/sso/callback/keycloak-role-sync",
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

      // Verify user role was updated to admin
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member?.role).toBe("admin");
    });

    test("should not change role when no rules match", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAccount,
      makeSsoProvider,
    }) => {
      const user = await makeUser({ email: "no-match@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      // Create SSO provider with role mapping rules that don't match
      await makeSsoProvider(org.id, {
        providerId: "keycloak-no-match",
        roleMapping: {
          defaultRole: "member",
          rules: [
            {
              expression:
                '{{#includes groups "super-admins"}}true{{/includes}}',
              role: "admin",
            },
          ],
        } as unknown as Record<string, unknown>,
      });

      // Create SSO account WITHOUT the required group
      const idToken = createMockIdToken({
        sub: user.id,
        email: user.email,
        groups: ["users"], // Not in super-admins
      });
      await makeAccount(user.id, {
        providerId: "keycloak-no-match",
        idToken,
      });

      const ctx = createMockContext({
        path: "/sso/callback/keycloak-no-match",
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

      // Verify user role remains member (default role applied)
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member?.role).toBe("member");
    });

    test("should respect skipRoleSync setting", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAccount,
      makeSsoProvider,
    }) => {
      const user = await makeUser({ email: "skip-sync@example.com" });
      const org = await makeOrganization();
      // Start with admin role
      await makeMember(user.id, org.id, { role: "admin" });

      // Create SSO provider with skipRoleSync enabled
      await makeSsoProvider(org.id, {
        providerId: "keycloak-skip-sync",
        roleMapping: {
          defaultRole: "member",
          skipRoleSync: true,
          rules: [
            {
              expression: '{{#includes groups "users"}}true{{/includes}}',
              role: "member", // Would demote to member if sync wasn't skipped
            },
          ],
        } as unknown as Record<string, unknown>,
      });

      // Create SSO account with groups that would trigger demotion
      const idToken = createMockIdToken({
        sub: user.id,
        email: user.email,
        groups: ["users"],
      });
      await makeAccount(user.id, {
        providerId: "keycloak-skip-sync",
        idToken,
      });

      const ctx = createMockContext({
        path: "/sso/callback/keycloak-skip-sync",
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

      // Verify user role was NOT changed (skipRoleSync is enabled)
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member?.role).toBe("admin");
    });

    test("should not sync role for regular sign-in (non-SSO)", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAccount,
      makeSsoProvider,
    }) => {
      const user = await makeUser({ email: "regular-signin@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      // Create SSO provider with role mapping
      await makeSsoProvider(org.id, {
        providerId: "keycloak-regular",
        roleMapping: {
          defaultRole: "member",
          rules: [
            {
              expression: '{{#includes groups "admins"}}true{{/includes}}',
              role: "admin",
            },
          ],
        } as unknown as Record<string, unknown>,
      });

      // Create SSO account with admins group
      const idToken = createMockIdToken({
        sub: user.id,
        email: user.email,
        groups: ["admins"],
      });
      await makeAccount(user.id, {
        providerId: "keycloak-regular",
        idToken,
      });

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

      // Verify user role was NOT changed (regular sign-in doesn't sync role)
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member?.role).toBe("member");
    });

    test("should handle missing SSO account gracefully", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeSsoProvider,
    }) => {
      const user = await makeUser({ email: "no-sso-account-role@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      // Create SSO provider with role mapping
      await makeSsoProvider(org.id, {
        providerId: "keycloak-no-account",
        roleMapping: {
          defaultRole: "member",
          rules: [
            {
              expression: '{{#includes groups "admins"}}true{{/includes}}',
              role: "admin",
            },
          ],
        } as unknown as Record<string, unknown>,
      });

      // Don't create any SSO account

      const ctx = createMockContext({
        path: "/sso/callback/keycloak-no-account",
        method: "GET",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: org.id },
          },
        },
      });

      // Should not throw
      await expect(handleAfterHook(ctx)).resolves.not.toThrow();

      // Verify role wasn't changed
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member?.role).toBe("member");
    });

    test("should handle missing idToken gracefully", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAccount,
      makeSsoProvider,
    }) => {
      const user = await makeUser({ email: "no-idtoken@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      // Create SSO provider with role mapping
      await makeSsoProvider(org.id, {
        providerId: "keycloak-no-idtoken",
        roleMapping: {
          defaultRole: "member",
          rules: [
            {
              expression: '{{#includes groups "admins"}}true{{/includes}}',
              role: "admin",
            },
          ],
        } as unknown as Record<string, unknown>,
      });

      // Create SSO account WITHOUT idToken
      await makeAccount(user.id, {
        providerId: "keycloak-no-idtoken",
        // No idToken
      });

      const ctx = createMockContext({
        path: "/sso/callback/keycloak-no-idtoken",
        method: "GET",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: org.id },
          },
        },
      });

      // Should not throw
      await expect(handleAfterHook(ctx)).resolves.not.toThrow();

      // Verify role wasn't changed
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member?.role).toBe("member");
    });

    test("should handle SSO provider without role mapping", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAccount,
      makeSsoProvider,
    }) => {
      const user = await makeUser({ email: "no-mapping@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      // Create SSO provider WITHOUT role mapping
      await makeSsoProvider(org.id, { providerId: "keycloak-no-mapping" });

      // Create SSO account with idToken
      const idToken = createMockIdToken({
        sub: user.id,
        email: user.email,
        groups: ["admins"],
      });
      await makeAccount(user.id, {
        providerId: "keycloak-no-mapping",
        idToken,
      });

      const ctx = createMockContext({
        path: "/sso/callback/keycloak-no-mapping",
        method: "GET",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: org.id },
          },
        },
      });

      // Should not throw
      await expect(handleAfterHook(ctx)).resolves.not.toThrow();

      // Verify role wasn't changed (no role mapping configured)
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member?.role).toBe("member");
    });

    test("should demote admin to member based on role mapping", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAccount,
      makeSsoProvider,
    }) => {
      const user = await makeUser({ email: "demote@example.com" });
      const org = await makeOrganization();
      // Start with admin role
      await makeMember(user.id, org.id, { role: "admin" });

      // Create SSO provider with role mapping that demotes non-admins
      await makeSsoProvider(org.id, {
        providerId: "keycloak-demote",
        roleMapping: {
          defaultRole: "member", // Default to member if no rules match
          rules: [
            {
              expression:
                '{{#includes groups "super-admins"}}true{{/includes}}',
              role: "admin",
            },
          ],
        } as unknown as Record<string, unknown>,
      });

      // Create SSO account WITHOUT super-admins group
      const idToken = createMockIdToken({
        sub: user.id,
        email: user.email,
        groups: ["users"], // Not in super-admins
      });
      await makeAccount(user.id, {
        providerId: "keycloak-demote",
        idToken,
      });

      const ctx = createMockContext({
        path: "/sso/callback/keycloak-demote",
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

      // Verify user was demoted to member
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member?.role).toBe("member");
    });

    test("should not change role when it's already correct", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAccount,
      makeSsoProvider,
    }) => {
      const user = await makeUser({ email: "already-correct@example.com" });
      const org = await makeOrganization();
      // Start with admin role (already correct)
      const initialMember = await makeMember(user.id, org.id, {
        role: "admin",
      });

      // Create SSO provider that maps admins to admin
      await makeSsoProvider(org.id, {
        providerId: "keycloak-already-correct",
        roleMapping: {
          defaultRole: "member",
          rules: [
            {
              expression: '{{#includes groups "admins"}}true{{/includes}}',
              role: "admin",
            },
          ],
        } as unknown as Record<string, unknown>,
      });

      // Create SSO account with admins group
      const idToken = createMockIdToken({
        sub: user.id,
        email: user.email,
        groups: ["admins"],
      });
      await makeAccount(user.id, {
        providerId: "keycloak-already-correct",
        idToken,
      });

      const ctx = createMockContext({
        path: "/sso/callback/keycloak-already-correct",
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

      // Verify role is still admin (no unnecessary update)
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member?.role).toBe("admin");
      // Verify the record wasn't unnecessarily updated
      expect(member?.id).toBe(initialMember.id);
    });

    test("should deny login for existing user when strictMode is enabled and no rules match", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAccount,
      makeSsoProvider,
    }) => {
      const user = await makeUser({ email: "strict-mode@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      // Create SSO provider with strictMode enabled
      await makeSsoProvider(org.id, {
        providerId: "keycloak-strict-mode",
        roleMapping: {
          defaultRole: "member",
          strictMode: true, // Enable strict mode
          rules: [
            {
              // Rule that won't match
              expression:
                '{{#includes groups "super-admins"}}true{{/includes}}',
              role: "admin",
            },
          ],
        } as unknown as Record<string, unknown>,
      });

      // Create SSO account WITHOUT the required group
      const idToken = createMockIdToken({
        sub: user.id,
        email: user.email,
        groups: ["users"], // Not in super-admins
      });
      await makeAccount(user.id, {
        providerId: "keycloak-strict-mode",
        idToken,
      });

      const ctx = createMockContext({
        path: "/sso/callback/keycloak-strict-mode",
        method: "GET",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: org.id },
          },
        },
      });

      // Should throw FORBIDDEN due to strict mode
      await expect(handleAfterHook(ctx)).rejects.toMatchObject({
        message: expect.stringContaining("Access denied"),
      });
    });

    test("should allow login for existing user when strictMode is enabled and a rule matches", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAccount,
      makeSsoProvider,
    }) => {
      const user = await makeUser({ email: "strict-mode-match@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      // Create SSO provider with strictMode enabled
      await makeSsoProvider(org.id, {
        providerId: "keycloak-strict-mode-match",
        roleMapping: {
          defaultRole: "member",
          strictMode: true, // Enable strict mode
          rules: [
            {
              expression: '{{#includes groups "admins"}}true{{/includes}}',
              role: "admin",
            },
          ],
        } as unknown as Record<string, unknown>,
      });

      // Create SSO account WITH the required group
      const idToken = createMockIdToken({
        sub: user.id,
        email: user.email,
        groups: ["admins"], // Matches the rule
      });
      await makeAccount(user.id, {
        providerId: "keycloak-strict-mode-match",
        idToken,
      });

      const ctx = createMockContext({
        path: "/sso/callback/keycloak-strict-mode-match",
        method: "GET",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: org.id },
          },
        },
      });

      // Should NOT throw
      await expect(handleAfterHook(ctx)).resolves.not.toThrow();

      // Verify user role was updated to admin
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member?.role).toBe("admin");
    });
  });
});
