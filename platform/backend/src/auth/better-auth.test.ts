import {
  ADMIN_ROLE_NAME,
  MEMBER_ROLE_NAME,
  type Permissions,
} from "@archestra/shared";
import { allAvailableActions } from "@archestra/shared/access-control";
import type { HookEndpointContext } from "@better-auth/core";
import { APIError } from "better-auth";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { cacheManager } from "@/cache-manager";
import type * as originalConfigModule from "@/config";
import { CREDENTIAL_PROVIDER_ID } from "@/constants";
import db, { schema } from "@/database";
import { enterpriseTier } from "@/enterprise-tier";

vi.mock("@/logging");

import logger from "@/logging";
import {
  AccountModel,
  MemberModel,
  SessionModel,
  TeamModel,
  UserModel,
} from "@/models";
import AuditLogModel from "@/models/audit-log";
import InvitationModel from "@/models/invitation";
import McpServerModel from "@/models/mcp-server";
import SecretModel from "@/models/secret";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";

// Create a hoisted ref to control disableInvitations in tests
const mockDisableInvitations = vi.hoisted(() => ({ value: false }));
const mockDisableImpersonation = vi.hoisted(() => ({ value: false }));
const mockDisableBasicAuth = vi.hoisted(() => ({ value: false }));

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
        get disableImpersonation() {
          return mockDisableImpersonation.value;
        },
        get disableBasicAuth() {
          return mockDisableBasicAuth.value;
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

  describe("basic auth disabled", () => {
    // Route names verified against better-auth 1.6.22. "/forget-password" is
    // deliberately not among them — it is not a route, only a rate-limiter
    // path entry, which is exactly the bug these tests exist to catch.
    const blockedPaths = [
      "/sign-in/email",
      "/sign-up/email",
      "/request-password-reset",
      "/reset-password",
      "/verify-password",
      "/change-password",
      "/admin/set-user-password",
    ];

    for (const path of blockedPaths) {
      test(`refuses ${path} while basic auth is disabled`, async () => {
        mockDisableBasicAuth.value = true;
        try {
          const ctx = createMockContext({ path, method: "POST", body: {} });

          await expect(handleBeforeHook(ctx)).rejects.toThrow(APIError);
          await expect(handleBeforeHook(ctx)).rejects.toMatchObject({
            body: { message: expect.stringContaining("identity provider") },
          });
        } finally {
          mockDisableBasicAuth.value = false;
        }
      });
    }

    test("still allows sign-out so a held session can always be ended", async () => {
      mockDisableBasicAuth.value = true;
      try {
        const ctx = createMockContext({
          path: "/sign-out",
          method: "POST",
          body: {},
        });

        await expect(handleBeforeHook(ctx)).resolves.not.toThrow();
      } finally {
        mockDisableBasicAuth.value = false;
      }
    });

    test("leaves password sign-in alone when the flag is off", async () => {
      const ctx = createMockContext({
        path: "/sign-in/email",
        method: "POST",
        body: { email: "someone@example.com", password: "irrelevant" },
      });

      await expect(handleBeforeHook(ctx)).resolves.not.toThrow();
    });
  });

  describe("two-factor enrollment enterprise gate", () => {
    test("refuses /two-factor/enable without an enterprise license", async () => {
      const spy = vi
        .spyOn(enterpriseTier, "isCoreActive")
        .mockReturnValue(false);
      try {
        const ctx = createMockContext({
          path: "/two-factor/enable",
          method: "POST",
          body: { password: "irrelevant" },
        });

        await expect(handleBeforeHook(ctx)).rejects.toThrow(APIError);
        await expect(handleBeforeHook(ctx)).rejects.toMatchObject({
          body: {
            message: expect.stringContaining("enterprise feature"),
          },
        });
      } finally {
        spy.mockRestore();
      }
    });

    test("allows /two-factor/enable when the license is active", async () => {
      const spy = vi
        .spyOn(enterpriseTier, "isCoreActive")
        .mockReturnValue(true);
      try {
        const ctx = createMockContext({
          path: "/two-factor/enable",
          method: "POST",
          body: { password: "irrelevant" },
        });

        const result = await handleBeforeHook(ctx);
        expect(result).toBe(ctx);
      } finally {
        spy.mockRestore();
      }
    });

    test("leaves verify/disable open so a lapsed license never locks users out", async () => {
      const spy = vi
        .spyOn(enterpriseTier, "isCoreActive")
        .mockReturnValue(false);
      try {
        for (const path of ["/two-factor/verify-totp", "/two-factor/disable"]) {
          const ctx = createMockContext({
            path,
            method: "POST",
            body: {},
          });
          const result = await handleBeforeHook(ctx);
          expect(result).toBe(ctx);
        }
      } finally {
        spy.mockRestore();
      }
    });
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

  describe("impersonation permission gate", () => {
    const impersonateCtx = (user: { id: string; email: string }) =>
      createMockContext({
        path: "/admin/impersonate-user",
        method: "POST",
        body: { userId: "some-target-user" },
        context: {
          session: {
            user,
            session: { id: "session-id" },
          },
        },
      });

    test("allows callers whose role grants member:impersonate", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const adminUser = await makeUser({ role: "admin" });
      await makeMember(adminUser.id, org.id, { role: ADMIN_ROLE_NAME });

      const ctx = impersonateCtx(adminUser);
      const result = await handleBeforeHook(ctx);
      expect(result).toBe(ctx);
    });

    test("throws FORBIDDEN when the caller's role lacks member:impersonate", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      // System-level admin (passes better-auth's own gate) whose org role
      // has broad member management but not member:impersonate.
      const restrictedAdmin = await makeUser({ role: "admin" });
      const customRole = await makeCustomRole(org.id, {
        permission: { member: ["read", "create", "update", "delete"] },
      });
      await makeMember(restrictedAdmin.id, org.id, { role: customRole.role });

      const ctx = impersonateCtx(restrictedAdmin);
      await expect(handleBeforeHook(ctx)).rejects.toThrow(APIError);
      await expect(handleBeforeHook(ctx)).rejects.toMatchObject({
        body: { message: "You do not have permission to impersonate users" },
      });
    });

    test("throws FORBIDDEN when the caller has no organization membership", async ({
      makeUser,
    }) => {
      const orphanUser = await makeUser({ role: "admin" });

      const ctx = impersonateCtx(orphanUser);
      await expect(handleBeforeHook(ctx)).rejects.toThrow(APIError);
    });

    test("leaves unauthenticated calls for better-auth to reject", async () => {
      const ctx = createMockContext({
        path: "/admin/impersonate-user",
        method: "POST",
        body: { userId: "some-target-user" },
      });

      const result = await handleBeforeHook(ctx);
      expect(result).toBe(ctx);
    });

    test("does not gate stop-impersonating", async () => {
      const ctx = createMockContext({
        path: "/admin/stop-impersonating",
        method: "POST",
      });

      const result = await handleBeforeHook(ctx);
      expect(result).toBe(ctx);
    });

    test("syncs the system-level user.role once the org RBAC gate passes", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      // Org admin promoted after bootstrap: no system-level role yet.
      const orgAdmin = await makeUser();
      await makeMember(orgAdmin.id, org.id, { role: ADMIN_ROLE_NAME });

      await handleBeforeHook(impersonateCtx(orgAdmin));

      const [row] = await db
        .select({ role: schema.usersTable.role })
        .from(schema.usersTable)
        .where(eq(schema.usersTable.id, orgAdmin.id));
      expect(row.role).toBe("admin");
    });

    test("records denied attempts in the audit log", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const plainMember = await makeUser();
      await makeMember(plainMember.id, org.id, { role: MEMBER_ROLE_NAME });

      await expect(
        handleBeforeHook(impersonateCtx(plainMember)),
      ).rejects.toThrow(APIError);

      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.organizationId, org.id));
      const denied = rows.find(
        (row) =>
          row.action === "auth.impersonation_started" &&
          row.outcome === "denied",
      );
      expect(denied).toBeDefined();
      expect(denied?.actorId).toBe(plainMember.id);
      expect(denied?.resourceId).toBe("some-target-user");
    });

    test("kill switch blocks impersonation and records the denial", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      mockDisableImpersonation.value = true;
      try {
        const org = await makeOrganization();
        const orgAdmin = await makeUser({ role: "admin" });
        await makeMember(orgAdmin.id, org.id, { role: ADMIN_ROLE_NAME });

        await expect(
          handleBeforeHook(impersonateCtx(orgAdmin)),
        ).rejects.toMatchObject({
          body: {
            message: "User impersonation is disabled on this deployment",
          },
        });

        const rows = await db
          .select()
          .from(schema.auditLogsTable)
          .where(eq(schema.auditLogsTable.organizationId, org.id));
        expect(
          rows.some(
            (row) =>
              row.action === "auth.impersonation_started" &&
              row.outcome === "denied",
          ),
        ).toBe(true);
      } finally {
        mockDisableImpersonation.value = false;
      }
    });

    test("kill switch never blocks stop-impersonating", async () => {
      mockDisableImpersonation.value = true;
      try {
        const ctx = createMockContext({
          path: "/admin/stop-impersonating",
          method: "POST",
        });
        const result = await handleBeforeHook(ctx);
        expect(result).toBe(ctx);
      } finally {
        mockDisableImpersonation.value = false;
      }
    });

    test("writes a success audit row once better-auth mints the impersonated session", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const orgAdmin = await makeUser({ role: "admin" });
      await makeMember(orgAdmin.id, org.id, { role: ADMIN_ROLE_NAME });
      const target = await makeUser();
      await makeMember(target.id, org.id, { role: MEMBER_ROLE_NAME });

      const request = new Request(
        "http://localhost/api/auth/admin/impersonate-user",
        { method: "POST" },
      );
      const beforeCtx = createMockContext({
        path: "/admin/impersonate-user",
        method: "POST",
        body: { userId: target.id },
        request,
        context: {
          session: {
            user: orgAdmin,
            session: { id: "session-id" },
          },
        },
      });
      await handleBeforeHook(beforeCtx);

      const afterCtx = createMockContext({
        path: "/admin/impersonate-user",
        method: "POST",
        body: { userId: target.id },
        request,
        context: {
          newSession: {
            user: { id: target.id, email: target.email },
            session: { id: "impersonated-session" },
          },
        },
      });
      await handleAfterHook(afterCtx);

      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.organizationId, org.id));
      const started = rows.find(
        (row) =>
          row.action === "auth.impersonation_started" &&
          row.outcome === "success",
      );
      expect(started).toBeDefined();
      expect(started?.actorId).toBe(orgAdmin.id);
      expect(started?.resourceId).toBe(target.id);
      expect(started?.after).toMatchObject({ targetUserId: target.id });
    });

    test("writes a stop audit row attributed to the impersonator", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const orgAdmin = await makeUser({ role: "admin" });
      await makeMember(orgAdmin.id, org.id, { role: ADMIN_ROLE_NAME });
      const target = await makeUser();
      await makeMember(target.id, org.id, { role: MEMBER_ROLE_NAME });

      const getSessionSpy = vi.spyOn(auth.api, "getSession").mockResolvedValue({
        user: { id: target.id, email: target.email, name: target.name },
        session: {
          id: "impersonated-session",
          impersonatedBy: orgAdmin.id,
          activeOrganizationId: org.id,
        },
      } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>);
      try {
        const request = new Request(
          "http://localhost/api/auth/admin/stop-impersonating",
          { method: "POST" },
        );
        const beforeCtx = createMockContext({
          path: "/admin/stop-impersonating",
          method: "POST",
          request,
        });
        await handleBeforeHook(beforeCtx);
        getSessionSpy.mockRestore();

        const afterCtx = createMockContext({
          path: "/admin/stop-impersonating",
          method: "POST",
          request,
        });
        await handleAfterHook(afterCtx);
      } finally {
        getSessionSpy.mockRestore();
      }

      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.organizationId, org.id));
      const stopped = rows.find(
        (row) => row.action === "auth.impersonation_stopped",
      );
      expect(stopped).toBeDefined();
      expect(stopped?.outcome).toBe("success");
      expect(stopped?.actorId).toBe(orgAdmin.id);
      expect(stopped?.resourceId).toBe(target.id);
    });
  });

  describe("admin endpoint org-RBAC gate", () => {
    const adminEndpointCtx = (
      user: { id: string; email: string },
      path = "/admin/list-users",
    ) =>
      createMockContext({
        path,
        method: "POST",
        body: {},
        context: {
          session: {
            user,
            session: { id: "session-id" },
          },
        },
      });

    test("allows callers with full member-management permissions", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const orgAdmin = await makeUser({ role: "admin" });
      await makeMember(orgAdmin.id, org.id, { role: ADMIN_ROLE_NAME });

      const ctx = adminEndpointCtx(orgAdmin);
      const result = await handleBeforeHook(ctx);
      expect(result).toBe(ctx);
    });

    test("blocks callers without member management even if user.role is admin", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      // The threat: a custom role granting only member:impersonate gets
      // user.role="admin" from the sync; better-auth alone would then let it
      // reach ban/set-role/remove-user.
      const impersonatorOnly = await makeUser({ role: "admin" });
      const customRole = await makeCustomRole(org.id, {
        permission: { member: ["read", "impersonate"] },
      });
      await makeMember(impersonatorOnly.id, org.id, {
        role: customRole.role,
      });

      await expect(
        handleBeforeHook(adminEndpointCtx(impersonatorOnly, "/admin/set-role")),
      ).rejects.toMatchObject({
        body: {
          message: "You do not have permission to use admin user management",
        },
      });
    });

    test("leaves unauthenticated admin-endpoint calls for better-auth", async () => {
      const ctx = createMockContext({
        path: "/admin/list-users",
        method: "POST",
        body: {},
      });
      const result = await handleBeforeHook(ctx);
      expect(result).toBe(ctx);
    });
  });

  describe("role-assignment no-escalation gate", () => {
    // The threat this closes: a deliberately-restricted admin role (all
    // permissions EXCEPT e.g. log:read/auditLog:read/member:impersonate,
    // but including member:update) must not be able to hand out — to
    // themselves or anyone — a role carrying the withheld permissions,
    // read what their own role withholds, and switch back.
    const restrictedAdminPermission = Object.fromEntries(
      Object.entries(allAvailableActions).map(([resource, actions]) => {
        if (resource === "log" || resource === "auditLog")
          return [resource, []];
        if (resource === "member")
          return [resource, actions.filter((a) => a !== "impersonate")];
        return [resource, actions];
      }),
    ) as Permissions;

    const updateMemberCtx = (
      user: { id: string; email: string } | null,
      role: string,
      memberId = "some-member-id",
    ) =>
      createMockContext({
        path: "/organization/update-member-role",
        method: "POST",
        body: { memberId, role },
        ...(user
          ? {
              context: {
                session: { user, session: { id: "session-id" } },
              },
            }
          : {}),
      });

    test("blocks a restricted admin assigning the admin role (to anyone, including themselves)", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      const restricted = await makeUser();
      const customRole = await makeCustomRole(org.id, {
        permission: restrictedAdminPermission,
      });
      await makeMember(restricted.id, org.id, { role: customRole.role });

      const ctx = updateMemberCtx(restricted, ADMIN_ROLE_NAME);
      await expect(handleBeforeHook(ctx)).rejects.toThrow(APIError);
      await expect(handleBeforeHook(ctx)).rejects.toMatchObject({
        body: {
          message: expect.stringContaining(
            "would grant permissions you don't have yourself",
          ),
        },
      });
      // The rejection names exactly what the caller's role withholds.
      await expect(handleBeforeHook(ctx)).rejects.toMatchObject({
        body: { message: expect.stringContaining("log:read") },
      });
    });

    test("blocks assigning a custom role that carries withheld permissions", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      const restricted = await makeUser();
      const restrictedRole = await makeCustomRole(org.id, {
        permission: restrictedAdminPermission,
      });
      await makeMember(restricted.id, org.id, { role: restrictedRole.role });
      const auditReader = await makeCustomRole(org.id, {
        permission: { auditLog: ["read"] },
      });

      const ctx = updateMemberCtx(restricted, auditReader.role);
      await expect(handleBeforeHook(ctx)).rejects.toThrow(APIError);
    });

    test("allows assignments within the caller's own permission set", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      const restricted = await makeUser();
      const customRole = await makeCustomRole(org.id, {
        permission: restrictedAdminPermission,
      });
      await makeMember(restricted.id, org.id, { role: customRole.role });

      // Downgrading someone to the predefined member role is fine…
      const downgrade = updateMemberCtx(restricted, MEMBER_ROLE_NAME);
      expect(await handleBeforeHook(downgrade)).toBe(downgrade);
      // …and so is assigning their own restricted role (exact subset).
      const lateral = updateMemberCtx(restricted, customRole.role);
      expect(await handleBeforeHook(lateral)).toBe(lateral);
    });

    test("a full admin can still assign any role — including editor, whose predefined set carries vestigial actions", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const adminUser = await makeUser({ role: "admin" });
      await makeMember(adminUser.id, org.id, { role: ADMIN_ROLE_NAME });

      // Editor's predefined set includes actions absent from
      // allAvailableActions (e.g. invitation:read); those grant nothing and
      // must not block assignment.
      for (const role of [ADMIN_ROLE_NAME, "editor", MEMBER_ROLE_NAME]) {
        const ctx = updateMemberCtx(adminUser, role);
        expect(await handleBeforeHook(ctx)).toBe(ctx);
      }
    });

    test("leaves unauthenticated and unknown-role calls for better-auth", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
    }) => {
      const unauthenticated = updateMemberCtx(null, ADMIN_ROLE_NAME);
      expect(await handleBeforeHook(unauthenticated)).toBe(unauthenticated);

      const org = await makeOrganization();
      const restricted = await makeUser();
      const customRole = await makeCustomRole(org.id, {
        permission: restrictedAdminPermission,
      });
      await makeMember(restricted.id, org.id, { role: customRole.role });
      const unknownRole = updateMemberCtx(restricted, "no_such_role");
      expect(await handleBeforeHook(unknownRole)).toBe(unknownRole);
    });

    test("a platform_admin cannot grant the full admin role — the customer-shaped restriction holds", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const platformAdmin = await makeUser();
      await makeMember(platformAdmin.id, org.id, { role: "platform_admin" });

      const escalate = updateMemberCtx(platformAdmin, ADMIN_ROLE_NAME);
      await expect(handleBeforeHook(escalate)).rejects.toThrow(APIError);
      await expect(handleBeforeHook(escalate)).rejects.toMatchObject({
        body: { message: expect.stringContaining("log:admin") },
      });

      // Managing users within their own permission set still works.
      const lateral = updateMemberCtx(platformAdmin, "platform_admin");
      expect(await handleBeforeHook(lateral)).toBe(lateral);
      const downgrade = updateMemberCtx(platformAdmin, MEMBER_ROLE_NAME);
      expect(await handleBeforeHook(downgrade)).toBe(downgrade);
    });

    test("blocks inviting a user into a role stronger than the inviter's", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
    }) => {
      const org = await makeOrganization();
      const restricted = await makeUser();
      const customRole = await makeCustomRole(org.id, {
        permission: restrictedAdminPermission,
      });
      await makeMember(restricted.id, org.id, { role: customRole.role });

      const inviteCtx = (role: string) =>
        createMockContext({
          path: "/organization/invite-member",
          method: "POST",
          body: { email: "new-user@example.com", role },
          context: {
            session: { user: restricted, session: { id: "session-id" } },
          },
        });

      await expect(
        handleBeforeHook(inviteCtx(ADMIN_ROLE_NAME)),
      ).rejects.toThrow(APIError);
      // Within the subset, the invitation passes through.
      const allowed = inviteCtx(MEMBER_ROLE_NAME);
      expect(await handleBeforeHook(allowed)).toBe(allowed);
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
      await makeAccount(user.id, { providerId: CREDENTIAL_PROVIDER_ID });
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

    // Providers with "Use for Single Sign-On" disabled exist only to supply
    // linked tokens for downstream MCP auth. Their connect flow runs the same
    // /sso/callback path as a login, and used to rewrite the user's role and
    // teams from downstream claims (e.g. demoting an admin to member because
    // the downstream IdP's role mapping matched).
    test("syncs role and teams through the SSO callback when the provider is used for SSO login", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeIdentityProvider,
      makeSession,
      makeAccount,
      makeTeam,
    }) => {
      const user = await makeUser({ email: "sso-sync-control@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "admin" });
      const team = await makeTeam(org.id, user.id, {
        name: "Engineering Sync Control",
      });
      await TeamModel.addExternalGroup(team.id, "engineering");

      const provider = await makeIdentityProvider(org.id, {
        providerId: "downstream-sync-enabled",
        domain: "example.com",
        roleMapping: {
          rules: [
            {
              expression: '{{#equals appRole "basic"}}true{{/equals}}',
              role: "member",
            },
          ],
        },
      });
      await makeAccount(user.id, {
        providerId: provider.providerId,
        idToken: createMockIdToken({
          email: user.email,
          appRole: "basic",
          groups: ["engineering"],
        }),
      });
      const session = await makeSession(user.id, {
        activeOrganizationId: org.id,
      });

      const ctx = createMockContext({
        path: `/sso/callback/${provider.providerId}`,
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

      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member?.role).toBe("member");
      const teams = await TeamModel.getUserTeams(user.id);
      expect(teams.map((t) => t.id)).toContain(team.id);
    });

    test("skips role and team sync through the SSO callback for linked-token-only providers", async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeIdentityProvider,
      makeSession,
      makeAccount,
      makeTeam,
    }) => {
      const user = await makeUser({ email: "sso-sync-linked@example.com" });
      const org = await makeOrganization();
      await makeMember(user.id, org.id, { role: "admin" });
      const team = await makeTeam(org.id, user.id, {
        name: "Engineering Sync Linked",
      });
      await TeamModel.addExternalGroup(team.id, "engineering");

      // Same demote-on-match mapping as the control test above, but the
      // provider is a linked-token-only downstream IdP.
      const provider = await makeIdentityProvider(org.id, {
        providerId: "downstream-sync-disabled",
        domain: "example.com",
        ssoLoginEnabled: false,
        roleMapping: {
          rules: [
            {
              expression: '{{#equals appRole "basic"}}true{{/equals}}',
              role: "member",
            },
          ],
        },
      });
      await makeAccount(user.id, {
        providerId: provider.providerId,
        idToken: createMockIdToken({
          email: user.email,
          appRole: "basic",
          groups: ["engineering"],
        }),
      });
      const session = await makeSession(user.id, {
        activeOrganizationId: org.id,
      });

      const ctx = createMockContext({
        path: `/sso/callback/${provider.providerId}`,
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

      // Connecting a linked-token-only provider must not change role or teams.
      const member = await MemberModel.getByUserId(user.id, org.id);
      expect(member?.role).toBe("admin");
      const teams = await TeamModel.getUserTeams(user.id);
      expect(teams.map((t) => t.id)).not.toContain(team.id);
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

    // Helper to set enterprise license config plus the user-count side of the
    // tier service so the effective gate matches the env-only intent of these
    // tests (small-team auto-enable would otherwise keep SSO on at userCount 0).
    function setEnterpriseLicense(value: boolean) {
      Object.defineProperty(config.enterpriseFeatures, "core", {
        value,
        writable: true,
        configurable: true,
      });
      enterpriseTier.setUserCountForTesting(value ? 0 : 9999);
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

describe("sign-out response body", () => {
  // Regression guard. better-auth serializes whatever an after-hook returns as
  // the HTTP response body. handleAfterHook used to `return ctx` on the
  // sign-out path, which turned the unauthenticated POST /sign-out 200 into a
  // ~168 KB dump of the entire internal AuthContext — including `secret`
  // (ARCHESTRA_AUTH_SECRET, which signs session cookies and encrypts stored
  // secrets). The sign-out body must stay the minimal `{ success: true }`.
  test("unauthenticated sign-out returns only { success: true } and never the auth secret", async () => {
    const req = new Request("http://localhost:3000/api/auth/sign-out", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({}),
    });

    const res = await auth.handler(req);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ success: true });

    const secret = process.env.ARCHESTRA_AUTH_SECRET as string;
    expect(secret.length).toBeGreaterThan(0);
    expect(text).not.toContain(secret);
    // Structural guard: catch any future full-context dump even if the secret
    // string itself changes. `internalAdapter` is an AuthContext-only key.
    expect(text).not.toContain("internalAdapter");
    expect(text.length).toBeLessThan(200);
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
    // Verify logger.error was called.
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
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
        path: "/organization/update-member-role",
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
      path: "/organization/update-member-role",
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
        path: "/organization/update-member-role",
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
        path: "/organization/update-member-role",
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
        body: { memberIdOrEmail: member.id, organizationId: org.id },
        request: beforeRequest,
      }),
    );

    // Simulate better-auth's own removal — the after-hook verifies the
    // membership is actually gone before treating the operation as a success.
    await MemberModel.deleteByMemberOrUserId(target.id, org.id);

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
        body: { memberIdOrEmail: member.id, organizationId: org.id },
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
        body: { memberIdOrEmail: target.email, organizationId: org.id },
        request: beforeRequest,
      }),
    );

    // Simulate better-auth's own removal — the after-hook verifies the
    // membership is actually gone before treating the operation as a success.
    await MemberModel.deleteByMemberOrUserId(target.id, org.id);

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
        body: { memberIdOrEmail: target.email, organizationId: org.id },
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

describe("membership removal cleanup", () => {
  // Cleanup runs inside the after-hook and is awaited there, but audit rows on
  // some paths are fire-and-forget — give them a beat before asserting.
  async function settle() {
    await new Promise((r) => setTimeout(r, 50));
  }

  async function makePersonalInstall(params: {
    ownerId: string;
    organizationId: string;
    makeInternalMcpCatalog: (
      overrides: Record<string, unknown>,
    ) => Promise<{ id: string }>;
    makeMcpServer: (
      overrides: Record<string, unknown>,
    ) => Promise<{ id: string }>;
  }) {
    const catalog = await params.makeInternalMcpCatalog({
      organizationId: params.organizationId,
      serverType: "remote",
    });
    const secret = await SecretModel.create({
      name: `cred-${crypto.randomUUID().substring(0, 8)}`,
      secret: { access_token: "at" },
    });
    const server = await params.makeMcpServer({
      ownerId: params.ownerId,
      scope: "personal",
      serverType: "remote",
      catalogId: catalog.id,
      secretId: secret.id,
    });
    return { server, secret };
  }

  test("remove-member purges the organization's personal installs but keeps a user with other memberships", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const admin = await makeUser();
    const target = await makeUser();
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    await makeMember(admin.id, orgA.id, { role: "admin" });
    const membership = await makeMember(target.id, orgA.id, { role: "member" });
    await makeMember(target.id, orgB.id, { role: "member" });

    const inA = await makePersonalInstall({
      ownerId: target.id,
      organizationId: orgA.id,
      makeInternalMcpCatalog,
      makeMcpServer,
    });
    const inB = await makePersonalInstall({
      ownerId: target.id,
      organizationId: orgB.id,
      makeInternalMcpCatalog,
      makeMcpServer,
    });

    const beforeRequest = new Request(
      "http://localhost/api/auth/organization/remove-member",
      { method: "POST" },
    );
    await handleBeforeHook(
      createMockContext({
        path: "/organization/remove-member",
        method: "POST",
        body: { memberIdOrEmail: membership.id, organizationId: orgA.id },
        request: beforeRequest,
      }),
    );

    // Simulate better-auth's own removal, which happens between the hooks.
    await MemberModel.deleteByMemberOrUserId(target.id, orgA.id);

    const getSessionSpy = vi
      .spyOn(auth.api, "getSession")
      .mockResolvedValueOnce({
        user: { id: admin.id, email: admin.email, name: admin.name },
        session: { id: "sess-cleanup-a", activeOrganizationId: orgA.id },
      } as unknown as NonNullable<
        Awaited<ReturnType<typeof auth.api.getSession>>
      >);
    await handleAfterHook(
      createMockContext({
        path: "/organization/remove-member",
        method: "POST",
        body: { memberIdOrEmail: membership.id, organizationId: orgA.id },
        request: beforeRequest,
      }),
    );
    await settle();
    getSessionSpy.mockRestore();

    // Org A residue is gone, credentials included.
    expect(await McpServerModel.findById(inA.server.id)).toBeNull();
    expect(await SecretModel.findById(inA.secret.id)).toBeNull();
    // The other organization's install — and the user — survive.
    expect(await McpServerModel.findById(inB.server.id)).not.toBeNull();
    const [userRow] = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, target.id));
    expect(userRow).toBeDefined();
  });

  test("removing the last membership deletes the user outright", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const admin = await makeUser();
    const target = await makeUser();
    const org = await makeOrganization();
    await makeMember(admin.id, org.id, { role: "admin" });
    const membership = await makeMember(target.id, org.id, { role: "member" });
    const install = await makePersonalInstall({
      ownerId: target.id,
      organizationId: org.id,
      makeInternalMcpCatalog,
      makeMcpServer,
    });

    const beforeRequest = new Request(
      "http://localhost/api/auth/organization/remove-member",
      { method: "POST" },
    );
    await handleBeforeHook(
      createMockContext({
        path: "/organization/remove-member",
        method: "POST",
        body: { memberIdOrEmail: membership.id, organizationId: org.id },
        request: beforeRequest,
      }),
    );
    await MemberModel.deleteByMemberOrUserId(target.id, org.id);
    const getSessionSpy = vi
      .spyOn(auth.api, "getSession")
      .mockResolvedValueOnce({
        user: { id: admin.id, email: admin.email, name: admin.name },
        session: { id: "sess-cleanup-b", activeOrganizationId: org.id },
      } as unknown as NonNullable<
        Awaited<ReturnType<typeof auth.api.getSession>>
      >);
    await handleAfterHook(
      createMockContext({
        path: "/organization/remove-member",
        method: "POST",
        body: { memberIdOrEmail: membership.id, organizationId: org.id },
        request: beforeRequest,
      }),
    );
    await settle();
    getSessionSpy.mockRestore();

    expect(await McpServerModel.findById(install.server.id)).toBeNull();
    expect(await SecretModel.findById(install.secret.id)).toBeNull();
    const [userRow] = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, target.id));
    expect(userRow).toBeUndefined();
  });

  test("a rejected removal purges nothing — the membership survives, so cleanup and audit are skipped", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const admin = await makeUser();
    const target = await makeUser();
    const org = await makeOrganization();
    await makeMember(admin.id, org.id, { role: "admin" });
    const membership = await makeMember(target.id, org.id, { role: "member" });
    const install = await makePersonalInstall({
      ownerId: target.id,
      organizationId: org.id,
      makeInternalMcpCatalog,
      makeMcpServer,
    });

    const beforeRequest = new Request(
      "http://localhost/api/auth/organization/remove-member",
      { method: "POST" },
    );
    await handleBeforeHook(
      createMockContext({
        path: "/organization/remove-member",
        method: "POST",
        body: { memberIdOrEmail: membership.id, organizationId: org.id },
        request: beforeRequest,
      }),
    );

    // No member deletion in between: better-auth rejected the operation, but
    // after-hooks still run on error responses — the hook must notice the
    // membership survived and do nothing.
    await handleAfterHook(
      createMockContext({
        path: "/organization/remove-member",
        method: "POST",
        body: { memberIdOrEmail: membership.id, organizationId: org.id },
        request: beforeRequest,
      }),
    );
    await settle();

    expect(await McpServerModel.findById(install.server.id)).not.toBeNull();
    expect(await SecretModel.findById(install.secret.id)).not.toBeNull();
    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 10,
      offset: 0,
    });
    expect(data.filter((r) => r.action === "member.deleted")).toHaveLength(0);
  });

  test("organization leave is audited and cleaned up like remove-member", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const leaver = await makeUser({ name: "Leaver" });
    const org = await makeOrganization();
    const membership = await makeMember(leaver.id, org.id, { role: "member" });
    const install = await makePersonalInstall({
      ownerId: leaver.id,
      organizationId: org.id,
      makeInternalMcpCatalog,
      makeMcpServer,
    });

    const beforeRequest = new Request(
      "http://localhost/api/auth/organization/leave",
      { method: "POST" },
    );
    // The before-hook resolves the leaver from their session.
    const getSessionSpy = vi
      .spyOn(auth.api, "getSession")
      .mockResolvedValueOnce({
        user: { id: leaver.id, email: leaver.email, name: leaver.name },
        session: { id: "sess-leave", activeOrganizationId: org.id },
      } as unknown as NonNullable<
        Awaited<ReturnType<typeof auth.api.getSession>>
      >);
    await handleBeforeHook(
      createMockContext({
        path: "/organization/leave",
        method: "POST",
        body: { organizationId: org.id },
        request: beforeRequest,
      }),
    );
    getSessionSpy.mockRestore();

    await MemberModel.deleteByMemberOrUserId(leaver.id, org.id);

    await handleAfterHook(
      createMockContext({
        path: "/organization/leave",
        method: "POST",
        body: { organizationId: org.id },
        request: beforeRequest,
      }),
    );
    await settle();

    const { data } = await AuditLogModel.findPaginated({
      organizationId: org.id,
      limit: 10,
      offset: 0,
    });
    const rows = data.filter(
      (r) => r.resourceType === "member" && r.action === "member.deleted",
    );
    expect(rows).toHaveLength(1);
    // The account deletion below set-nulls the actor FK; the snapshot columns
    // keep identifying who left.
    expect(rows[0].actorEmail).toBe(leaver.email);
    expect(rows[0].resourceId).toBe(membership.id);
    expect(rows[0].before).toMatchObject({
      email: leaver.email,
      role: "member",
    });

    expect(await McpServerModel.findById(install.server.id)).toBeNull();
    expect(await SecretModel.findById(install.secret.id)).toBeNull();
    // Last membership — the account itself is unreachable residue and goes too.
    const [userRow] = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, leaver.id));
    expect(userRow).toBeUndefined();
  });
});

describe("SSO account linking onto existing password users", () => {
  // Regression guard for instances that switch to SSO sign-in after users
  // already exist with email/password accounts. Archestra never sends
  // verification email, so those local users stay emailVerified=false
  // forever; without accountLinking.requireLocalEmailVerified: false,
  // better-auth refuses to implicitly link their first SSO login
  // (redirecting with error=account_not_linked), which permanently locks
  // them out once basic auth is disabled.
  const IDP_ORIGIN = "https://sso-idp.archestra-test.invalid";

  const mswServer = useMswServer();

  test("OIDC callback links onto an existing email/password user whose email was never verified", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeAccount,
    makeIdentityProvider,
  }) => {
    const user = await makeUser({
      email: "unverified-password-user@example.com",
      emailVerified: false,
    });
    const org = await makeOrganization();
    await makeMember(user.id, org.id, { role: "member" });
    await makeAccount(user.id, {
      providerId: CREDENTIAL_PROVIDER_ID,
      accountId: user.id,
    });

    const provider = await makeIdentityProvider(org.id, {
      providerId: "oidc-unverified-link",
      issuer: IDP_ORIGIN,
      domain: "example.com",
      oidcConfig: {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        authorizationEndpoint: `${IDP_ORIGIN}/authorize`,
        tokenEndpoint: `${IDP_ORIGIN}/token`,
        userInfoEndpoint: `${IDP_ORIGIN}/userinfo`,
        jwksEndpoint: `${IDP_ORIGIN}/jwks`,
        pkce: false,
      },
    });

    // Initiate SSO sign-in to mint the server-side state row and the signed
    // state cookie the callback validates.
    const signInResponse = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/sso", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          providerId: provider.providerId,
          callbackURL: "http://localhost:3000/chat",
        }),
      }),
    );
    expect(signInResponse.status).toBe(200);
    const { url: authorizationUrl } = (await signInResponse.json()) as {
      url: string;
    };
    const state = new URL(authorizationUrl).searchParams.get("state");
    expect(state).toBeTruthy();
    const stateCookies = signInResponse.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");

    // Fake the IdP: code exchange + userinfo with a verified email that
    // matches the existing local user.
    mswServer.use(
      http.post(`${IDP_ORIGIN}/token`, () =>
        HttpResponse.json({
          access_token: "sso-access-token",
          token_type: "Bearer",
        }),
      ),
      http.get(`${IDP_ORIGIN}/userinfo`, () =>
        HttpResponse.json({
          sub: "external-subject-1",
          email: user.email,
          email_verified: true,
          name: "Unverified Password User",
        }),
      ),
    );

    const callbackResponse = await auth.handler(
      new Request(
        `http://localhost:3000/api/auth/sso/callback/${provider.providerId}?code=fake-code&state=${state}`,
        { headers: { cookie: stateCookies } },
      ),
    );

    expect(callbackResponse.status).toBe(302);
    const location = callbackResponse.headers.get("location") ?? "";
    // Without requireLocalEmailVerified: false this redirect carries
    // ?error=account_not_linked instead of completing the sign-in.
    expect(location).not.toContain("error=");
    expect(location).toContain("http://localhost:3000/chat");

    // The SSO account is linked to the pre-existing user...
    const linkedAccounts = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.userId, user.id));
    const ssoAccount = linkedAccounts.find(
      (account) => account.providerId === provider.providerId,
    );
    expect(ssoAccount).toBeDefined();
    expect(ssoAccount?.accountId).toBe("external-subject-1");

    // ...a session was created for that user (not a duplicate user)...
    const [sessionRow] = await db
      .select()
      .from(schema.sessionsTable)
      .where(eq(schema.sessionsTable.userId, user.id));
    expect(sessionRow).toBeDefined();

    // ...and the verified IdP assertion flipped the local flag, so the
    // account self-heals on first SSO login.
    const [userRow] = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, user.id));
    expect(userRow.emailVerified).toBe(true);
  });
});
