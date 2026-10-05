import type { Permissions } from "@archestra/shared";
import { memberPermissions } from "@archestra/shared/access-control";
import { vi } from "vitest";
import { betterAuth } from "@/auth";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { MemberModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import TeamTokenModel from "@/models/team-token";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import tokenRoutes from "./token";

describe("shared token route authorization", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let teamId: string;
  let user: User;

  /** Moves the caller onto a role holding the member baseline plus `granted`. */
  async function grant(
    makeCustomRole: (
      organizationId: string,
      overrides: { permission: Permissions },
    ) => Promise<{ role: string }>,
    granted: Permissions,
  ) {
    const role = await makeCustomRole(organizationId, {
      permission: { ...memberPermissions, ...granted },
    });
    await MemberModel.updateRole(user.id, organizationId, role.role);
  }

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
      user = await makeUser();
      // A plain member holds neither ac:update nor team:update.
      await makeMember(user.id, org.id);
      const team = await makeTeam(org.id, user.id);
      teamId = team.id;
      await makeTeamMember(team.id, user.id, { role: "admin" });
      vi.spyOn(betterAuth.api, "getSession").mockImplementation(
        async () => ({ user: { id: user.id } }) as never,
      );
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
    vi.restoreAllMocks();
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

  test("organization team management does not authorize reading or rotating team credentials", async ({
    makeCustomRole,
  }) => {
    await grant(makeCustomRole, {
      team: ["read", "create", "update", "delete"],
    });
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

  test("explicit access-control authority can read and rotate a shared credential with a non-secret audit record", async ({
    makeCustomRole,
  }) => {
    await grant(makeCustomRole, { ac: ["update"] });
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

  test("organization credentials require the same explicit authority", async ({
    makeCustomRole,
  }) => {
    const { token } = await TeamTokenModel.createOrganizationToken();
    const denied = await app.inject({
      method: "GET",
      url: `/api/tokens/${token.id}/value`,
    });
    expect(denied.statusCode).toBe(403);
    await grant(makeCustomRole, { ac: ["update"] });
    const allowed = await app.inject({
      method: "GET",
      url: `/api/tokens/${token.id}/value`,
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  test("worksWithProfile follows the agent's grants to the token's team", async ({
    makeAgent,
  }) => {
    // Team-scoped by the retired field and assigned to the team, but the only
    // thing that counts is a grant on the agent to that team.
    const agent = await makeAgent({
      organizationId,
      agentType: "agent",
      access: { teams: [teamId] },
    });
    const { token } = await TeamTokenModel.createTeamToken(
      teamId,
      "Team automation",
    );
    const worksWith = async () =>
      (
        await app.inject({
          method: "GET",
          url: `/api/tokens?profileId=${agent.id}`,
        })
      )
        .json()
        .tokens.find((entry: { id: string }) => entry.id === token.id)
        ?.worksWithProfile;
    expect(await worksWith()).toBe(true);

    const key = { organizationId, resource: "agent" as const, scope: agent.id };
    const policy = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: (policy?.grants ?? []).filter(
        (grant) => grant.subject.type !== "team",
      ),
    });
    expect(await worksWith()).toBe(false);
  });
});
