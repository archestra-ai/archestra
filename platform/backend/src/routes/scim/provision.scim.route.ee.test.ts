import { asc, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { enterpriseTier } from "@/enterprise-tier";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { AccountModel, MemberModel, TeamModel, UserModel } from "@/models";
import SessionModel from "@/models/session";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("SCIM /api/scim/v2/Users", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let admin: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { organizationId, user: admin });
    });
    const { default: scimRoutes } = await import("./scim.routes.ee");
    await app.register(scimRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("a pushed user can join a team before signing in and keeps it after the first SSO sign-in", async ({
    makeTeam,
    makeAccount,
  }) => {
    const created = await createUser("Ada.Lovelace@example.com");
    expect(created.statusCode, created.body).toBe(201);
    const user = created.json();
    expect(user).toMatchObject({
      userName: "ada.lovelace@example.com",
      displayName: "Ada Lovelace",
      active: true,
    });

    // A member who has not signed up: no account, no invitation link, and
    // marked as created by SCIM.
    expect(await AccountModel.getByUserId(user.id)).toBeUndefined();
    expect(
      (await UserModel.findByEmail("ada.lovelace@example.com"))
        ?.scimProvisioned,
    ).toBeInstanceOf(Date);
    expect(await MemberModel.getByUserId(user.id, organizationId)).toBeTruthy();

    // The identity provider finds the user by userName.
    const found = await app.inject({
      method: "GET",
      url: `/api/scim/v2/Users?filter=${encodeURIComponent('userName eq "ada.lovelace@example.com"')}`,
    });
    expect(found.json()).toMatchObject({
      totalResults: 1,
      Resources: [{ id: user.id }],
    });

    // Infrastructure as code puts the user in a team before any sign-in.
    const team = await makeTeam(organizationId, admin.id);
    await TeamModel.addMember(team.id, user.id);

    // First SSO sign-in: Better Auth links the IdP account onto the user with
    // the same email, then IdP team sync runs with the user's groups.
    await makeAccount(user.id, { providerId: "entra" });
    await TeamModel.syncUserTeams({
      userId: user.id,
      organizationId,
      ssoGroups: [],
    });

    expect((await UserModel.findByEmail("ada.lovelace@example.com"))?.id).toBe(
      user.id,
    );
    expect(await TeamModel.isUserInTeam(team.id, user.id)).toBe(true);
  });

  test("pushing the same userName twice is a conflict", async () => {
    expect((await createUser("grace@example.com")).statusCode).toBe(201);
    expect((await createUser("grace@example.com")).statusCode).toBe(409);
  });

  test("Entra-style deactivation soft-deletes the user and keeps their teams; activation restores them", async ({
    makeTeam,
  }) => {
    const user = (await createUser("alan@example.com")).json();
    const team = await makeTeam(organizationId, admin.id);
    await TeamModel.addMember(team.id, user.id);

    const deactivated = await patchActive(user.id, "False");
    expect(deactivated.statusCode, deactivated.body).toBe(200);
    expect(deactivated.json().active).toBe(false);
    expect(await UserModel.getSoftDeleted(user.id)).toBeInstanceOf(Date);
    expect(await MemberModel.getByUserId(user.id, organizationId)).toBeTruthy();
    expect(await TeamModel.isUserInTeam(team.id, user.id)).toBe(true);

    const fetched = await app.inject({
      method: "GET",
      url: `/api/scim/v2/Users/${user.id}`,
    });
    expect(fetched.json().active).toBe(false);

    const restored = await patchActive(user.id, "True");
    expect(restored.json().active).toBe(true);
    expect(await UserModel.getSoftDeleted(user.id)).toBeNull();
  });

  test("deleting a user who has signed in soft-deletes them and ends their sessions", async ({
    makeAccount,
  }) => {
    const user = (await createUser("barbara@example.com")).json();
    await makeAccount(user.id, { providerId: "entra" });
    await SessionModel.create({
      id: crypto.randomUUID(),
      userId: user.id,
      token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Sent with a SCIM content type and no body, as identity providers may.
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/scim/v2/Users/${user.id}`,
      headers: { "content-type": "application/scim+json" },
    });

    expect(deleted.statusCode).toBe(204);
    expect(await UserModel.getSoftDeleted(user.id)).toBeInstanceOf(Date);
    expect(await SessionModel.getByUserId(user.id)).toEqual([]);
    expect(await MemberModel.getByUserId(user.id, organizationId)).toBeTruthy();
  });

  test("records pushes and real active changes in the audit log, and skips calls that change nothing", async () => {
    registerAuditLogHook(app);
    const user = (await createUser("audited@example.com")).json();

    // Entra re-sends names on every cycle: nothing changes, nothing recorded.
    await app.inject({
      method: "PATCH",
      url: `/api/scim/v2/Users/${user.id}`,
      headers: { "content-type": "application/scim+json" },
      payload: JSON.stringify({
        Operations: [{ op: "Add", path: "name.givenName", value: "Audited" }],
      }),
    });
    await patchActive(user.id, "False");
    // Deleting a user who is already soft-deleted changes nothing either.
    await app.inject({
      method: "DELETE",
      url: `/api/scim/v2/Users/${user.id}`,
    });
    await patchActive(user.id, "True");
    await app.inject({
      method: "DELETE",
      url: `/api/scim/v2/Users/${user.id}`,
    });

    const audits = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, user.id))
      .orderBy(asc(schema.auditLogsTable.createdAt));
    expect(audits.map((audit) => audit.action)).toEqual([
      "member.created",
      "member.provisioning_updated",
      "member.provisioning_updated",
      "member.soft_deleted",
    ]);
    expect(audits[1]).toMatchObject({
      before: { softDeleted: null },
      after: { softDeleted: expect.any(String) },
    });
    expect(audits[2]).toMatchObject({
      before: { softDeleted: expect.any(String) },
      after: { softDeleted: null },
    });
  });

  test("is refused without an enterprise license", async () => {
    const spy = vi.spyOn(enterpriseTier, "isCoreActive").mockReturnValue(false);
    try {
      const response = await createUser("unlicensed@example.com");
      expect(response.statusCode).toBe(403);
      expect(
        await UserModel.findByEmail("unlicensed@example.com"),
      ).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  test("a changed userName fixes a user who has not signed in, and nobody else", async ({
    makeAccount,
  }) => {
    const pending = (await createUser("jdoe@example.com")).json();
    const signedIn = (await createUser("asmith@example.com")).json();
    await makeAccount(signedIn.id, { providerId: "entra" });
    await createUser("taken@example.com");
    const replaceUserName = (userId: string, value: string) =>
      app.inject({
        method: "PATCH",
        url: `/api/scim/v2/Users/${userId}`,
        headers: { "content-type": "application/scim+json" },
        payload: JSON.stringify({
          Operations: [{ op: "Replace", path: "userName", value }],
        }),
      });

    const fixed = await replaceUserName(pending.id, "John.Doe@example.com");
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect(fixed.json().userName).toBe("john.doe@example.com");

    // After the first sign-in, the sign-in keeps the email; SCIM leaves it.
    const ignored = await replaceUserName(
      signedIn.id,
      "alice.smith@example.com",
    );
    expect(ignored.json().userName).toBe("asmith@example.com");

    const clash = await replaceUserName(pending.id, "taken@example.com");
    expect(clash.statusCode).toBe(409);
  });

  test("filters other than userName eq are rejected", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/scim/v2/Users?filter=${encodeURIComponent('displayName co "Ada"')}`,
    });
    expect(response.statusCode).toBe(400);
  });

  function patchActive(userId: string, value: "True" | "False") {
    return app.inject({
      method: "PATCH",
      url: `/api/scim/v2/Users/${userId}`,
      headers: { "content-type": "application/scim+json" },
      payload: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "Replace", path: "active", value }],
      }),
    });
  }

  function createUser(userName: string) {
    return app.inject({
      method: "POST",
      url: "/api/scim/v2/Users",
      headers: { "content-type": "application/scim+json" },
      payload: JSON.stringify({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName,
        name: { givenName: "Ada", familyName: "Lovelace" },
        displayName: "Ada Lovelace",
        active: true,
      }),
    });
  }
});
