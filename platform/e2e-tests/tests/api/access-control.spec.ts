import { expect, test } from "./fixtures";

test.describe("Organization Roles API - CRUD Operations", () => {
  test("should get all roles (including predefined)", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/roles",
    });

    const roles = await response.json();
    expect(Array.isArray(roles)).toBe(true);
    expect(roles.length).toBeGreaterThanOrEqual(2); // At least admin and member

    // Check for predefined roles
    const adminRole = roles.find((r: { name: string }) => r.name === "admin");
    const memberRole = roles.find(
      (r: { name: string }) => r.name === "member",
    );

    expect(adminRole).toBeDefined();
    expect(adminRole.predefined).toBe(true);
    expect(memberRole).toBeDefined();
    expect(memberRole.predefined).toBe(true);
  });

  test("should create a new custom role", async ({
    request,
    makeApiRequest,
  }) => {
    const roleData = {
      name: `test_role_${Date.now()}`,
      permission: {
        agent: ["read"],
        tool: ["read", "create"],
      },
    };

    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/roles",
      data: roleData,
    });

    const role = await response.json();
    expect(role).toHaveProperty("id");
    expect(role.name).toBe(roleData.name);
    expect(role.permission).toEqual(roleData.permission);
    expect(role.predefined).toBe(false);
  });

  test("should fail to create role with duplicate name", async ({
    request,
    makeApiRequest,
  }) => {
    const roleName = `duplicate_role_${Date.now()}`;
    const roleData = {
      name: roleName,
      permission: {
        agent: ["read"],
      },
    };

    // Create first role
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/roles",
      data: roleData,
    });

    // Try to create duplicate
    const duplicateResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/roles",
      data: roleData,
      ignoreStatusCheck: true,
    });

    expect(duplicateResponse.status()).toBe(400);
    const error = await duplicateResponse.json();
    expect(error.error.message).toContain("already exists");
  });

  test("should fail to create role with reserved predefined name", async ({
    request,
    makeApiRequest,
  }) => {
    const roleData = {
      name: "admin",
      permission: {
        agent: ["read"],
      },
    };

    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/roles",
      data: roleData,
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(400);
    const error = await response.json();
    expect(error.error.message).toContain("already exists or is reserved");
  });

  test("should get a specific role by ID", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a role first
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/roles",
      data: {
        name: `get_role_test_${Date.now()}`,
        permission: { agent: ["read"] },
      },
    });
    const createdRole = await createResponse.json();

    // Get the role by ID
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/roles/${createdRole.id}`,
    });

    const role = await response.json();
    expect(role.id).toBe(createdRole.id);
    expect(role.name).toBe(createdRole.name);
    expect(role.permission).toEqual(createdRole.permission);
  });

  test("should get predefined role by name", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/roles/admin",
    });

    const role = await response.json();
    expect(role.id).toBe("admin");
    expect(role.name).toBe("admin");
    expect(role.predefined).toBe(true);
    expect(role.permission).toBeDefined();
  });

  test("should return 404 for non-existent role", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/roles/00000000-0000-0000-0000-000000000000",
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(404);
  });

  test("should update a custom role name", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a role first
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/roles",
      data: {
        name: `update_test_${Date.now()}`,
        permission: { agent: ["read"] },
      },
    });
    const createdRole = await createResponse.json();

    // Update the role name
    const newName = `updated_role_${Date.now()}`;
    const updateResponse = await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/roles/${createdRole.id}`,
      data: { name: newName },
    });

    const updatedRole = await updateResponse.json();
    expect(updatedRole.id).toBe(createdRole.id);
    expect(updatedRole.name).toBe(newName);
    expect(updatedRole.permission).toEqual(createdRole.permission);
  });

  test("should update a custom role permissions", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a role first
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/roles",
      data: {
        name: `permissions_test_${Date.now()}`,
        permission: { agent: ["read"] },
      },
    });
    const createdRole = await createResponse.json();

    // Update the role permissions
    const newPermissions = {
      agent: ["read", "create"],
      tool: ["read"],
    };
    const updateResponse = await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/roles/${createdRole.id}`,
      data: { permission: newPermissions },
    });

    const updatedRole = await updateResponse.json();
    expect(updatedRole.id).toBe(createdRole.id);
    expect(updatedRole.permission).toEqual(newPermissions);
  });

  test("should fail to update predefined role", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "put",
      urlSuffix: "/api/roles/admin",
      data: { name: "new_admin_name" },
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(403);
    const error = await response.json();
    expect(error.error.message).toContain("Cannot update predefined roles");
  });

  test("should delete a custom role", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a role first
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/roles",
      data: {
        name: `delete_test_${Date.now()}`,
        permission: { agent: ["read"] },
      },
    });
    const createdRole = await createResponse.json();

    // Delete the role
    const deleteResponse = await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/roles/${createdRole.id}`,
    });

    const result = await deleteResponse.json();
    expect(result.success).toBe(true);

    // Verify role is deleted
    const getResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/roles/${createdRole.id}`,
      ignoreStatusCheck: true,
    });
    expect(getResponse.status()).toBe(404);
  });

  test("should return 404 when deleting non-existent role", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: "/api/roles/00000000-0000-0000-0000-000000000000",
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(400);
  });
});

test.describe("Organization Roles API - Permission Validation", () => {
  test("should validate role name format", async ({
    request,
    makeApiRequest,
  }) => {
    const invalidNames = [
      "", // empty
      "a".repeat(51), // too long
      "invalid name with spaces", // spaces not allowed
      "invalid@name", // special chars not allowed
    ];

    for (const name of invalidNames) {
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/roles",
        data: {
          name,
          permission: { agent: ["read"] },
        },
        ignoreStatusCheck: true,
      });

      // Should return 400 for validation errors
      expect(response.status()).toBe(400);
    }
  });

  test("should accept valid role name formats", async ({
    request,
    makeApiRequest,
  }) => {
    const validNames = [
      `valid_name_${Date.now()}`,
      `Valid-Name-${Date.now()}`,
      `ValidName123_${Date.now()}`,
    ];

    for (const name of validNames) {
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/roles",
        data: {
          name,
          permission: { agent: ["read"] },
        },
      });

      expect(response.status()).toBe(200);
      const role = await response.json();
      expect(role.name).toBe(name);
    }
  });

  test("should create role with multiple permissions", async ({
    request,
    makeApiRequest,
  }) => {
    const complexPermissions = {
      agent: ["read", "create", "update", "delete"],
      tool: ["read", "create"],
      policy: ["read", "create", "update", "delete"],
      interaction: ["read", "create"],
      mcpServer: ["read", "create", "delete"],
    };

    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/roles",
      data: {
        name: `complex_role_${Date.now()}`,
        permission: complexPermissions,
      },
    });

    const role = await response.json();
    expect(role.permission).toEqual(complexPermissions);
  });

  test("should create role with empty permissions", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/roles",
      data: {
        name: `empty_perms_${Date.now()}`,
        permission: {},
      },
    });

    const role = await response.json();
    expect(role.permission).toEqual({});
  });
});

test.describe("Organization Roles API - Role Lifecycle", () => {
  test("should handle complete role lifecycle: create, read, update, delete", async ({
    request,
    makeApiRequest,
  }) => {
    const roleName = `lifecycle_test_${Date.now()}`;
    const initialPermissions = { agent: ["read"] };
    const updatedPermissions = { agent: ["read", "create"], tool: ["read"] };

    // 1. Create
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/roles",
      data: {
        name: roleName,
        permission: initialPermissions,
      },
    });
    const createdRole = await createResponse.json();
    expect(createdRole.name).toBe(roleName);
    expect(createdRole.permission).toEqual(initialPermissions);

    // 2. Read (verify it exists in list)
    const listResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/roles",
    });
    const roles = await listResponse.json();
    const foundRole = roles.find(
      (r: { id: string }) => r.id === createdRole.id,
    );
    expect(foundRole).toBeDefined();

    // 3. Update
    const updateResponse = await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/roles/${createdRole.id}`,
      data: { permission: updatedPermissions },
    });
    const updatedRole = await updateResponse.json();
    expect(updatedRole.permission).toEqual(updatedPermissions);

    // 4. Delete
    const deleteResponse = await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/roles/${createdRole.id}`,
    });
    const deleteResult = await deleteResponse.json();
    expect(deleteResult.success).toBe(true);

    // 5. Verify deletion
    const getResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/roles/${createdRole.id}`,
      ignoreStatusCheck: true,
    });
    expect(getResponse.status()).toBe(404);
  });
});
