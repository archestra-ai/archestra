import { expect, test } from "./fixtures";

test.describe("Members API", () => {
  test.describe("List Organization Members", () => {
    test("should list all members in the organization", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/members",
      });

      expect(response.status()).toBe(200);
      const members = await response.json();
      expect(Array.isArray(members)).toBe(true);
      // At least admin user should exist
      expect(members.length).toBeGreaterThan(0);

      // Check structure
      const firstMember = members[0];
      expect(firstMember).toHaveProperty("id");
      expect(firstMember).toHaveProperty("userId");
      expect(firstMember).toHaveProperty("organizationId");
      expect(firstMember).toHaveProperty("role");
    });
  });

  test.describe("Get Member by User ID", () => {
    test("should get a specific member by user ID", async ({
      request,
      makeApiRequest,
    }) => {
      // First get members list to get a valid user ID
      const listResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/members",
      });
      const members = await listResponse.json();
      const testMember = members[0];

      // Get specific member
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/members/${testMember.userId}`,
      });

      expect(response.status()).toBe(200);
      const member = await response.json();
      expect(member.userId).toBe(testMember.userId);
      expect(member).toHaveProperty("user");
    });

    test("should return 404 for non-existent member", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/members/non-existent-user-id",
        ignoreStatusCheck: true,
      });

      expect(response.status()).toBe(404);
    });
  });
});

test.describe("User Lookup API", () => {
  test.describe("Get User by ID", () => {
    test("should get user by ID", async ({ request, makeApiRequest }) => {
      // First get members list to get a valid user ID
      const listResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/members",
      });
      const members = await listResponse.json();
      const testUserId = members[0].userId;

      // Get user by ID
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/users/${testUserId}`,
      });

      expect(response.status()).toBe(200);
      const user = await response.json();
      expect(user.id).toBe(testUserId);
      expect(user).toHaveProperty("email");
      expect(user).toHaveProperty("name");
      expect(user).toHaveProperty("member");
    });

    test("should return 404 for non-existent user", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/users/non-existent-user-id",
        ignoreStatusCheck: true,
      });

      expect(response.status()).toBe(404);
    });
  });

  test.describe("Get User by Email", () => {
    test("should get user by email", async ({ request, makeApiRequest }) => {
      // First get members list to find a user, then get their details
      const listResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/members",
      });
      const members = await listResponse.json();
      const testUserId = members[0].userId;

      // Get user details first
      const userResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/users/${testUserId}`,
      });
      const userData = await userResponse.json();

      // Now look up by email
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/users/by-email/${encodeURIComponent(userData.email)}`,
      });

      expect(response.status()).toBe(200);
      const user = await response.json();
      expect(user.email).toBe(userData.email);
      expect(user.id).toBe(testUserId);
    });

    test("should return 404 for non-existent email", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/users/by-email/nonexistent@example.com",
        ignoreStatusCheck: true,
      });

      expect(response.status()).toBe(404);
    });
  });
});

test.describe("Role Assignment API", () => {
  test.describe("Update Member Role", () => {
    test("should assign a predefined role to a member", async ({
      request,
      makeApiRequest,
    }) => {
      // Get editor's user ID from their request context
      // First, let's get the members list as admin
      const membersResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/members",
      });
      const members = await membersResponse.json();

      // Find a member that is not the admin (has role !== "admin")
      const targetMember = members.find(
        (m: { role: string }) => m.role !== "admin",
      );

      if (!targetMember) {
        // Skip test if no non-admin member exists
        test.skip();
        return;
      }

      // Assign editor role
      const response = await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/members/${targetMember.userId}/role`,
        data: { role: "editor" },
      });

      expect(response.status()).toBe(200);
      const updatedMember = await response.json();
      expect(updatedMember.role).toBe("editor");

      // Restore original role
      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/members/${targetMember.userId}/role`,
        data: { role: targetMember.role },
      });
    });

    test("should fail to assign non-existent role", async ({
      request,
      makeApiRequest,
    }) => {
      const membersResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/members",
      });
      const members = await membersResponse.json();
      const targetMember = members.find(
        (m: { role: string }) => m.role !== "admin",
      );

      if (!targetMember) {
        test.skip();
        return;
      }

      const response = await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/members/${targetMember.userId}/role`,
        data: { role: "non_existent_role" },
        ignoreStatusCheck: true,
      });

      expect(response.status()).toBe(404);
    });

    test("should fail to change own role", async ({
      request,
      makeApiRequest,
    }) => {
      const membersResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/members",
      });
      const members = await membersResponse.json();

      // Find the admin member (ourselves - the test is running as admin)
      const adminMember = members.find(
        (m: { role: string }) => m.role === "admin",
      );

      if (!adminMember) {
        test.skip();
        return;
      }

      const response = await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/members/${adminMember.userId}/role`,
        data: { role: "member" },
        ignoreStatusCheck: true,
      });

      expect(response.status()).toBe(403);
      const error = await response.json();
      expect(error.error.message).toContain("cannot change your own role");
    });
  });

  test.describe("Reset Member Role", () => {
    test("should reset member role to default", async ({
      request,
      makeApiRequest,
    }) => {
      const membersResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/members",
      });
      const members = await membersResponse.json();

      const targetMember = members.find(
        (m: { role: string }) => m.role !== "admin",
      );

      if (!targetMember) {
        test.skip();
        return;
      }

      // First set a different role
      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/members/${targetMember.userId}/role`,
        data: { role: "editor" },
      });

      // Reset role
      const resetResponse = await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/members/${targetMember.userId}/role`,
      });

      expect(resetResponse.status()).toBe(200);
      const resetMember = await resetResponse.json();
      expect(resetMember.role).toBe("member");

      // Restore original role if different
      if (targetMember.role !== "member") {
        await makeApiRequest({
          request,
          method: "put",
          urlSuffix: `/api/members/${targetMember.userId}/role`,
          data: { role: targetMember.role },
        });
      }
    });
  });

  test.describe("Role Assignment Idempotency", () => {
    test("should be idempotent - assigning same role twice succeeds", async ({
      request,
      makeApiRequest,
    }) => {
      const membersResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/members",
      });
      const members = await membersResponse.json();

      const targetMember = members.find(
        (m: { role: string }) => m.role !== "admin",
      );

      if (!targetMember) {
        test.skip();
        return;
      }

      // Assign editor role first time
      const response1 = await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/members/${targetMember.userId}/role`,
        data: { role: "editor" },
      });
      expect(response1.status()).toBe(200);

      // Assign same role again - should succeed
      const response2 = await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/members/${targetMember.userId}/role`,
        data: { role: "editor" },
      });
      expect(response2.status()).toBe(200);
      const member = await response2.json();
      expect(member.role).toBe("editor");

      // Restore original role
      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/members/${targetMember.userId}/role`,
        data: { role: targetMember.role },
      });
    });
  });
});

test.describe("Role Lookup by Name", () => {
  test("should lookup predefined role by name", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/roles/by-name/admin",
    });

    expect(response.status()).toBe(200);
    const role = await response.json();
    expect(role.role).toBe("admin");
    expect(role.name).toBe("admin");
    expect(role.predefined).toBe(true);
  });

  test("should filter roles by name query param", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/roles?name=editor",
    });

    expect(response.status()).toBe(200);
    const roles = await response.json();
    expect(roles.length).toBe(1);
    expect(roles[0].name).toBe("editor");
  });

  test("should return 404 for non-existent role name", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/roles/by-name/nonexistent_role",
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(404);
  });
});
