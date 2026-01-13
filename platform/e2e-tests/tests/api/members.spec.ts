import { expect, test } from "./fixtures";

test.describe("Member API - Member Lookup", () => {
    test("should get member by user ID", async ({ request, makeApiRequest }) => {
        // Get the current user (admin)
        const sessionResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: "/api/auth/get-session",
        });
        const session = await sessionResponse.json();
        const userId = session.user.id;

        // Get member details
        const response = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: `/api/members/${userId}`,
        });

        const member = await response.json();
        expect(member.id).toBe(userId);
        expect(member.role).toBeDefined();
        expect(member.email).toBeDefined();
        expect(member.name).toBeDefined();
    });

    test("should return 404 for non-existent member", async ({
        request,
        makeApiRequest,
    }) => {
        const response = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: "/api/members/c7528140-07b0-4870-841d-6886a6daeb36",
            ignoreStatusCheck: true,
        });

        expect(response.status()).toBe(404);
        const error = await response.json();
        expect(error.error.message).toContain(
            "User not found in this organization",
        );
    });
});

test.describe("Member API - Role Assignment", () => {
    test("should assign role to member", async ({
        request,
        makeApiRequest,
        createRole,
    }) => {
        // Get current user
        const sessionResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: "/api/auth/get-session",
        });
        const session = await sessionResponse.json();
        const userId = session.user.id;

        // Create a custom role
        const roleResponse = await createRole(request, {
            name: `test_role_${Date.now()}`,
            permission: { profile: ["read"] },
        });
        const role = await roleResponse.json();

        // Assign the role to the user
        const assignResponse = await makeApiRequest({
            request,
            method: "put",
            urlSuffix: `/api/members/${userId}/role`,
            data: { roleId: role.id },
        });

        const assignment = await assignResponse.json();
        expect(assignment.userId).toBe(userId);
        expect(assignment.roleId).toBe(role.role);
        expect(assignment.assignedAt).toBeDefined();

        // Restore admin role
        await makeApiRequest({
            request,
            method: "put",
            urlSuffix: `/api/members/${userId}/role`,
            data: { roleId: "admin" },
        });
    });

    test("should be idempotent when assigning same role", async ({
        request,
        makeApiRequest,
    }) => {
        // Get current user
        const sessionResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: "/api/auth/get-session",
        });
        const session = await sessionResponse.json();
        const userId = session.user.id;

        // Assign admin role (which user already has)
        const firstAssign = await makeApiRequest({
            request,
            method: "put",
            urlSuffix: `/api/members/${userId}/role`,
            data: { roleId: "admin" },
        });

        const firstResult = await firstAssign.json();
        expect(firstResult.userId).toBe(userId);
        expect(firstResult.roleId).toBe("admin");

        // Assign again - should return same result
        const secondAssign = await makeApiRequest({
            request,
            method: "put",
            urlSuffix: `/api/members/${userId}/role`,
            data: { roleId: "admin" },
        });

        const secondResult = await secondAssign.json();
        expect(secondResult.userId).toBe(userId);
        expect(secondResult.roleId).toBe("admin");
        expect(secondResult.assignedAt).toBe(firstResult.assignedAt);
    });

    test("should fail to assign non-existent role", async ({
        request,
        makeApiRequest,
    }) => {
        // Get current user
        const sessionResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: "/api/auth/get-session",
        });
        const session = await sessionResponse.json();
        const userId = session.user.id;

        const response = await makeApiRequest({
            request,
            method: "put",
            urlSuffix: `/api/members/${userId}/role`,
            data: { roleId: "non_existent_role" },
            ignoreStatusCheck: true,
        });

        expect(response.status()).toBe(404);
        const error = await response.json();
        expect(error.error.message).toContain("Role not found");
    });

    test("should assign predefined role by identifier", async ({
        request,
        makeApiRequest,
    }) => {
        // Get current user
        const sessionResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: "/api/auth/get-session",
        });
        const session = await sessionResponse.json();
        const userId = session.user.id;

        // Assign editor role
        const assignResponse = await makeApiRequest({
            request,
            method: "put",
            urlSuffix: `/api/members/${userId}/role`,
            data: { roleId: "editor" },
        });

        const assignment = await assignResponse.json();
        expect(assignment.userId).toBe(userId);
        expect(assignment.roleId).toBe("editor");

        // Restore admin role
        await makeApiRequest({
            request,
            method: "put",
            urlSuffix: `/api/members/${userId}/role`,
            data: { roleId: "admin" },
        });
    });
});

test.describe("Member API - Role Assignment Read", () => {
    test("should get role assignment details", async ({
        request,
        makeApiRequest,
    }) => {
        // Get current user
        const sessionResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: "/api/auth/get-session",
        });
        const session = await sessionResponse.json();
        const userId = session.user.id;

        // Get role assignment for admin role
        const response = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: `/api/members/${userId}/role/admin`,
        });

        const result = await response.json();
        expect(result.assignment).toBeDefined();
        expect(result.assignment.userId).toBe(userId);
        expect(result.assignment.roleId).toBe("admin");
        expect(result.role).toBeDefined();
        expect(result.role.id).toBe("admin");
        expect(result.role.name).toBe("admin");
        expect(result.role.permissions).toBeDefined();
        expect(Array.isArray(result.role.permissions)).toBe(true);
    });

    test("should return 404 for non-assigned role", async ({
        request,
        makeApiRequest,
    }) => {
        // Get current user
        const sessionResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: "/api/auth/get-session",
        });
        const session = await sessionResponse.json();
        const userId = session.user.id;

        // Try to get member role (user has admin, not member)
        const response = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: `/api/members/${userId}/role/member`,
            ignoreStatusCheck: true,
        });

        expect(response.status()).toBe(404);
        const error = await response.json();
        expect(error.error.message).toContain(
            "Role assignment does not exist for this user",
        );
    });

    test("should include flattened permissions in response", async ({
        request,
        makeApiRequest,
        createRole,
    }) => {
        // Get current user
        const sessionResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: "/api/auth/get-session",
        });
        const session = await sessionResponse.json();
        const userId = session.user.id;

        // Create a custom role with specific permissions
        const roleResponse = await createRole(request, {
            name: `permissions_test_${Date.now()}`,
            permission: {
                profile: ["read", "create"],
                tool: ["read"],
            },
        });
        const role = await roleResponse.json();

        // Assign the role
        await makeApiRequest({
            request,
            method: "put",
            urlSuffix: `/api/members/${userId}/role`,
            data: { roleId: role.id },
        });

        // Get role assignment
        const response = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: `/api/members/${userId}/role/${role.role}`,
        });

        const result = await response.json();
        expect(result.role.permissions).toContain("profile:read");
        expect(result.role.permissions).toContain("profile:create");
        expect(result.role.permissions).toContain("tool:read");
        expect(result.role.permissions.length).toBe(3);

        // Restore admin role
        await makeApiRequest({
            request,
            method: "put",
            urlSuffix: `/api/members/${userId}/role`,
            data: { roleId: "admin" },
        });
    });
});

test.describe("Member API - Role Removal", () => {
    test("should remove role assignment and assign member role", async ({
        request,
        makeApiRequest,
        createRole,
    }) => {
        // Get current user
        const sessionResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: "/api/auth/get-session",
        });
        const session = await sessionResponse.json();
        const userId = session.user.id;

        // Create and assign a custom role
        const roleResponse = await createRole(request, {
            name: `temp_role_${Date.now()}`,
            permission: { profile: ["read"] },
        });
        const role = await roleResponse.json();

        await makeApiRequest({
            request,
            method: "put",
            urlSuffix: `/api/members/${userId}/role`,
            data: { roleId: role.id },
        });

        // Remove the role assignment
        const response = await makeApiRequest({
            request,
            method: "delete",
            urlSuffix: `/api/members/${userId}/role/${role.role}`,
        });

        const result = await response.json();
        expect(result.success).toBe(true);

        // Verify user now has member role
        const memberResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: `/api/members/${userId}`,
        });
        const member = await memberResponse.json();
        expect(member.role).toBe("member");

        // Restore admin role
        await makeApiRequest({
            request,
            method: "put",
            urlSuffix: `/api/members/${userId}/role`,
            data: { roleId: "admin" },
        });
    });

    test("should return 404 when removing non-assigned role", async ({
        request,
        makeApiRequest,
    }) => {
        // Get current user
        const sessionResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: "/api/auth/get-session",
        });
        const session = await sessionResponse.json();
        const userId = session.user.id;

        // Try to remove member role (user has admin, not member)
        const response = await makeApiRequest({
            request,
            method: "delete",
            urlSuffix: `/api/members/${userId}/role/member`,
            ignoreStatusCheck: true,
        });

        expect(response.status()).toBe(404);
        const error = await response.json();
        expect(error.error.message).toContain(
            "Role assignment does not exist for this user",
        );
    });

    test("should return 404 for non-existent role", async ({
        request,
        makeApiRequest,
    }) => {
        // Get current user
        const sessionResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: "/api/auth/get-session",
        });
        const session = await sessionResponse.json();
        const userId = session.user.id;

        const response = await makeApiRequest({
            request,
            method: "delete",
            urlSuffix: `/api/members/${userId}/role/non_existent_role`,
            ignoreStatusCheck: true,
        });

        expect(response.status()).toBe(404);
        const error = await response.json();
        expect(error.error.message).toContain("Role not found");
    });
});

test.describe("Member API - Role Lifecycle Integration", () => {
    test("should handle complete role assignment lifecycle", async ({
        request,
        makeApiRequest,
        createRole,
    }) => {
        // Get current user
        const sessionResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: "/api/auth/get-session",
        });
        const session = await sessionResponse.json();
        const userId = session.user.id;

        // 1. Create a custom role
        const roleResponse = await createRole(request, {
            name: `lifecycle_role_${Date.now()}`,
            permission: {
                profile: ["read"],
                tool: ["read", "create"],
            },
        });
        const role = await roleResponse.json();

        // 2. Assign the role
        const assignResponse = await makeApiRequest({
            request,
            method: "put",
            urlSuffix: `/api/members/${userId}/role`,
            data: { roleId: role.id },
        });
        const assignment = await assignResponse.json();
        expect(assignment.roleId).toBe(role.role);

        // 3. Read the assignment
        const readResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: `/api/members/${userId}/role/${role.role}`,
        });
        const readResult = await readResponse.json();
        expect(readResult.assignment.userId).toBe(userId);
        expect(readResult.role.id).toBe(role.id);

        // 4. Remove the role assignment (should assign member role)
        const deleteResponse = await makeApiRequest({
            request,
            method: "delete",
            urlSuffix: `/api/members/${userId}/role/${role.role}`,
        });
        const deleteResult = await deleteResponse.json();
        expect(deleteResult.success).toBe(true);

        // 5. Verify user now has member role
        const memberCheckResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: `/api/members/${userId}`,
        });
        const memberAfterDelete = await memberCheckResponse.json();
        expect(memberAfterDelete.role).toBe("member");

        // 6. Restore admin role
        await makeApiRequest({
            request,
            method: "put",
            urlSuffix: `/api/members/${userId}/role`,
            data: { roleId: "admin" },
        });

        // 7. Verify custom role is no longer assigned
        const finalCheckResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: `/api/members/${userId}/role/${role.role}`,
            ignoreStatusCheck: true,
        });
        expect(finalCheckResponse.status()).toBe(404);
    });
});
