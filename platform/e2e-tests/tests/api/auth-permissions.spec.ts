import { expect, test } from "./fixtures";

test.describe("Auth Permissions API", () => {
  test("should allow admin to access organization permissions", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/auth/has-permission",
      data: {
        permissions: {
          organization: ["read", "update"],
        },
      },
    });

    const result = await response.json();
    expect(result.success).toBe(true);
  });

  test("should allow admin to access all resource permissions", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/auth/has-permission",
      data: {
        permissions: {
          profile: ["admin"],
          mcpServer: ["admin"],
          mcpServerInstallationRequest: ["admin"],
          tool: ["create", "read", "update", "delete"],
          policy: ["create", "read", "update", "delete"],
        },
      },
    });

    const result = await response.json();
    expect(result.success).toBe(true);
  });

  test("should handle empty permissions object", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/auth/has-permission",
      data: {
        permissions: {},
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
    const permissionResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/auth/has-permission",
      data: {
        permissions: {
          organization: ["read", "update"],
        },
      },
    });

    const result = await permissionResponse.json();
    expect(result.success).toBe(true);

    // Clean up
    await deleteRole(request, createdRole.id);
  });

  test("should return error for invalid permission structure", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/auth/has-permission",
      data: {
        permissions: {
          invalidResource: ["read"],
        },
      },
      ignoreStatusCheck: true,
    });

    // Should return validation error (currently 500 due to Fastify validation handling)
    expect(response.status()).toBe(500);
  });
});
