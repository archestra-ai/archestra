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
  getMcpCatalogPermissionChecker,
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
        createdBy: null,
      });
      const checker = await getMcpCatalogPermissionChecker({
        userId: `service-account:${sa.id}`,
        organizationId,
      });
      expect(checker).toEqual({ isAdmin: false });
    });
  });

  describe("authorizeMcpCatalogScope", () => {
    const nonAdmin = { isAdmin: false };
    const admin = { isAdmin: true };

    test("a member may share with a team they belong to", () => {
      expect(() =>
        authorizeMcpCatalogScope({
          checker: nonAdmin,
          scope: "team",
          authorId: "author",
          requestedTeamIds: ["t1"],
          userTeamIds: ["t1"],

          userId: "author",
        }),
      ).not.toThrow();
    });

    test("a member cannot share with a team they are not in", () => {
      expect(() =>
        authorizeMcpCatalogScope({
          checker: nonAdmin,
          scope: "team",
          authorId: "author",
          requestedTeamIds: ["t1", "t2"],
          userTeamIds: ["t1"],

          userId: "author",
        }),
      ).toThrow(/member of/i);
    });

    test("a non-admin cannot use org scope", () => {
      expect(() =>
        authorizeMcpCatalogScope({
          checker: nonAdmin,
          scope: "org",
          authorId: "author",
          requestedTeamIds: [],
          userTeamIds: [],

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
