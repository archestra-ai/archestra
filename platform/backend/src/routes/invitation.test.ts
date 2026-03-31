import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("invitation routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: invitationRoutes } = await import("./invitation");
    await app.register(invitationRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /api/invitation/:id/check", () => {
    test("returns invitation data and userExists=false for new email", async ({
      makeInvitation,
    }) => {
      const invitation = await makeInvitation(organizationId, user.id, {
        email: "new-user@example.com",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/invitation/${invitation.id}/check`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.invitation.id).toBe(invitation.id);
      expect(body.invitation.email).toBe("new-user@example.com");
      expect(body.invitation.organizationId).toBe(organizationId);
      expect(body.invitation.status).toBe("pending");
      expect(body.userExists).toBe(false);
    });

    test("returns userExists=true when email belongs to existing user", async ({
      makeInvitation,
    }) => {
      const invitation = await makeInvitation(organizationId, user.id, {
        email: user.email,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/invitation/${invitation.id}/check`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.invitation.id).toBe(invitation.id);
      expect(body.userExists).toBe(true);
    });

    test("returns 404 for non-existent invitation", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/invitation/00000000-0000-0000-0000-000000000000/check",
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error.message).toContain("Invitation not found");
    });

    test("returns 400 for already accepted invitation", async ({
      makeInvitation,
    }) => {
      const invitation = await makeInvitation(organizationId, user.id, {
        status: "accepted",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/invitation/${invitation.id}/check`,
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.message).toContain("already been accepted");
    });

    test("returns 400 for expired invitation", async ({ makeInvitation }) => {
      const invitation = await makeInvitation(organizationId, user.id, {
        expiresAt: new Date(Date.now() - 86400000), // expired yesterday
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/invitation/${invitation.id}/check`,
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.message).toContain("expired");
    });

    test("works with predefined editor role", async ({ makeInvitation }) => {
      const invitation = await makeInvitation(organizationId, user.id, {
        role: "editor",
        email: "editor-invite@example.com",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/invitation/${invitation.id}/check`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.invitation.id).toBe(invitation.id);
      expect(body.invitation.email).toBe("editor-invite@example.com");
      expect(body.userExists).toBe(false);
    });

    test("works with predefined admin role", async ({ makeInvitation }) => {
      const invitation = await makeInvitation(organizationId, user.id, {
        role: "admin",
        email: "admin-invite@example.com",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/invitation/${invitation.id}/check`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.invitation.id).toBe(invitation.id);
      expect(body.invitation.email).toBe("admin-invite@example.com");
      expect(body.userExists).toBe(false);
    });

    test("works with custom role", async ({
      makeInvitation,
      makeCustomRole,
    }) => {
      const customRole = await makeCustomRole(organizationId, {
        permission: { agent: ["read"], toolPolicy: ["read"] },
      });

      const invitation = await makeInvitation(organizationId, user.id, {
        role: customRole.role,
        email: "custom-role-invite@example.com",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/invitation/${invitation.id}/check`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.invitation.id).toBe(invitation.id);
      expect(body.invitation.email).toBe("custom-role-invite@example.com");
      expect(body.userExists).toBe(false);
    });
  });
});
