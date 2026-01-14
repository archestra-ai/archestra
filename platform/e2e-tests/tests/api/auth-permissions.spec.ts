import type { Permissions } from "@shared";
import { allAvailableActions } from "@shared/access-control";
import {
  type APIRequestContext,
  expect,
  type TestFixtures,
  test,
} from "./fixtures";

const makeHasPermissionsRequest = async ({
  request,
  makeApiRequest,
  data,
}: {
  request: APIRequestContext;
  makeApiRequest: TestFixtures["makeApiRequest"];
  data: {
    permissions: Permissions;
  };
}) => {
  return await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/auth/organization/has-permission",
    data,
  });
};

test.describe("Auth Permissions API", () => {
  test("should return all user permissions", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/user/permissions",
    });

    expect(response.status()).toBe(200);

    const permissions = await response.json();

    // Admin should have all permissions
    expect(permissions).toBeDefined();
    expect(permissions.organization).toContain("read");
    expect(permissions.organization).toContain("update");
    expect(permissions.organization).toContain("delete");
    expect(permissions.profile).toBeDefined();
    expect(permissions.tool).toBeDefined();
  });

  test("should allow admin to access all resource permissions", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeHasPermissionsRequest({
      request,
      makeApiRequest,
      data: {
        permissions: allAvailableActions,
      },
    });

    const result = await response.json();
    expect(result.success).toBe(true);
  });
});
