import type { HookEndpointContext } from "@better-auth/core";
import { APIError } from "better-auth";
import { vi } from "vitest";
import { cacheManager } from "@/cache-manager";
import type * as originalConfigModule from "@/config";

// The logger is a Proxy at runtime — vi.spyOn can't intercept its properties.
// Replace the module with a plain mock object so individual tests can assert on it.
const logErrorFn = vi.hoisted(() => vi.fn());
vi.mock("@/logging", () => ({
  default: {
    error: logErrorFn,
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import {
  AccountModel,
  MemberModel,
  SessionModel,
  TeamModel,
  UserModel,
} from "@/models";
import AuditLogModel from "@/models/audit-log";
import InvitationModel from "@/models/invitation";
import { beforeEach, describe, expect, test } from "@/test";

// Create a hoisted ref to control disableInvitations in tests
const mockDisableInvitations = vi.hoisted(() => ({ value: false }));

// Mock config module before importing better-auth
vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      enterpriseFeatures: { ...actual.default.enterpriseFeatures, core: true },
      auth: {
        ...actual.default.auth,
        trustedOrigins: ["https://app.example.com"],
        get disableInvitations() {
          return mockDisableInvitations.value;
        },
      },
    },
  };
});

// Import after mock setup (dynamic import needed because of the mock)
const { default: config } = await import("@/config");
const { auth, handleAfterHook, handleBeforeHook } = await import(
  "./better-auth"
);

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
  requestUrl?: string;
  request?: Request;
  context?: {
    newSession?: {
      user: { id: string; email: string };
      session: { id: string; activeOrganizationId?: string | null };
    } | null;
    /** Present on sign-out: the session being terminated. */
    session?: {
      user: { id: string; email: string; name?: string | null };
      session: { id: string; activeOrganizationId?: string | null };
    } | null;
  };
}): HookEndpointContext {
  return {
    path: overrides.path,
    method: overrides.method,
    body: overrides.body ?? {},
    request:
      overrides.request ??
      (overrides.requestUrl ? new Request(overrides.requestUrl) : undefined),
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

    test("should pass when invitation ID is provided in request body", async ({
      makeOrganization,
      makeUser,
      makeInvitation,
    }) => {
      const org = await makeOrganization();
      const inviter = await makeUser();
      const invitation = await makeInvitation(org.id, inviter.id, {
        email: "body-invite@example.com",
        status: "pending",
      });

      const ctx = createMockContext({
        path: "/sign-up/email",
        method: "POST",
        body: {
          email: "body-invite@example.com",
          callbackURL: "/chat",
          invitationId: invitation.id,
        },
      });

      const result = await handleBeforeHook(ctx);
      expect(result).toBe(ctx);
    });
  });
});

describe("trustedOrigins", () => {
  test("widens trusted origins for internal auth.api registration calls", async () => {
    const trustedOriginsOption = auth.options.trustedOrigins;

    expect(typeof trustedOriginsOption).toBe("function");

    const trustedOrigins = await trustedOriginsOption?.();

    expect(trustedOrigins).toEqual(
      expect.arrayContaining([
        "https://app.example.com",
        "http://*:*",
        "https://*:*",
        "http://*",
        "https://*",
      ]),
    );
  });

  test("widens trusted origins for /sso/register requests", async () => {
    const trustedOriginsOption = auth.options.trustedOrigins;

    expect(typeof trustedOriginsOption).toBe("function");

    const trustedOrigins = await trustedOriginsOption?.(
      new Request("https://app.example.com/api/auth/sso/register"),
    );

    expect(trustedOrigins).toEqual(
      expect.arrayContaining([
        "https://app.example.com",
        "http://*:*",
        "https://*:*",
        "http://*",
        "https://*",
      ]),
    );
  });

  test("widens trusted origins for identity provider create requests", async () => {
    const trustedOriginsOption = auth.options.trustedOrigins;

    expect(typeof trustedOriginsOption).toBe("function");

    const trustedOrigins = await trustedOriginsOption?.(
      new Request("https://app.example.com/api/identity-providers", {
        method: "POST",
      }),
    );

    expect(trustedOrigins).toEqual(
      expect.arrayContaining([
        "https://app.example.com",
        "http://*:*",
        "https://*:*",
        "http://*",
        "https://*",
      ]),
    );
  });

  test("keeps regular auth requests on the configured trusted origins", async () => {
    const trustedOriginsOption = auth.options.trustedOrigins;

    expect(typeof trustedOriginsOption).toBe("function");

    const trustedOrigins = await trustedOriginsOption?.(
      new Request("https://app.example.com/api/auth/sign-in/email"),
    );

    expect(trustedOrigins).toEqual(["https://app.example.com"]);
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

    test("should handle normalized SSO callback path when request URL contains /api/auth prefix", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      const ctx = createMockContext({
        path: "/sso/callback/:providerId",
        method: "GET",
        requestUrl:
          "http://localhost:3000/api/auth/sso/callback/keycloak?code=test",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: null },
          },
        },
      });

      await expect(handleAfterHook(ctx)).resolves.toBeUndefined();
    });

    test("should reject SSO login when user email does not match provider domain", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeIdentityProvider,
      makeSession,
      makeAccount,
    }) => {
      const user = await makeUser({ email: "person@other.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });
      await makeAccount(user.id, { providerId: "credential" });
      await makeIdentityProvider(org.id, {
        providerId: "google-workspace",
        domain: "example.com",
      });
      await makeAccount(user.id, { providerId: "google-workspace" });
      const session = await makeSession(user.id, {
        activeOrganizationId: org.id,
      });

      const ctx = createMockContext({
        path: "/sso/callback/google-workspace",
        method: "GET",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: session.id, activeOrganizationId: org.id },
          },
        },
      });

      await expect(handleAfterHook(ctx)).rejects.toMatchObject({
        status: "FORBIDDEN",
        body: {
          message:
            "Your email domain is not allowed for this identity provider.",
        },
      });
      expect(await SessionModel.getById(session.id)).toHaveLength(0);
      expect(
        await AccountModel.getLatestSsoAccountByUserIdAndProviderId(
          user.id,
          "google-workspace",
        ),
      ).toBeUndefined();
      expect(await MemberModel.getByUserId(user.id, org.id)).toBeDefined();
      expect(await UserModel.findByEmail(user.email)).toBeDefined();
    });

    test("should clean up rows created by a rejected first-time SSO login", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeIdentityProvider,
      makeSession,
      makeAccount,
    }) => {
      const user = await makeUser({ email: "new-person@other.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });
      await makeIdentityProvider(org.id, {
        providerId: "google-workspace-new-user",
        domain: "example.com",
      });
      await makeAccount(user.id, { providerId: "google-workspace-new-user" });
      const session = await makeSession(user.id, {
        activeOrganizationId: org.id,
      });

      const ctx = createMockContext({
        path: "/sso/callback/google-workspace-new-user",
        method: "GET",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: session.id, activeOrganizationId: org.id },
          },
        },
      });

      await expect(handleAfterHook(ctx)).rejects.toMatchObject({
        status: "FORBIDDEN",
      });
      expect(await SessionModel.getById(session.id)).toHaveLength(0);
      expect(await AccountModel.getAllByUserId(user.id)).toHaveLength(0);
      expect(await MemberModel.getByUserId(user.id, org.id)).toBeUndefined();
      expect(await UserModel.findByEmail(user.email)).toBeUndefined();
    });

    test("should allow SSO login when user email matches provider domain", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeIdentityProvider,
      makeSession,
    }) => {
      const user = await makeUser({ email: "person@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });
      await makeIdentityProvider(org.id, {
        providerId: "google-workspace-allowed",
        domain: "example.com",
      });
      const session = await makeSession(user.id, {
        activeOrganizationId: org.id,
      });

      const ctx = createMockContext({
        path: "/sso/callback/google-workspace-allowed",
        method: "GET",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: session.id, activeOrganizationId: org.id },
          },
        },
      });

      await expect(handleAfterHook(ctx)).resolves.toBeUndefined();
      expect(await SessionModel.getById(session.id)).toHaveLength(1);
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

    test("should auto-accept pending invitation with custom role", async ({
      makeUser,
      makeOrganization,
      makeInvitation,
      makeCustomRole,
    }) => {
      const inviter = await makeUser();
      const user = await makeUser({ email: "custom-role-signin@example.com" });
      const org = await makeOrganization();

      // Create a custom role
      const customRole = await makeCustomRole(org.id, {
        role: "custom_signin_role",
        name: "Custom Sign-in Role",
        permission: { agent: ["read"] },
      });

      // Create invitation with the custom role
      await makeInvitation(org.id, inviter.id, {
        email: "custom-role-signin@example.com",
        status: "pending",
        role: customRole.role,
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

      // Should not throw
      await expect(handleAfterHook(ctx)).resolves.not.toThrow();

      // Verify the member was created with the custom role
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member).toBeDefined();
      expect(member?.role).toBe(customRole.role);
    });
  });

  describe("SSO team sync", () => {
    const originalEnterpriseValue = config.enterpriseFeatures.core;

    // Helper to set enterprise license config
    function setEnterpriseLicense(value: boolean) {
      Object.defineProperty(config.enterpriseFeatures, "core", {
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
      makeIdentityProvider,
    }) => {
      // Enable enterprise license
      setEnterpriseLicense(true);

      const user = await makeUser({ email: "sso-user@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });
      const team = await makeTeam(org.id, user.id, { name: "SSO Team" });

      // Create SSO provider for this organization
      await makeIdentityProvider(org.id, { providerId: "keycloak-local" });

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
      makeIdentityProvider,
    }) => {
      // Disable enterprise license
      setEnterpriseLicense(false);

      const user = await makeUser({ email: "sso-user2@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });
      const team = await makeTeam(org.id, user.id, { name: "SSO Team 2" });

      // Create SSO provider for this organization
      await makeIdentityProvider(org.id, { providerId: "keycloak-local-2" });

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
      makeIdentityProvider,
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
      await makeIdentityProvider(org.id, { providerId: "keycloak-local-3" });

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

    test("uses cached IdP groups when the account idToken is not available yet", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeTeam,
      makeAccount,
      makeIdentityProvider,
    }) => {
      setEnterpriseLicense(true);

      const user = await makeUser({ email: "cached-sso-user@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });
      const team = await makeTeam(org.id, user.id, { name: "Cached SSO Team" });

      await makeIdentityProvider(org.id, { providerId: "keycloak-cached" });

      await makeAccount(user.id, {
        providerId: "keycloak-cached",
        idToken: null,
      });

      await TeamModel.addExternalGroup(team.id, "engineering");
      vi.spyOn(cacheManager, "getAndDelete").mockResolvedValue({
        groups: ["engineering"],
        organizationId: org.id,
      });

      const ctx = createMockContext({
        path: "/sso/callback/keycloak-cached",
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

      const isInTeam = await TeamModel.isUserInTeam(team.id, user.id);
      expect(isInTeam).toBe(true);

      setEnterpriseLicense(originalEnterpriseValue);
    });

    test("uses the callback provider account when multiple SSO accounts exist", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeTeam,
      makeAccount,
      makeIdentityProvider,
    }) => {
      setEnterpriseLicense(true);

      const user = await makeUser({ email: "multi-sso-user@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });
      const team = await makeTeam(org.id, user.id, {
        name: "Multi Provider SSO Team",
      });

      await makeIdentityProvider(org.id, { providerId: "keycloak-target" });
      await makeIdentityProvider(org.id, { providerId: "keycloak-stale" });

      await makeAccount(user.id, {
        providerId: "keycloak-stale",
        idToken: createMockIdToken({
          sub: user.id,
          email: user.email,
          groups: ["wrong-group"],
        }),
      });
      await makeAccount(user.id, {
        providerId: "keycloak-target",
        idToken: createMockIdToken({
          sub: user.id,
          email: user.email,
          groups: ["engineering"],
        }),
      });

      await TeamModel.addExternalGroup(team.id, "engineering");

      const ctx = createMockContext({
        path: "/sso/callback/:providerId",
        method: "GET",
        requestUrl:
          "http://localhost:3000/api/auth/sso/callback/keycloak-target?code=test",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: org.id },
          },
        },
      });

      await handleAfterHook(ctx);

      const isInTeam = await TeamModel.isUserInTeam(team.id, user.id);
      expect(isInTeam).toBe(true);

      setEnterpriseLicense(originalEnterpriseValue);
    });

    test("should remove user from teams when SSO groups change", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeTeam,
      makeAccount,
      makeIdentityProvider,
    }) => {
      // Enable enterprise license
      setEnterpriseLicense(true);

      const user = await makeUser({ email: "sync-remove@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });
      const team = await makeTeam(org.id, user.id, { name: "Removal Team" });

      // Create SSO provider for this organization
      await makeIdentityProvider(org.id, { providerId: "keycloak-local-4" });

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
      makeIdentityProvider,
    }) => {
      const user = await makeUser({ email: "role-sync@example.com" });
      const org = await makeOrganization();
      // Start with member role
      await makeMember(user.id, org.id, { role: "member" });

      // Create SSO provider with role mapping rules that map admins group to admin role
      await makeIdentityProvider(org.id, {
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
      makeIdentityProvider,
    }) => {
      const user = await makeUser({ email: "no-match@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      // Create SSO provider with role mapping rules that don't match
      await makeIdentityProvider(org.id, {
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
      makeIdentityProvider,
    }) => {
      const user = await makeUser({ email: "skip-sync@example.com" });
      const org = await makeOrganization();
      // Start with admin role
      await makeMember(user.id, org.id, { role: "admin" });

      // Create SSO provider with skipRoleSync enabled
      await makeIdentityProvider(org.id, {
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

    test("should leave existing role unchanged when role mapping has no rules", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAccount,
      makeIdentityProvider,
    }) => {
      const user = await makeUser({ email: "default-only@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "admin" });

      await makeIdentityProvider(org.id, {
        providerId: "keycloak-default-only",
        roleMapping: {
          defaultRole: "member",
          rules: [],
        } as unknown as Record<string, unknown>,
      });

      await makeAccount(user.id, {
        providerId: "keycloak-default-only",
        idToken: createMockIdToken({
          sub: user.id,
          email: user.email,
          groups: ["admins"],
        }),
      });

      const ctx = createMockContext({
        path: "/sso/callback/keycloak-default-only",
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

      // Default-role fallback must not silently overwrite an existing
      // member's role — provisioning is handled elsewhere, and ongoing
      // sync should only mutate when a rule explicitly matches.
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member?.role).toBe("admin");
    });

    test("should not sync role for regular sign-in (non-SSO)", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAccount,
      makeIdentityProvider,
    }) => {
      const user = await makeUser({ email: "regular-signin@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      // Create SSO provider with role mapping
      await makeIdentityProvider(org.id, {
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
      makeIdentityProvider,
    }) => {
      const user = await makeUser({ email: "no-sso-account-role@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      // Create SSO provider with role mapping
      await makeIdentityProvider(org.id, {
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
      makeIdentityProvider,
    }) => {
      const user = await makeUser({ email: "no-idtoken@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      // Create SSO provider with role mapping
      await makeIdentityProvider(org.id, {
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
      makeIdentityProvider,
    }) => {
      const user = await makeUser({ email: "no-mapping@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      // Create SSO provider WITHOUT role mapping
      await makeIdentityProvider(org.id, { providerId: "keycloak-no-mapping" });

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
      makeIdentityProvider,
    }) => {
      const user = await makeUser({ email: "demote@example.com" });
      const org = await makeOrganization();
      // Start with admin role
      await makeMember(user.id, org.id, { role: "admin" });

      // Create SSO provider with a rule that explicitly resolves the
      // user's groups to "member" — only an explicit rule match should
      // mutate an existing membership's role.
      await makeIdentityProvider(org.id, {
        providerId: "keycloak-demote",
        roleMapping: {
          rules: [
            {
              expression: '{{#includes groups "users"}}true{{/includes}}',
              role: "member",
            },
          ],
        } as unknown as Record<string, unknown>,
      });

      const idToken = createMockIdToken({
        sub: user.id,
        email: user.email,
        groups: ["users"],
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
      makeIdentityProvider,
    }) => {
      const user = await makeUser({ email: "already-correct@example.com" });
      const org = await makeOrganization();
      // Start with admin role (already correct)
      const initialMember = await makeMember(user.id, org.id, {
        role: "admin",
      });

      // Create SSO provider that maps admins to admin
      await makeIdentityProvider(org.id, {
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
      makeIdentityProvider,
    }) => {
      const user = await makeUser({ email: "strict-mode@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      // Create SSO provider with strictMode enabled
      await makeIdentityProvider(org.id, {
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
      makeIdentityProvider,
    }) => {
      const user = await makeUser({ email: "strict-mode-match@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      // Create SSO provider with strictMode enabled
      await makeIdentityProvider(org.id, {
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

    test("uses the callback provider account for role sync when multiple SSO accounts exist", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeAccount,
      makeIdentityProvider,
    }) => {
      const user = await makeUser({ email: "role-multi-sso@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      await makeIdentityProvider(org.id, {
        providerId: "keycloak-role-target",
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
      await makeIdentityProvider(org.id, {
        providerId: "keycloak-role-stale",
        roleMapping: {
          defaultRole: "member",
          rules: [
            {
              expression: '{{#includes groups "wrong-group"}}true{{/includes}}',
              role: "admin",
            },
          ],
        } as unknown as Record<string, unknown>,
      });

      await makeAccount(user.id, {
        providerId: "keycloak-role-stale",
        idToken: createMockIdToken({
          sub: user.id,
          email: user.email,
          groups: ["wrong-group"],
        }),
      });
      await makeAccount(user.id, {
        providerId: "keycloak-role-target",
        idToken: createMockIdToken({
          sub: user.id,
          email: user.email,
          groups: ["admins"],
        }),
      });

      const ctx = createMockContext({
        path: "/sso/callback/:providerId",
        method: "GET",
        requestUrl:
          "http://localhost:3000/api/auth/sso/callback/keycloak-role-target?code=test",
        body: {},
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: { id: "test-session-id", activeOrganizationId: org.id },
          },
        },
      });

      await handleAfterHook(ctx);

      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member?.role).toBe("admin");
    });
  });
});

describe("auth event audit logging", () => {
  // Let each fire-and-forget audit write settle before querying the DB.
  async function waitForAuditWrite() {
    await new Promise((r) => setTimeout(r, 50));
  }

  test("sign-in produces one audit row with action=auth.signed_in", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser({ email: "audit-signin@example.com" });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "member" });

    const ctx = createMockContext({
      path: "/sign-in/email",
      method: "POST",
      body: {},
      context: {
        newSession: {
          user: { id: user.id, email: user.email },
          session: { id: "sess-signin-audit", activeOrganizationId: org.id },
        },
      },
    });

    await handleAfterHook(ctx);
    await waitForAuditWrite();

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 10,
      offset: 0,
    });

    const auditRows = data.filter((r) => r.action === "auth.signed_in");
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe("auth.signed_in");
    expect(auditRows[0].resourceType).toBe("auth");
    expect(auditRows[0].actorId).toBe(user.id);
    expect(auditRows[0].actorType).toBe("user");
    expect(auditRows[0].outcome).toBe("success");
    expect(auditRows[0].organizationId).toBe(org.id);
    expect(auditRows[0].httpMethod).toBe("POST");
    expect(auditRows[0].actorEmail).toBe(user.email);
    expect(auditRows[0].after).toMatchObject({
      sessionId: "sess-signin-audit",
    });
    expect(auditRows[0].before).toBeNull();
    expect(auditRows[0].occurredAt).toBeInstanceOf(Date);
    expect(auditRows[0].requestId).toBeNull();
  });

  test("sign-out produces one audit row with action=auth.signed_out", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser({ email: "audit-signout@example.com" });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "member" });

    const ctx = createMockContext({
      path: "/sign-out",
      method: "POST",
      body: {},
      context: {
        session: {
          user: { id: user.id, email: user.email },
          session: { id: "sess-signout-audit", activeOrganizationId: org.id },
        },
      },
    });

    await handleAfterHook(ctx);
    await waitForAuditWrite();

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 20,
      offset: 0,
    });

    const rows = data.filter((r) => r.action === "auth.signed_out");
    expect(rows).toHaveLength(1);
    expect(rows[0].resourceType).toBe("auth");
    expect(rows[0].actorId).toBe(user.id);
    expect(rows[0].actorType).toBe("user");
    expect(rows[0].outcome).toBe("success");
    expect(rows[0].httpMethod).toBe("POST");
    expect(rows[0].after).toMatchObject({
      sessionId: "sess-signout-audit",
      ended: true,
    });
    expect(rows[0].before).toBeNull();
    expect(rows[0].occurredAt).toBeInstanceOf(Date);
    expect(rows[0].requestId).toBeNull();
  });

  test("sign-out with /api/auth/sign-out path uses pre-hook session stash when after hook has no session", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser({
      email: "audit-signout-prefixed@example.com",
    });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "member" });

    const request = new Request("http://localhost:3000/api/auth/sign-out", {
      method: "POST",
    });

    const sessionBundle = {
      user: { id: user.id, email: user.email, name: "A" },
      session: { id: "sess-stash-audit", activeOrganizationId: org.id },
    };

    await handleBeforeHook(
      createMockContext({
        path: "/api/auth/sign-out",
        method: "POST",
        body: {},
        request,
        context: { session: sessionBundle },
      }),
    );

    await handleAfterHook(
      createMockContext({
        path: "/api/auth/sign-out",
        method: "POST",
        body: {},
        request,
        context: { session: undefined },
      }),
    );
    await waitForAuditWrite();

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 20,
      offset: 0,
    });

    const rows = data.filter((r) => r.action === "auth.signed_out");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find((r) => r.actorId === user.id);
    expect(row?.after).toMatchObject({
      sessionId: "sess-stash-audit",
      ended: true,
    });
  });

  test("SSO callback produces one audit row with action=auth.sso_callback and actor_type=sso", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeAccount,
    makeIdentityProvider,
  }) => {
    const user = await makeUser({ email: "audit-sso@example.com" });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "member" });
    await makeIdentityProvider(org.id, { providerId: "audit-idp" });
    await makeAccount(user.id, { providerId: "audit-idp" });

    const ctx = createMockContext({
      path: "/sso/callback/audit-idp",
      method: "GET",
      body: {},
      context: {
        newSession: {
          user: { id: user.id, email: user.email },
          session: { id: "sess-sso-audit", activeOrganizationId: org.id },
        },
      },
    });

    await handleAfterHook(ctx);
    await waitForAuditWrite();

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 10,
      offset: 0,
    });

    const auditRows = data.filter((r) => r.action === "auth.sso_callback");
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe("auth.sso_callback");
    expect(auditRows[0].resourceType).toBe("auth");
    expect(auditRows[0].actorId).toBe(user.id);
    expect(auditRows[0].actorType).toBe("sso");
    expect(auditRows[0].outcome).toBe("success");
    expect(auditRows[0].httpMethod).toBe("POST");
    expect(auditRows[0].after).toMatchObject({
      sessionId: "sess-sso-audit",
      providerId: "audit-idp",
    });
    expect(auditRows[0].occurredAt).toBeInstanceOf(Date);
    expect(auditRows[0].requestId).toBeNull();
  });

  test("sign-up with valid invitation produces one audit row with action=auth.signed_up", async ({
    makeUser,
    makeOrganization,
    makeInvitation,
  }) => {
    const acceptSpy = vi.spyOn(InvitationModel, "accept");
    const inviter = await makeUser({ email: "audit-inviter@example.com" });
    const newUser = await makeUser({ email: "audit-signup-user@example.com" });
    const org = await makeOrganization();
    const invitation = await makeInvitation(org.id, inviter.id, {
      email: "audit-signup-user@example.com",
      status: "pending",
    });

    const ctx = createMockContext({
      path: "/sign-up/email",
      method: "POST",
      body: {
        callbackURL: "/chat",
        invitationId: invitation.id,
      },
      context: {
        newSession: {
          user: { id: newUser.id, email: newUser.email },
          session: { id: "sess-signup-audit", activeOrganizationId: null },
        },
      },
    });

    await handleAfterHook(ctx);
    await waitForAuditWrite();

    expect(acceptSpy).toHaveBeenCalledTimes(1);
    acceptSpy.mockRestore();

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 10,
      offset: 0,
    });

    const auditRows = data.filter((r) => r.action === "auth.signed_up");
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe("auth.signed_up");
    expect(auditRows[0].resourceType).toBe("auth");
    expect(auditRows[0].actorId).toBe(newUser.id);
    expect(auditRows[0].actorType).toBe("user");
    expect(auditRows[0].outcome).toBe("success");
    expect(auditRows[0].organizationId).toBe(org.id);
    expect(auditRows[0].httpMethod).toBe("POST");
    expect(auditRows[0].actorEmail).toBe(newUser.email);
    expect(auditRows[0].after).toEqual({
      sessionId: "sess-signup-audit",
      userId: newUser.id,
    });
    expect(auditRows[0].before).toBeNull();
    expect(auditRows[0].occurredAt).toBeInstanceOf(Date);
    expect(auditRows[0].requestId).toBeNull();
  });

  test("sign-in with no newSession (failed auth) produces zero rows", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const ctx = createMockContext({
      path: "/sign-in/email",
      method: "POST",
      body: {},
      context: {
        newSession: null,
      },
    });

    await handleAfterHook(ctx);
    await waitForAuditWrite();

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 10,
      offset: 0,
    });

    expect(data).toHaveLength(0);
  });

  test("sign-out with no session context falls back to header-based lookup", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser({
      email: "audit-signout-fallback@example.com",
    });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "member" });

    // Mock auth.api.getSession to simulate successful header-based resolution
    const getSessionSpy = vi
      .spyOn(auth.api, "getSession")
      .mockResolvedValueOnce({
        user: { id: user.id, email: user.email },
        session: { id: "sess-signout-fallback", activeOrganizationId: org.id },
      } as unknown as NonNullable<
        Awaited<ReturnType<typeof auth.api.getSession>>
      >);

    const ctx = createMockContext({
      path: "/sign-out",
      method: "POST",
      body: {},
      context: {
        session: null, // Triggers fallback
      },
    });

    await handleAfterHook(ctx);
    await waitForAuditWrite();

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 10,
      offset: 0,
    });

    expect(data).toHaveLength(1);
    expect(data[0].action).toBe("auth.signed_out");
    expect(data[0].actorId).toBe(user.id);
    expect(getSessionSpy).toHaveBeenCalled();

    getSessionSpy.mockRestore();
  });

  test("AuditLogModel.create rejection does not affect auth response", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser({ email: "audit-failure@example.com" });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "member" });

    const createSpy = vi
      .spyOn(AuditLogModel, "create")
      .mockRejectedValueOnce(new Error("DB write failed"));

    const ctx = createMockContext({
      path: "/sign-in/email",
      method: "POST",
      body: {},
      context: {
        newSession: {
          user: { id: user.id, email: user.email },
          session: { id: "sess-failure-audit", activeOrganizationId: org.id },
        },
      },
    });

    // The hook must not throw despite the audit write failing
    await expect(handleAfterHook(ctx)).resolves.not.toThrow();

    await waitForAuditWrite();
    // logErrorFn is the module-level mock for logger.error — verify it was called.
    expect(logErrorFn).toHaveBeenCalled();
    createSpy.mockRestore();
  });

  describe("resolveAuthClientIp — x-archestra-client-ip preferred, x-forwarded-for as fallback", () => {
    // Typed loosely on purpose — the fixture types are not exported and we
    // only need their runtime contracts here.
    async function captureIp(
      // biome-ignore lint/suspicious/noExplicitAny: test helper uses fixture functions inferred at call site
      makeUser: any,
      // biome-ignore lint/suspicious/noExplicitAny: test helper uses fixture functions inferred at call site
      makeOrganization: any,
      // biome-ignore lint/suspicious/noExplicitAny: test helper uses fixture functions inferred at call site
      makeMember: any,
      headers: Record<string, string>,
    ): Promise<string | null | undefined> {
      const user = await makeUser({
        email: `ip-${crypto.randomUUID()}@example.com`,
      });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "member" });

      const request = new Request("http://localhost/sign-in/email", {
        method: "POST",
        headers,
      });

      const ctx = createMockContext({
        path: "/sign-in/email",
        method: "POST",
        body: {},
        request,
        context: {
          newSession: {
            user: { id: user.id, email: user.email },
            session: {
              id: `sess-${crypto.randomUUID()}`,
              activeOrganizationId: org.id,
            },
          },
        },
      });

      await handleAfterHook(ctx);
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: org.id,
        limit: 1,
        offset: 0,
      });
      return data[0]?.sourceIp;
    }

    test("records x-archestra-client-ip when set (the Fastify-injected, server-controlled header)", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const ip = await captureIp(makeUser, makeOrganization, makeMember, {
        "x-archestra-client-ip": "127.0.0.1",
      });
      expect(ip).toBe("127.0.0.1");
    });

    test("falls back to x-forwarded-for when x-archestra-client-ip is absent", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      // x-forwarded-for is used as a fallback for environments where
      // socket.remoteAddress is unavailable or ARCHESTRA_TRUST_PROXY has not
      // been configured. The value is informational — not used for access
      // control — so recording it is better than recording null.
      const ip = await captureIp(makeUser, makeOrganization, makeMember, {
        "x-forwarded-for": "203.0.113.10",
      });
      expect(ip).toBe("203.0.113.10");
    });

    test("client-supplied x-forwarded-for never wins over the server-set header", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const ip = await captureIp(makeUser, makeOrganization, makeMember, {
        "x-forwarded-for": "203.0.113.10",
        "x-real-ip": "198.51.100.5",
        "cf-connecting-ip": "198.51.100.7",
        "x-archestra-client-ip": "127.0.0.1",
      });
      expect(ip).toBe("127.0.0.1");
    });

    test("returns null when no IP header is present", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const ip = await captureIp(makeUser, makeOrganization, makeMember, {});
      expect(ip ?? null).toBeNull();
    });
  });

  test("direct sign-up (no invitationId) still writes a sign_up audit row", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const acceptSpy = vi.spyOn(InvitationModel, "accept");
    const user = await makeUser({ email: "audit-direct-signup@example.com" });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "member" });

    // Body has no invitationId — covers the "InvitationModel.accept gated by
    // invitationId presence" branch added in the post-Phase-11 cleanup.
    const ctx = createMockContext({
      path: "/sign-up/email",
      method: "POST",
      body: {},
      context: {
        newSession: {
          user: { id: user.id, email: user.email },
          session: {
            id: "sess-direct-signup",
            activeOrganizationId: org.id,
          },
        },
      },
    });

    await handleAfterHook(ctx);
    await new Promise((r) => setTimeout(r, 50));

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 10,
      offset: 0,
    });

    const rows = data.filter((r) => r.action === "auth.signed_up");
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(user.id);
    expect(rows[0].actorType).toBe("user");
    expect(rows[0].outcome).toBe("success");
    expect(rows[0].resourceType).toBe("auth");
    expect(rows[0].httpMethod).toBe("POST");
    expect(acceptSpy).not.toHaveBeenCalled();
    acceptSpy.mockRestore();
  });

  test("invite-member produces audit row with action=invitation.created", async ({
    makeUser,
    makeOrganization,
    makeInvitation,
  }) => {
    const admin = await makeUser({ email: "invite-audit-admin@example.com" });
    const org = await makeOrganization();
    const invitation = await makeInvitation(org.id, admin.id, {
      email: "invite-audit-new@example.com",
      status: "pending",
      role: "member",
    });

    // Mock getSession so the afterHook can resolve the actor
    const getSessionSpy = vi
      .spyOn(auth.api, "getSession")
      .mockResolvedValueOnce({
        user: { id: admin.id, email: admin.email, name: admin.name },
        session: { id: "sess-invite-audit", activeOrganizationId: org.id },
      } as unknown as NonNullable<
        Awaited<ReturnType<typeof auth.api.getSession>>
      >);

    const ctx = createMockContext({
      path: "/organization/invite-member",
      method: "POST",
      body: {
        email: "invite-audit-new@example.com",
        role: "member",
        organizationId: org.id,
      },
      request: new Request(
        "http://localhost/api/auth/organization/invite-member",
        {
          method: "POST",
        },
      ),
    });

    await handleAfterHook(ctx);
    await waitForAuditWrite();
    getSessionSpy.mockRestore();

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 10,
      offset: 0,
    });

    const rows = data.filter(
      (r) =>
        r.resourceType === "invitation" && r.action === "invitation.created",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(admin.id);
    expect(rows[0].actorType).toBe("user");
    expect(rows[0].outcome).toBe("success");
    expect(rows[0].resourceId).toBe(invitation.id);
    expect(rows[0].after).toMatchObject({
      email: "invite-audit-new@example.com",
      role: "member",
    });
    expect(rows[0].before).toBeNull();
    expect(rows[0].occurredAt).toBeInstanceOf(Date);
    expect(rows[0].requestId).toBeNull();
  });

  test("invite-member picks the most recent pending invitation when stale rows exist for the same email", async ({
    makeUser,
    makeOrganization,
    makeInvitation,
  }) => {
    const admin = await makeUser({ email: "stale-audit-admin@example.com" });
    const org = await makeOrganization();
    // Older invitation that has since been canceled — must NOT be picked.
    const stale = await makeInvitation(org.id, admin.id, {
      email: "stale-audit-user@example.com",
      status: "canceled",
      role: "member",
    });
    // The freshly-created pending invitation — what the audit row should point at.
    const fresh = await makeInvitation(org.id, admin.id, {
      email: "stale-audit-user@example.com",
      status: "pending",
      role: "editor",
    });

    const getSessionSpy = vi
      .spyOn(auth.api, "getSession")
      .mockResolvedValueOnce({
        user: { id: admin.id, email: admin.email, name: admin.name },
        session: { id: "sess-stale-audit", activeOrganizationId: org.id },
      } as unknown as NonNullable<
        Awaited<ReturnType<typeof auth.api.getSession>>
      >);

    const ctx = createMockContext({
      path: "/organization/invite-member",
      method: "POST",
      body: {
        email: "stale-audit-user@example.com",
        role: "editor",
        organizationId: org.id,
      },
      request: new Request(
        "http://localhost/api/auth/organization/invite-member",
        { method: "POST" },
      ),
    });

    await handleAfterHook(ctx);
    await waitForAuditWrite();
    getSessionSpy.mockRestore();

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 10,
      offset: 0,
    });

    const rows = data.filter(
      (r) =>
        r.resourceType === "invitation" && r.action === "invitation.created",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].resourceId).toBe(fresh.id);
    expect(rows[0].resourceId).not.toBe(stale.id);
  });

  test("cancel-invitation produces audit row with action=invitation.deleted", async ({
    makeUser,
    makeOrganization,
    makeInvitation,
  }) => {
    const admin = await makeUser({ email: "cancel-audit-admin@example.com" });
    const org = await makeOrganization();
    const invitation = await makeInvitation(org.id, admin.id, {
      email: "cancel-audit-user@example.com",
      status: "pending",
      role: "editor",
    });

    const getSessionSpy = vi
      .spyOn(auth.api, "getSession")
      .mockResolvedValueOnce({
        user: { id: admin.id, email: admin.email, name: admin.name },
        session: { id: "sess-cancel-audit", activeOrganizationId: org.id },
      } as unknown as NonNullable<
        Awaited<ReturnType<typeof auth.api.getSession>>
      >);

    const ctx = createMockContext({
      path: "/organization/cancel-invitation",
      method: "POST",
      body: { invitationId: invitation.id },
      request: new Request(
        "http://localhost/api/auth/organization/cancel-invitation",
        {
          method: "POST",
        },
      ),
    });

    await handleAfterHook(ctx);
    await waitForAuditWrite();
    getSessionSpy.mockRestore();

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 10,
      offset: 0,
    });

    const rows = data.filter(
      (r) =>
        r.resourceType === "invitation" && r.action === "invitation.deleted",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(admin.id);
    expect(rows[0].actorType).toBe("user");
    expect(rows[0].outcome).toBe("success");
    expect(rows[0].resourceId).toBe(invitation.id);
    expect(rows[0].before).toMatchObject({
      email: "cancel-audit-user@example.com",
      role: "editor",
      status: "pending",
    });
    expect(rows[0].after).toBeNull();
    expect(rows[0].occurredAt).toBeInstanceOf(Date);
    expect(rows[0].requestId).toBeNull();
  });

  test("accept-invitation produces audit row with action=member.created", async ({
    makeUser,
    makeOrganization,
    makeInvitation,
  }) => {
    const inviter = await makeUser({
      email: "accept-audit-inviter@example.com",
    });
    const joiner = await makeUser({ email: "accept-audit-joiner@example.com" });
    const org = await makeOrganization();
    const invitation = await makeInvitation(org.id, inviter.id, {
      email: "accept-audit-joiner@example.com",
      status: "pending",
      role: "editor",
    });

    const getSessionSpy = vi
      .spyOn(auth.api, "getSession")
      .mockResolvedValueOnce({
        user: { id: joiner.id, email: joiner.email, name: joiner.name },
        session: { id: "sess-accept-audit", activeOrganizationId: org.id },
      } as unknown as NonNullable<
        Awaited<ReturnType<typeof auth.api.getSession>>
      >);

    const ctx = createMockContext({
      path: "/organization/accept-invitation",
      method: "POST",
      body: { invitationId: invitation.id },
      request: new Request(
        "http://localhost/api/auth/organization/accept-invitation",
        {
          method: "POST",
        },
      ),
    });

    await handleAfterHook(ctx);
    await waitForAuditWrite();
    getSessionSpy.mockRestore();

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 10,
      offset: 0,
    });

    const rows = data.filter(
      (r) => r.resourceType === "member" && r.action === "member.created",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(joiner.id);
    expect(rows[0].actorType).toBe("user");
    expect(rows[0].outcome).toBe("success");
    expect(rows[0].resourceId).toBe(invitation.id);
    expect(rows[0].after).toMatchObject({
      email: "accept-audit-joiner@example.com",
      role: "editor",
      invitationId: invitation.id,
    });
    expect(rows[0].before).toBeNull();
    expect(rows[0].occurredAt).toBeInstanceOf(Date);
    expect(rows[0].requestId).toBeNull();
  });

  test("update-member role produces audit row with before and after", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const admin = await makeUser({ email: "role-audit-admin@example.com" });
    const target = await makeUser({ email: "role-audit-target@example.com" });
    const org = await makeOrganization();
    await makeMember(admin.id, org.id, { role: "admin" });
    const member = await makeMember(target.id, org.id, { role: "member" });

    // Stash prior role in the WeakMap via beforeHook
    const beforeRequest = new Request(
      "http://localhost/api/auth/organization/update-member",
      { method: "POST" },
    );
    await handleBeforeHook(
      createMockContext({
        path: "/organization/update-member",
        method: "POST",
        body: { memberId: member.id, role: "editor" },
        request: beforeRequest,
      }),
    );

    const getSessionSpy = vi
      .spyOn(auth.api, "getSession")
      .mockResolvedValueOnce({
        user: { id: admin.id, email: admin.email, name: admin.name },
        session: { id: "sess-role-audit", activeOrganizationId: org.id },
      } as unknown as NonNullable<
        Awaited<ReturnType<typeof auth.api.getSession>>
      >);

    const afterCtx = createMockContext({
      path: "/organization/update-member",
      method: "POST",
      body: { memberId: member.id, role: "editor" },
      request: beforeRequest,
    });

    await handleAfterHook(afterCtx);
    await waitForAuditWrite();
    getSessionSpy.mockRestore();

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 10,
      offset: 0,
    });

    const rows = data.filter(
      (r) => r.resourceType === "member" && r.action === "member.role_updated",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(admin.id);
    expect(rows[0].actorType).toBe("user");
    expect(rows[0].outcome).toBe("success");
    expect(rows[0].resourceId).toBe(member.id);
    expect(rows[0].before).toMatchObject({ role: "member" });
    expect(rows[0].after).toMatchObject({ role: "editor" });
    expect(rows[0].occurredAt).toBeInstanceOf(Date);
    expect(rows[0].requestId).toBeNull();
  });

  test("update-member with unchanged role produces no audit row", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const admin = await makeUser({ email: "role-noop-admin@example.com" });
    const target = await makeUser({ email: "role-noop-target@example.com" });
    const org = await makeOrganization();
    const member = await makeMember(target.id, org.id, { role: "member" });

    const beforeRequest = new Request(
      "http://localhost/api/auth/organization/update-member",
      { method: "POST" },
    );
    await handleBeforeHook(
      createMockContext({
        path: "/organization/update-member",
        method: "POST",
        body: { memberId: member.id, role: "member" },
        request: beforeRequest,
      }),
    );

    const getSessionSpy = vi
      .spyOn(auth.api, "getSession")
      .mockResolvedValueOnce({
        user: { id: admin.id, email: admin.email, name: admin.name },
        session: { id: "sess-role-noop", activeOrganizationId: org.id },
      } as unknown as NonNullable<
        Awaited<ReturnType<typeof auth.api.getSession>>
      >);

    await handleAfterHook(
      createMockContext({
        path: "/organization/update-member",
        method: "POST",
        body: { memberId: member.id, role: "member" },
        request: beforeRequest,
      }),
    );
    await waitForAuditWrite();
    getSessionSpy.mockRestore();

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 10,
      offset: 0,
    });
    expect(
      data.filter(
        (r) =>
          r.resourceType === "member" && r.action === "member.role_updated",
      ),
    ).toHaveLength(0);
  });

  test("remove-member produces audit row with email/name/role in before", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const admin = await makeUser({ email: "remove-audit-admin@example.com" });
    const target = await makeUser({
      email: "remove-audit-target@example.com",
      name: "Target User",
    });
    const org = await makeOrganization();
    await makeMember(admin.id, org.id, { role: "admin" });
    const member = await makeMember(target.id, org.id, { role: "editor" });

    const beforeRequest = new Request(
      "http://localhost/api/auth/organization/remove-member",
      { method: "POST" },
    );

    await handleBeforeHook(
      createMockContext({
        path: "/organization/remove-member",
        method: "POST",
        body: { memberIdOrEmail: member.id },
        request: beforeRequest,
      }),
    );

    const getSessionSpy = vi
      .spyOn(auth.api, "getSession")
      .mockResolvedValueOnce({
        user: { id: admin.id, email: admin.email, name: admin.name },
        session: { id: "sess-remove-audit", activeOrganizationId: org.id },
      } as unknown as NonNullable<
        Awaited<ReturnType<typeof auth.api.getSession>>
      >);

    await handleAfterHook(
      createMockContext({
        path: "/organization/remove-member",
        method: "POST",
        body: { memberIdOrEmail: member.id },
        request: beforeRequest,
      }),
    );
    await waitForAuditWrite();
    getSessionSpy.mockRestore();

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 10,
      offset: 0,
    });

    const rows = data.filter(
      (r) => r.resourceType === "member" && r.action === "member.deleted",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(admin.id);
    expect(rows[0].actorType).toBe("user");
    expect(rows[0].outcome).toBe("success");
    expect(rows[0].resourceId).toBe(member.id);
    expect(rows[0].before).toMatchObject({
      email: target.email,
      name: target.name,
      role: "editor",
    });
    expect(rows[0].after).toBeNull();
    expect(rows[0].occurredAt).toBeInstanceOf(Date);
    expect(rows[0].requestId).toBeNull();
  });

  test("remove-member by email address produces audit row", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const admin = await makeUser({ email: "remove-email-admin@example.com" });
    const target = await makeUser({ email: "remove-email-target@example.com" });
    const org = await makeOrganization();
    await makeMember(admin.id, org.id, { role: "admin" });
    const member = await makeMember(target.id, org.id, { role: "member" });

    const beforeRequest = new Request(
      "http://localhost/api/auth/organization/remove-member",
      { method: "POST" },
    );

    // Pass email instead of member ID — same code path as ID-based lookup
    await handleBeforeHook(
      createMockContext({
        path: "/organization/remove-member",
        method: "POST",
        body: { memberIdOrEmail: target.email },
        request: beforeRequest,
      }),
    );

    const getSessionSpy = vi
      .spyOn(auth.api, "getSession")
      .mockResolvedValueOnce({
        user: { id: admin.id, email: admin.email, name: admin.name },
        session: { id: "sess-remove-email", activeOrganizationId: org.id },
      } as unknown as NonNullable<
        Awaited<ReturnType<typeof auth.api.getSession>>
      >);

    await handleAfterHook(
      createMockContext({
        path: "/organization/remove-member",
        method: "POST",
        body: { memberIdOrEmail: target.email },
        request: beforeRequest,
      }),
    );
    await waitForAuditWrite();
    getSessionSpy.mockRestore();

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 10,
      offset: 0,
    });

    const rows = data.filter(
      (r) => r.resourceType === "member" && r.action === "member.deleted",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].resourceId).toBe(member.id);
    expect(rows[0].before).toMatchObject({
      email: target.email,
      role: "member",
    });
  });

  test("sign-in for user with no membership falls back to primary org lookup", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser({ email: "audit-fallback-org@example.com" });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "member" });

    // Session has no activeOrganizationId — triggers MemberModel fallback
    const ctx = createMockContext({
      path: "/sign-in/email",
      method: "POST",
      body: {},
      context: {
        newSession: {
          user: { id: user.id, email: user.email },
          session: { id: "sess-fallback-audit", activeOrganizationId: null },
        },
      },
    });

    await handleAfterHook(ctx);
    await waitForAuditWrite();

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 10,
      offset: 0,
    });

    const auditRows = data.filter((r) => r.action === "auth.signed_in");
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].organizationId).toBe(org.id);
  });
});
