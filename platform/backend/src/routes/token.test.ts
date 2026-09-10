import type { Permissions } from "@archestra/shared";
import { vi } from "vitest";
import { hasPermission } from "@/auth";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import TeamTokenModel from "@/models/team-token";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import tokenRoutes from "./token";

vi.mock("@/auth");

describe("shared token route authorization", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let teamId: string;
  let granted: Permissions;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeTeamMember,
    }) => {
      const org = await makeOrganization();
      organizationId = org.id;
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const team = await makeTeam(org.id, user.id);
      teamId = team.id;
      await makeTeamMember(team.id, user.id, { role: "admin" });
      granted = {};
      vi.mocked(hasPermission).mockImplementation(async (required) => ({
        success: Object.entries(required).every(([resource, actions]) =>
          actions.every((action) =>
            granted[resource as keyof Permissions]?.includes(action),
          ),
        ),
        error: null,
      }));
      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        request.organizationId = org.id;
        request.user = user;
      });
      registerAuditLogHook(app);
      await app.register(tokenRoutes);
    },
  );
  afterEach(async () => {
    await app.close();
  });

  test("team membership administration exposes metadata but never the bearer credential", async () => {
    const { token, value } = await TeamTokenModel.createTeamToken(
      teamId,
      "Team automation",
    );
    const listing = await app.inject({ method: "GET", url: "/api/tokens" });
    expect(listing.statusCode, listing.body).toBe(200);
    expect(
      listing.json().tokens.map((entry: { id: string }) => entry.id),
    ).toContain(token.id);
    expect(listing.json().permissions.canAccessTeamTokens).toBe(false);
    expect(listing.body).not.toContain(value);
    const denied = await app.inject({
      method: "GET",
      url: `/api/tokens/${token.id}/value`,
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.body).not.toContain(value);
  });

  test("organization team management does not authorize reading or rotating team credentials", async () => {
    granted = { team: ["read", "create", "update", "delete"] };
    const { token, value } = await TeamTokenModel.createTeamToken(
      teamId,
      "Team automation",
    );
    for (const request of [
      { method: "GET" as const, url: `/api/tokens/${token.id}/value` },
      { method: "POST" as const, url: `/api/tokens/${token.id}/rotate` },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode, response.body).toBe(403);
    }
    expect(await TeamTokenModel.getTokenValue(token.id)).toBe(value);
  });

  test("explicit access-control authority can read and rotate a shared credential with a non-secret audit record", async () => {
    granted = { ac: ["update"] };
    const { token, value } = await TeamTokenModel.createTeamToken(
      teamId,
      "Team automation",
    );
    const read = await app.inject({
      method: "GET",
      url: `/api/tokens/${token.id}/value`,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().value).toBe(value);
    const rotated = await app.inject({
      method: "POST",
      url: `/api/tokens/${token.id}/rotate`,
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(rotated.json().value).not.toBe(value);
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: token.id,
      limit: 10,
      offset: 0,
    });
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "teamToken.rotated" }),
      ]),
    );
    expect(JSON.stringify(audit.data)).not.toContain(value);
    expect(JSON.stringify(audit.data)).not.toContain(rotated.json().value);
  });

  test("organization credentials require the same explicit authority", async () => {
    const { token } = await TeamTokenModel.createOrganizationToken();
    const denied = await app.inject({
      method: "GET",
      url: `/api/tokens/${token.id}/value`,
    });
    expect(denied.statusCode).toBe(403);
    granted = { ac: ["update"] };
    const allowed = await app.inject({
      method: "GET",
      url: `/api/tokens/${token.id}/value`,
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
  });
});
