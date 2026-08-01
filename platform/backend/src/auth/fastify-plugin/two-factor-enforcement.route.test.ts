import { RouteId } from "@archestra/shared";
import { eq } from "drizzle-orm";
import { vi } from "vitest";

// @/auth is the external auth boundary: better-auth resolves the session
// cookie (a process boundary) and hasPermission is the access-control seam.
// Everything under test — the Authnz middleware, OrganizationModel,
// SessionModel — runs for real against PGlite.
vi.mock("@/auth");

import { betterAuth, hasPermission } from "@/auth";
import config from "@/config";
import db, { schema } from "@/database";
import { enterpriseTier } from "@/enterprise-tier";
import { OrganizationModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockedFunction,
  test,
} from "@/test";
import { AUTH_STATE_PATH } from "../../routes/route-paths";
import { authPlugin } from "./plugin";

const mockBetterAuth = betterAuth as unknown as {
  api: { getSession: MockedFunction<typeof betterAuth.api.getSession> };
};
const mockHasPermission = hasPermission as MockedFunction<typeof hasPermission>;

type Session = Awaited<ReturnType<typeof betterAuth.api.getSession>>;

/**
 * The middleware calls getSession with `returnHeaders: true`, so the resolved
 * value is `{ response, headers }`.
 */
const sessionResult = (session: unknown): Session =>
  ({ response: session, headers: new Headers() }) as unknown as Session;

/** A route that requires 2FA enforcement to let it through. */
const NON_EXEMPT_ROUTE = "/api/agents";
/** Routes the enrollment surface needs before the member can enroll. */
const EXEMPT_ROUTES = [
  { url: "/api/config", routeId: RouteId.GetConfig },
  { url: "/api/user/permissions", routeId: RouteId.GetUserPermissions },
  { url: "/api/organization", routeId: RouteId.GetOrganization },
  {
    url: "/api/organization/appearance-settings",
    routeId: RouteId.GetAppearanceSettings,
  },
] as const;

describe("two-factor / session-policy enforcement (route level)", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async () => {
    vi.restoreAllMocks();
    // Licensed by default: both policies are enterprise features.
    enterpriseTier.setUserCountForTesting(0);
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    app = createFastifyInstance();
    await app.register(authPlugin);
    // The real auth routes, so /api/auth-state is exercised as shipped.
    const { default: authRoutes } = await import("@/routes/auth");
    await app.register(authRoutes);
    app.get(
      NON_EXEMPT_ROUTE,
      { schema: { operationId: RouteId.GetAgents } },
      async () => ({ ok: true }),
    );
    for (const { url, routeId } of EXEMPT_ROUTES) {
      app.get(url, { schema: { operationId: routeId } }, async () => ({
        ok: true,
      }));
    }
    await app.ready();
  });

  afterEach(async () => {
    enterpriseTier.setUserCountForTesting(0);
    await app.close();
  });

  /** Signs the caller in as `user` with the given session row. */
  function authenticateAs(
    user: { id: string },
    session: { id: string; createdAt: Date | string },
  ) {
    mockBetterAuth.api.getSession.mockResolvedValue(
      sessionResult({ user: { id: user.id }, session }),
    );
  }

  async function setPolicies(
    organizationId: string,
    policies: {
      requireTwoFactor?: boolean;
      sessionMaxAgeSeconds?: number | null;
    },
  ) {
    await OrganizationModel.patch(organizationId, policies);
  }

  async function sessionExists(sessionId: string) {
    const [row] = await db
      .select({ id: schema.sessionsTable.id })
      .from(schema.sessionsTable)
      .where(eq(schema.sessionsTable.id, sessionId));
    return !!row;
  }

  describe("require two-factor", () => {
    test("refuses a non-enrolled member on a non-exempt route", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeSession,
    }) => {
      const org = await makeOrganization();
      await setPolicies(org.id, { requireTwoFactor: true });
      const user = await makeUser({ twoFactorEnabled: false });
      await makeMember(user.id, org.id, { role: "member" });
      const session = await makeSession(user.id, {
        activeOrganizationId: org.id,
      });
      authenticateAs(user, session);

      const response = await app.inject({
        method: "GET",
        url: NON_EXEMPT_ROUTE,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.internal_code).toBe(
        "two_factor_setup_required",
      );
    });

    test("lets a non-enrolled member reach every enrollment-surface route", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeSession,
    }) => {
      const org = await makeOrganization();
      await setPolicies(org.id, { requireTwoFactor: true });
      const user = await makeUser({ twoFactorEnabled: false });
      await makeMember(user.id, org.id, { role: "member" });
      const session = await makeSession(user.id, {
        activeOrganizationId: org.id,
      });
      authenticateAs(user, session);

      for (const { url } of EXEMPT_ROUTES) {
        const response = await app.inject({ method: "GET", url });
        expect(
          response.statusCode,
          `${url} must stay reachable so the member can enroll`,
        ).toBe(200);
      }
    });

    test("lets an enrolled member through", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeSession,
    }) => {
      const org = await makeOrganization();
      await setPolicies(org.id, { requireTwoFactor: true });
      const user = await makeUser({ twoFactorEnabled: true });
      await makeMember(user.id, org.id, { role: "member" });
      const session = await makeSession(user.id, {
        activeOrganizationId: org.id,
      });
      authenticateAs(user, session);

      const response = await app.inject({
        method: "GET",
        url: NON_EXEMPT_ROUTE,
      });

      expect(response.statusCode).toBe(200);
    });

    test("does not touch a non-enrolled member when the policy is off", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeSession,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser({ twoFactorEnabled: false });
      await makeMember(user.id, org.id, { role: "member" });
      const session = await makeSession(user.id, {
        activeOrganizationId: org.id,
      });
      authenticateAs(user, session);

      const response = await app.inject({
        method: "GET",
        url: NON_EXEMPT_ROUTE,
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe("maximum session lifetime", () => {
    test("revokes and rejects a session older than the cap", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeSession,
    }) => {
      const org = await makeOrganization();
      await setPolicies(org.id, { sessionMaxAgeSeconds: 3600 });
      const user = await makeUser({ twoFactorEnabled: true });
      await makeMember(user.id, org.id, { role: "member" });
      const session = await makeSession(user.id, {
        activeOrganizationId: org.id,
        createdAt: new Date(Date.now() - 7200 * 1000),
      });
      authenticateAs(user, session);

      const response = await app.inject({
        method: "GET",
        url: NON_EXEMPT_ROUTE,
      });

      expect(response.statusCode).toBe(401);
      // Revoked server-side, not merely refused: every replica must agree.
      expect(await sessionExists(session.id)).toBe(false);
    });

    test("leaves a session younger than the cap alone", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeSession,
    }) => {
      const org = await makeOrganization();
      await setPolicies(org.id, { sessionMaxAgeSeconds: 7200 });
      const user = await makeUser({ twoFactorEnabled: true });
      await makeMember(user.id, org.id, { role: "member" });
      const session = await makeSession(user.id, {
        activeOrganizationId: org.id,
        createdAt: new Date(Date.now() - 60 * 1000),
      });
      authenticateAs(user, session);

      const response = await app.inject({
        method: "GET",
        url: NON_EXEMPT_ROUTE,
      });

      expect(response.statusCode).toBe(200);
      expect(await sessionExists(session.id)).toBe(true);
    });

    test("enforces the cap when createdAt arrives as an ISO string", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeSession,
    }) => {
      // Regression: better-auth's 60s cookie cache hands back a
      // JSON-deserialized session, so createdAt is a string. Calling
      // .getTime() on it threw and 500ed every request.
      const org = await makeOrganization();
      await setPolicies(org.id, { sessionMaxAgeSeconds: 3600 });
      const user = await makeUser({ twoFactorEnabled: true });
      await makeMember(user.id, org.id, { role: "member" });
      const session = await makeSession(user.id, {
        activeOrganizationId: org.id,
        createdAt: new Date(Date.now() - 7200 * 1000),
      });
      authenticateAs(user, {
        id: session.id,
        createdAt: session.createdAt.toISOString(),
      });

      const response = await app.inject({
        method: "GET",
        url: NON_EXEMPT_ROUTE,
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("password-less (SSO-only) deployments", () => {
    test("does not enforce the requirement when email/password sign-in is off", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeSession,
    }) => {
      // A deployment that disabled basic auth after the requirement was set
      // would otherwise strand every member: enrolling needs a password.
      const org = await makeOrganization();
      await setPolicies(org.id, { requireTwoFactor: true });
      const user = await makeUser({ twoFactorEnabled: false });
      await makeMember(user.id, org.id, { role: "member" });
      const session = await makeSession(user.id, {
        activeOrganizationId: org.id,
      });
      authenticateAs(user, session);

      const original = config.auth.disableBasicAuth;
      Object.defineProperty(config.auth, "disableBasicAuth", {
        value: true,
        writable: true,
        configurable: true,
      });
      try {
        const response = await app.inject({
          method: "GET",
          url: NON_EXEMPT_ROUTE,
        });
        expect(response.statusCode).toBe(200);
      } finally {
        Object.defineProperty(config.auth, "disableBasicAuth", {
          value: original,
          writable: true,
          configurable: true,
        });
      }
    });
  });

  describe("enterprise licensing", () => {
    test("stops enforcing both policies when the license lapses", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeSession,
    }) => {
      const org = await makeOrganization();
      await setPolicies(org.id, {
        requireTwoFactor: true,
        sessionMaxAgeSeconds: 3600,
      });
      const user = await makeUser({ twoFactorEnabled: false });
      await makeMember(user.id, org.id, { role: "member" });
      const session = await makeSession(user.id, {
        activeOrganizationId: org.id,
        createdAt: new Date(Date.now() - 7200 * 1000),
      });
      authenticateAs(user, session);

      const originalEnvFlag = config.enterpriseFeatures.core;
      Object.defineProperty(config.enterpriseFeatures, "core", {
        value: false,
        writable: true,
        configurable: true,
      });
      enterpriseTier.setUserCountForTesting(9999);
      try {
        // Enrollment is refused without a license, so enforcing the
        // requirement would strand every non-enrolled member.
        const response = await app.inject({
          method: "GET",
          url: NON_EXEMPT_ROUTE,
        });
        expect(response.statusCode).toBe(200);
        expect(await sessionExists(session.id)).toBe(true);
      } finally {
        enterpriseTier.setUserCountForTesting(0);
        Object.defineProperty(config.enterpriseFeatures, "core", {
          value: originalEnvFlag,
          writable: true,
          configurable: true,
        });
      }
    });
  });

  describe("GET /api/auth-state", () => {
    test("is reachable with no session at all", async () => {
      mockBetterAuth.api.getSession.mockResolvedValue(sessionResult(null));

      const response = await app.inject({
        method: "GET",
        url: AUTH_STATE_PATH,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ twoFactorPending: false });
    });

    test("reports a pending challenge when the two-factor cookie is present", async () => {
      mockBetterAuth.api.getSession.mockResolvedValue(sessionResult(null));

      const response = await app.inject({
        method: "GET",
        url: AUTH_STATE_PATH,
        headers: {
          cookie: `other=1; ${config.auth.cookiePrefix}.two_factor=signed-value`,
        },
      });

      expect(response.json()).toEqual({ twoFactorPending: true });
    });

    test("also recognises the __Secure- prefixed cookie used on https", async () => {
      mockBetterAuth.api.getSession.mockResolvedValue(sessionResult(null));

      const response = await app.inject({
        method: "GET",
        url: AUTH_STATE_PATH,
        headers: {
          cookie: `__Secure-${config.auth.cookiePrefix}.two_factor=signed-value`,
        },
      });

      expect(response.json()).toEqual({ twoFactorPending: true });
    });

    test("ignores unrelated cookies and valueless segments", async () => {
      mockBetterAuth.api.getSession.mockResolvedValue(sessionResult(null));

      const response = await app.inject({
        method: "GET",
        url: AUTH_STATE_PATH,
        headers: { cookie: "flag; something.two_factor_other=1; a=b" },
      });

      expect(response.json()).toEqual({ twoFactorPending: false });
    });
  });
});
