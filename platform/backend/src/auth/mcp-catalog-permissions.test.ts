import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import ServiceAccountModel from "@/models/service-account";
import { beforeEach, describe, expect, test } from "@/test";
import { getMcpCatalogPermissionChecker } from "./mcp-catalog-permissions";

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
});
