import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import ServiceAccountModel from "@/models/service-account";
import { beforeEach, describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import {
  assertMcpCatalogTeams,
  authorizeMcpCatalogScope,
  type CatalogTeamAccess,
  getCatalogWriteMembershipTeamIds,
  getMcpCatalogPermissionChecker,
  requireMcpCatalogDeletePermission,
  requireMcpCatalogModifyPermission,
} from "./mcp-catalog-permissions";

describe("mcp-catalog-permissions", () => {
  let organizationId: string;

  beforeEach(async ({ makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
  });

  describe("getMcpCatalogPermissionChecker", () => {
    test("editor is not a catalog admin", async ({ makeUser, makeMember }) => {
      const user = await makeUser();
      await makeMember(user.id, organizationId, { role: EDITOR_ROLE_NAME });
      const checker = await getMcpCatalogPermissionChecker({
        userId: user.id,
        organizationId,
      });
      expect(checker).toEqual({ isAdmin: false });
    });

    test("admin is a catalog admin", async ({ makeUser, makeMember }) => {
      const user = await makeUser();
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      const checker = await getMcpCatalogPermissionChecker({
        userId: user.id,
        organizationId,
      });
      expect(checker).toEqual({ isAdmin: true });
    });

    test("member is not a catalog admin", async ({ makeUser, makeMember }) => {
      const user = await makeUser();
      await makeMember(user.id, organizationId, { role: MEMBER_ROLE_NAME });
      const checker = await getMcpCatalogPermissionChecker({
        userId: user.id,
        organizationId,
      });
      expect(checker).toEqual({ isAdmin: false });
    });

    test("resolves service-account permissions via synthetic user id", async () => {
      const sa = await ServiceAccountModel.create({
        organizationId,
        name: "ci-bot",
        role: EDITOR_ROLE_NAME,
      });
      const checker = await getMcpCatalogPermissionChecker({
        userId: `service-account:${sa.id}`,
        organizationId,
      });
      expect(checker).toEqual({ isAdmin: false });
    });
  });

  describe("getCatalogWriteMembershipTeamIds", () => {
    test("returns only the teams the user administers", async ({
      makeUser,
      makeTeam,
      makeTeamMember,
    }) => {
      const user = await makeUser();
      const adminTeam = await makeTeam(organizationId, user.id);
      const memberTeam = await makeTeam(organizationId, user.id);
      await makeTeamMember(adminTeam.id, user.id, { role: ADMIN_ROLE_NAME });
      await makeTeamMember(memberTeam.id, user.id, { role: MEMBER_ROLE_NAME });

      const writeTeamIds = await getCatalogWriteMembershipTeamIds(user.id);

      expect(writeTeamIds).toEqual([adminTeam.id]);
    });
  });

  describe("requireMcpCatalogModifyPermission", () => {
    const admin = { isAdmin: true };
    const nonAdmin = { isAdmin: false };
    const writeTeam: CatalogTeamAccess[] = [{ id: "t1", level: "write" }];
    const useTeam: CatalogTeamAccess[] = [{ id: "t1", level: "use" }];

    test("an admin of a write-level team may modify", () => {
      expect(() =>
        requireMcpCatalogModifyPermission({
          checker: nonAdmin,
          scope: "team",
          authorId: "author",
          catalogTeams: writeTeam,
          writeMembershipTeamIds: ["t1"],
          userId: "team-admin",
        }),
      ).not.toThrow();
    });

    test("an admin of a use-level team may not modify", () => {
      expect(() =>
        requireMcpCatalogModifyPermission({
          checker: nonAdmin,
          scope: "team",
          authorId: "author",
          catalogTeams: useTeam,
          writeMembershipTeamIds: ["t1"],
          userId: "team-admin",
        }),
      ).toThrow(ApiError);
    });

    test("a member (not admin) of a write-level team may not modify", () => {
      expect(() =>
        requireMcpCatalogModifyPermission({
          checker: nonAdmin,
          scope: "team",
          authorId: "author",
          catalogTeams: writeTeam,
          // membership alone yields no write teams
          writeMembershipTeamIds: [],
          userId: "plain-member",
        }),
      ).toThrow(ApiError);
    });

    test("write on one team suffices when another team is use-level", () => {
      expect(() =>
        requireMcpCatalogModifyPermission({
          checker: nonAdmin,
          scope: "team",
          authorId: "author",
          catalogTeams: [
            { id: "t1", level: "use" },
            { id: "t2", level: "write" },
          ],
          writeMembershipTeamIds: ["t2"],
          userId: "team-admin",
        }),
      ).not.toThrow();
    });

    test("authorship confers no write over a team-scoped item", () => {
      expect(() =>
        requireMcpCatalogModifyPermission({
          checker: nonAdmin,
          scope: "team",
          authorId: "author",
          catalogTeams: useTeam,
          writeMembershipTeamIds: [],
          userId: "author",
        }),
      ).toThrow(ApiError);
    });

    test("authorship confers no write over an org-scoped item", () => {
      expect(() =>
        requireMcpCatalogModifyPermission({
          checker: nonAdmin,
          scope: "org",
          authorId: "author",
          catalogTeams: [],
          writeMembershipTeamIds: [],
          userId: "author",
        }),
      ).toThrow(ApiError);
    });

    test("the author may modify their own personal item", () => {
      expect(() =>
        requireMcpCatalogModifyPermission({
          checker: nonAdmin,
          scope: "personal",
          authorId: "author",
          catalogTeams: [],
          writeMembershipTeamIds: [],
          userId: "author",
        }),
      ).not.toThrow();
    });

    test("a non-author may not modify a personal item", () => {
      expect(() =>
        requireMcpCatalogModifyPermission({
          checker: nonAdmin,
          scope: "personal",
          authorId: "author",
          catalogTeams: [],
          writeMembershipTeamIds: [],
          userId: "someone-else",
        }),
      ).toThrow(ApiError);
    });

    test("a non-admin may not modify an org item", () => {
      expect(() =>
        requireMcpCatalogModifyPermission({
          checker: nonAdmin,
          scope: "org",
          authorId: "author",
          catalogTeams: [],
          writeMembershipTeamIds: ["t1"],
          userId: "team-admin",
        }),
      ).toThrow(ApiError);
    });

    test("an admin bypasses every scope", () => {
      for (const scope of ["personal", "team", "org"] as const) {
        expect(() =>
          requireMcpCatalogModifyPermission({
            checker: admin,
            scope,
            authorId: "someone-else",
            catalogTeams: useTeam,
            writeMembershipTeamIds: [],
            userId: "admin",
          }),
        ).not.toThrow();
      }
    });

    test("an unknown scope is denied", () => {
      expect(() =>
        requireMcpCatalogModifyPermission({
          checker: nonAdmin,
          scope: "galaxy" as "team",
          authorId: "author",
          catalogTeams: [],
          writeMembershipTeamIds: [],
          userId: "someone-else",
        }),
      ).toThrow(ApiError);
    });
  });

  describe("requireMcpCatalogDeletePermission", () => {
    test("an admin of a write-level team may not delete", () => {
      expect(() =>
        requireMcpCatalogDeletePermission({
          checker: { isAdmin: false },
          scope: "team",
          authorId: "author",
          userId: "team-admin",
        }),
      ).toThrow(ApiError);
    });

    test("the author of a personal item may delete it", () => {
      expect(() =>
        requireMcpCatalogDeletePermission({
          checker: { isAdmin: false },
          scope: "personal",
          authorId: "author",
          userId: "author",
        }),
      ).not.toThrow();
    });

    test("the author of a team item may not delete it", () => {
      expect(() =>
        requireMcpCatalogDeletePermission({
          checker: { isAdmin: false },
          scope: "team",
          authorId: "author",
          userId: "author",
        }),
      ).toThrow(ApiError);
    });

    test("an admin may delete any item", () => {
      expect(() =>
        requireMcpCatalogDeletePermission({
          checker: { isAdmin: true },
          scope: "org",
          authorId: "someone-else",
          userId: "admin",
        }),
      ).not.toThrow();
    });
  });

  describe("authorizeMcpCatalogScope", () => {
    const nonAdmin = { isAdmin: false };
    const admin = { isAdmin: true };

    test("a team admin may share with a team they belong to", () => {
      expect(() =>
        authorizeMcpCatalogScope({
          checker: nonAdmin,
          scope: "team",
          authorId: "author",
          requestedTeamIds: ["t1"],
          userTeamIds: ["t1"],
          writeMembershipTeamIds: ["t1"],
          userId: "author",
        }),
      ).not.toThrow();
    });

    test("a team admin cannot share with a team they are not in", () => {
      expect(() =>
        authorizeMcpCatalogScope({
          checker: nonAdmin,
          scope: "team",
          authorId: "author",
          requestedTeamIds: ["t1", "t2"],
          userTeamIds: ["t1"],
          writeMembershipTeamIds: ["t1"],
          userId: "author",
        }),
      ).toThrow(/member of/i);
    });

    test("a plain member cannot share with their team", () => {
      expect(() =>
        authorizeMcpCatalogScope({
          checker: nonAdmin,
          scope: "team",
          authorId: "author",
          requestedTeamIds: ["t1"],
          userTeamIds: ["t1"],
          writeMembershipTeamIds: [],
          userId: "author",
        }),
      ).toThrow(ApiError);
    });

    test("authorship does not let a plain member publish to a team", () => {
      expect(() =>
        authorizeMcpCatalogScope({
          checker: nonAdmin,
          scope: "team",
          authorId: "author",
          requestedTeamIds: ["t1"],
          userTeamIds: ["t1"],
          writeMembershipTeamIds: [],
          userId: "author",
        }),
      ).toThrow(ApiError);
    });

    test("a non-admin cannot use org scope", () => {
      expect(() =>
        authorizeMcpCatalogScope({
          checker: nonAdmin,
          scope: "org",
          authorId: "author",
          requestedTeamIds: [],
          userTeamIds: [],
          writeMembershipTeamIds: ["t1"],
          userId: "author",
        }),
      ).toThrow(ApiError);
    });

    test("the author may keep an item personal", () => {
      expect(() =>
        authorizeMcpCatalogScope({
          checker: nonAdmin,
          scope: "personal",
          authorId: "author",
          requestedTeamIds: [],
          userTeamIds: [],
          writeMembershipTeamIds: [],
          userId: "author",
        }),
      ).not.toThrow();
    });

    test("an empty team list defers to the validation layer, not a 403", () => {
      // The 'a team item needs a team' error is a 400 raised by
      // assertMcpCatalogTeams; the authorization check must not mask it.
      expect(() =>
        authorizeMcpCatalogScope({
          checker: nonAdmin,
          scope: "team",
          authorId: "author",
          requestedTeamIds: [],
          userTeamIds: ["t1"],
          writeMembershipTeamIds: [],
          userId: "author",
        }),
      ).not.toThrow();
    });

    test("admin bypasses membership for any team", () => {
      expect(() =>
        authorizeMcpCatalogScope({
          checker: admin,
          scope: "team",
          authorId: "someone-else",
          requestedTeamIds: ["t1", "t2"],
          userTeamIds: [],
          writeMembershipTeamIds: [],
          userId: "admin",
        }),
      ).not.toThrow();
    });
  });

  describe("assertMcpCatalogTeams", () => {
    test("rejects team scope with no teams", async () => {
      await expect(
        assertMcpCatalogTeams({ scope: "team", teamIds: [], organizationId }),
      ).rejects.toThrow(/at least one team/i);
    });

    test("rejects an unknown team id", async () => {
      await expect(
        assertMcpCatalogTeams({
          scope: "team",
          teamIds: [crypto.randomUUID()],
          organizationId,
        }),
      ).rejects.toThrow(/unknown team/i);
    });

    test("accepts valid org teams", async ({ makeUser, makeTeam }) => {
      const user = await makeUser();
      const team = await makeTeam(organizationId, user.id);
      await expect(
        assertMcpCatalogTeams({
          scope: "team",
          teamIds: [team.id],
          organizationId,
        }),
      ).resolves.toBeUndefined();
    });

    test("is a no-op for non-team scope", async () => {
      await expect(
        assertMcpCatalogTeams({
          scope: "personal",
          teamIds: [],
          organizationId,
        }),
      ).resolves.toBeUndefined();
    });
  });
});
