import { makeHasPermissionsRequest } from "./auth-permissions.spec";
import { expect, test } from "./fixtures";

test.describe("Auth Permissions API - Custom Roles", () => {
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
