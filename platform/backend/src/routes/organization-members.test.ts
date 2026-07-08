import { type Mock, vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
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
});
