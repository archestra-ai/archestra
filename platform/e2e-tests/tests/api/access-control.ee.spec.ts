import { expect, test } from "./fixtures";

test.describe("Organization Roles API - Custom Role CRUD Operations", () => {
  test("should create a new custom role", async ({ request, createRole }) => {
    const roleData = {
      name: `test_role_${Date.now()}`,
      permission: {
        profile: ["read"],
        tool: ["read", "create"],
      },
    };

    const response = await createRole(request, roleData);

    const role = await response.json();
    expect(role).toHaveProperty("id");
    expect(role.name).toBe(roleData.name);
    expect(role.permission).toEqual(roleData.permission);
    expect(role.predefined).toBe(false);
  });

  test("should fail to create role with duplicate name", async ({
    request,
    makeApiRequest,
    createRole,
  }) => {
    const roleName = `duplicate_role_${Date.now()}`;
    const roleData = {
      name: roleName,
      permission: {
        profile: ["read"],
      },
    };

    // Create first role
    await createRole(request, roleData);

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
    expect(error.error.message).toContain("That role name is already taken");
  });

  test("should fail to create role with reserved predefined name", async ({
    request,
    makeApiRequest,
  }) => {
    const roleData = {
      name: "admin",
      permission: {
        profile: ["read"],
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
    expect(error.error.message).toContain("That role name is already taken");
  });

  test("should get a specific custom role by ID", async ({
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
        permission: { profile: ["read"] },
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
        permission: { profile: ["read"] },
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
        permission: { profile: ["read"] },
      },
    });
    const createdRole = await createResponse.json();

    // Update the role permissions
    const newPermissions = {
      profile: ["read", "create"],
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
    createRole,
    deleteRole,
  }) => {
    // Create a role first
    const createResponse = await createRole(request, {
      name: `delete_test_${Date.now()}`,
      permission: { profile: ["read"] },
    });
    const createdRole = await createResponse.json();

    // Delete the role
    const deleteResponse = await deleteRole(request, createdRole.id);

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
      urlSuffix: "/api/roles/c7528140-07b0-4870-841d-6886a6daeb36",
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(404);
  });
});

test.describe("Organization Roles API - Permission Validation", () => {
  test("should create role with multiple permissions", async ({
    request,
    makeApiRequest,
  }) => {
    const complexPermissions = {
      profile: ["read", "create", "update", "delete"],
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
    const initialPermissions = { profile: ["read"] };
    const updatedPermissions = { profile: ["read", "create"], tool: ["read"] };

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
