import type { LightMyRequestResponse } from "fastify";
import { type Mock, vi } from "vitest";
import { autoProvisionUser } from "@/agents/chatops/auto-provision";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import ChatOpsUserAdmissionModel from "@/models/chatops-user-admission";
import UserModel from "@/models/user";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { SelectServiceAccount, User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

/**
 * GET /api/organization/members returns the users the caller is allowed to see:
 * the full roster with member:read, otherwise only the caller's teammates. The
 * route is open to any authenticated user, so the handler is the authorization
 * boundary — `hasPermission` is mocked to drive each branch.
 */
describe("GET /api/organization/members — visibility scope", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let currentUser: User;
  let currentServiceAccount: SelectServiceAccount | undefined;

  beforeEach(async ({ makeOrganization }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    currentServiceAccount = undefined;
    organizationId = (await makeOrganization()).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (
        request as typeof request & {
          serviceAccount: SelectServiceAccount | undefined;
        }
      ).serviceAccount = currentServiceAccount;
    });

    const { default: routes } = await import("./organization");
    await app.register(routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  function get() {
    return app.inject({ method: "GET", url: "/api/organization/members" });
  }

  test("explicit pending-user removal also removes an outstanding Teams admission", async ({
    makeUser,
    makeMember,
  }) => {
    currentUser = await makeUser({ email: "admin@example.com" });
    await makeMember(currentUser.id, organizationId, { role: "admin" });
    const pending = await autoProvisionUser({
      email: "pending@example.com",
      name: "Pending",
      provider: "ms-teams",
    });
    const admission = await ChatOpsUserAdmissionModel.acquire(
      "pending@example.com",
    );
    expect(admission?.admissionId).toBeTruthy();
    const response = await app.inject({
      method: "DELETE",
      url: `/api/organization/members/${pending.userId}/pending-signup`,
    });
    expect(response.statusCode).toBe(200);
    expect(await UserModel.getById(pending.userId)).toBeUndefined();
    expect(
      await db.select().from(schema.chatopsUserAdmissionsTable),
    ).toHaveLength(0);
  });

  test("caller without member:read sees only teammates, not the whole org", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const me = await makeUser({ name: "Me", email: "me@example.com" });
    const teammate = await makeUser({
      name: "Teammate",
      email: "teammate@example.com",
    });
    const stranger = await makeUser({
      name: "Stranger",
      email: "stranger@example.com",
    });
    await makeMember(me.id, organizationId, { role: "member" });
    await makeMember(teammate.id, organizationId, { role: "member" });
    await makeMember(stranger.id, organizationId, { role: "member" });

    const team = await makeTeam(organizationId, me.id);
    await makeTeamMember(team.id, me.id);
    await makeTeamMember(team.id, teammate.id);
    // stranger shares no team with me

    currentUser = me;
    mockHasPermission.mockResolvedValue({ success: false, error: null });

    const res = await get();

    expect(res.statusCode).toBe(200);
    const emails = (res.json() as Array<{ email: string }>).map((m) => m.email);
    expect(emails).toEqual(["teammate@example.com"]);
  });

  test("caller without member:read and no teams sees an empty list", async ({
    makeUser,
    makeMember,
  }) => {
    const me = await makeUser({ email: "loner@example.com" });
    const other = await makeUser({ email: "other@example.com" });
    await makeMember(me.id, organizationId, { role: "member" });
    await makeMember(other.id, organizationId, { role: "member" });

    currentUser = me;
    mockHasPermission.mockResolvedValue({ success: false, error: null });

    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  test("caller with member:read sees every organization member", async ({
    makeUser,
    makeMember,
  }) => {
    const me = await makeUser({ name: "Admin", email: "admin@example.com" });
    const other = await makeUser({ name: "Other", email: "other@example.com" });
    await makeMember(me.id, organizationId, { role: "admin" });
    await makeMember(other.id, organizationId, { role: "member" });

    currentUser = me;

    const res = await get();

    expect(res.statusCode).toBe(200);
    const emails = (res.json() as Array<{ email: string }>)
      .map((m) => m.email)
      .sort();
    expect(emails).toEqual(["admin@example.com", "other@example.com"]);
  });

  test("forwards the service account to the permission check so service accounts are not checked as the synthetic user", async ({
    makeUser,
    makeMember,
  }) => {
    // A service-account request: the middleware sets a synthetic user id
    // (service-account:<id>) that carries no member record, so member:read must
    // be evaluated against the service account itself. hasPermission checks its
    // serviceAccount arg before userContext, so the handler must forward it.
    const me = await makeUser({ email: "sa-caller@example.com" });
    await makeMember(me.id, organizationId, { role: "member" });
    currentUser = me;
    currentServiceAccount = {
      id: "svc-1",
      organizationId,
    } as unknown as SelectServiceAccount;

    await get();
    await app.inject({
      method: "GET",
      url: "/api/organization/member-options",
    });

    expect(mockHasPermission).toHaveBeenCalledWith(
      { member: ["read"] },
      expect.anything(),
      currentServiceAccount,
      { userId: me.id, organizationId },
    );
  });

  test("a non-member:read caller's teammates expose only identity fields, not roles", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const me = await makeUser({ name: "Me", email: "me@example.com" });
    const teammate = await makeUser({
      name: "Teammate",
      email: "teammate@example.com",
    });
    await makeMember(me.id, organizationId, { role: "member" });
    // Give the teammate a privileged role so a leak would be visible.
    await makeMember(teammate.id, organizationId, { role: "admin" });
    const team = await makeTeam(organizationId, me.id);
    await makeTeamMember(team.id, me.id);
    await makeTeamMember(team.id, teammate.id);

    currentUser = me;
    mockHasPermission.mockResolvedValue({ success: false, error: null });

    const res = await get();

    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(Object.keys(body[0]).sort()).toEqual(["email", "id", "name"]);
  });

  test("excludes a teammate whose only shared team is in another organization", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const orgB = (await makeOrganization()).id;

    const me = await makeUser({ email: "me@example.com" });
    const teammate = await makeUser({ email: "teammate@example.com" });
    const crossOrg = await makeUser({ email: "cross-org@example.com" });

    await makeMember(me.id, organizationId, { role: "member" });
    await makeMember(teammate.id, organizationId, { role: "member" });
    await makeMember(crossOrg.id, organizationId, { role: "member" });

    // Shared team in the caller's org: me + teammate.
    const teamHere = await makeTeam(organizationId, me.id);
    await makeTeamMember(teamHere.id, me.id);
    await makeTeamMember(teamHere.id, teammate.id);

    // Shared team in a different org: me + crossOrg. crossOrg is also a member
    // of the caller's org, so only org-scoped team lookup keeps them out.
    await makeMember(me.id, orgB, { role: "member" });
    await makeMember(crossOrg.id, orgB, { role: "member" });
    const teamElsewhere = await makeTeam(orgB, me.id);
    await makeTeamMember(teamElsewhere.id, me.id);
    await makeTeamMember(teamElsewhere.id, crossOrg.id);

    currentUser = me;
    mockHasPermission.mockResolvedValue({ success: false, error: null });

    const res = await get();

    expect(res.statusCode).toBe(200);
    const emails = (res.json() as Array<{ email: string }>).map((m) => m.email);
    expect(emails).toEqual(["teammate@example.com"]);
  });
  for (const canSeeAll of [true, false]) {
    test(`bounded options preserve directory visibility and cursor ties (all=${canSeeAll})`, async ({
      makeUser,
      makeMember,
      makeTeam,
      makeTeamMember,
      makeOrganization,
    }) => {
      currentUser = await makeUser({
        name: "Viewer",
        email: "viewer@example.com",
      });
      await makeMember(currentUser.id, organizationId);
      const team = await makeTeam(organizationId, currentUser.id);
      await makeTeamMember(team.id, currentUser.id);
      for (let index = 0; index < 5; index++) {
        const candidate = await makeUser({
          name: index < 3 ? "Same name" : `Candidate ${index}`,
          email: `candidate-${index}@example.com`,
        });
        await makeMember(candidate.id, organizationId);
        if (index < 4) await makeTeamMember(team.id, candidate.id);
      }
      const elsewhere = await makeOrganization();
      const foreign = await makeUser({
        name: "Foreign",
        email: "foreign@example.com",
      });
      await makeMember(foreign.id, elsewhere.id);
      mockHasPermission.mockResolvedValue({ success: canSeeAll, error: null });
      const expected = (await get()).json();
      const rows: Array<{ id: string; name: string; email: string }> = [];
      let cursor: string | null = null;
      do {
        const response: LightMyRequestResponse = await app.inject({
          method: "GET",
          url: `/api/organization/member-options?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        });
        expect(response.statusCode, response.body).toBe(200);
        const page = response.json();
        expect(page.data.length).toBeLessThanOrEqual(2);
        rows.push(...page.data);
        cursor = page.pagination.nextCursor;
      } while (cursor);
      expect(rows.map((row) => row.id).sort()).toEqual(
        expected.map((row: { id: string }) => row.id).sort(),
      );
      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
      for (const row of rows)
        expect(Object.keys(row).sort()).toEqual(["email", "id", "name"]);
    });
  }

  test("search and exact references stay organization- and teammate-scoped", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeOrganization,
  }) => {
    currentUser = await makeUser();
    await makeMember(currentUser.id, organizationId);
    const teammate = await makeUser({
      name: "Lovelace, Ada M.",
      email: "ada@example.com",
    });
    const privateUser = await makeUser({
      name: "Ada Private",
      email: "private@example.com",
    });
    await makeMember(teammate.id, organizationId);
    await makeMember(privateUser.id, organizationId);
    const team = await makeTeam(organizationId, currentUser.id);
    await makeTeamMember(team.id, currentUser.id);
    await makeTeamMember(team.id, teammate.id);
    const elsewhere = await makeOrganization();
    const other = await makeUser({
      name: "Ada Other",
      email: "other@example.com",
    });
    await makeMember(other.id, elsewhere.id);
    const sharedElsewhere = await makeTeam(elsewhere.id, currentUser.id);
    await makeTeamMember(sharedElsewhere.id, currentUser.id);
    await makeTeamMember(sharedElsewhere.id, other.id);
    mockHasPermission.mockResolvedValue({ success: false, error: null });
    for (const query of [
      "search=Ada%20Lovelace",
      `ids=${[teammate.id, privateUser.id, other.id].join(",")}`,
      "emails=ADA%40EXAMPLE.COM,private%40example.com,other%40example.com",
    ]) {
      const response: LightMyRequestResponse = await app.inject({
        method: "GET",
        url: `/api/organization/member-options?${query}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toEqual([
        { id: teammate.id, name: teammate.name, email: teammate.email },
      ]);
    }
    const emailSearch = await app.inject({
      method: "GET",
      url: "/api/organization/member-options?search=ada%40example.com&searchMode=name",
    });
    expect(emailSearch.json().data).toEqual([]);
    const invalidLimit = await app.inject({
      method: "GET",
      url: "/api/organization/member-options?limit=101",
    });
    expect(invalidLimit.statusCode).toBe(400);
  });
});
