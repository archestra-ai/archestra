import { allAvailableActions, type Permissions } from "@shared";
import {
  type APIRequestContext,
  expect,
  type TestFixtures,
  test,
} from "./fixtures";

test.describe("Auth Permissions API", () => {
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

  test("should work with custom roles", async ({
    request,
    makeApiRequest,
    createRole,
    deleteRole,
  }) => {
    // Create a custom role with limited permissions
    const createResponse = await createRole(request, {
      name: `test_permissions_role_${Date.now()}`,
      permission: {
        profile: ["read"],
        tool: ["read"],
      },
    });
    const createdRole = await createResponse.json();

    // Test admin can still access organization permissions
    const permissionResponse = await makeHasPermissionsRequest({
      request,
      makeApiRequest,
      data: {
        permissions: {
          organization: ["read", "update", "delete"],
        },
      },
    });

    const result = await permissionResponse.json();
    expect(result.success).toBe(true);

    // Clean up
    await deleteRole(request, createdRole.id);
  });
});
