import { expect, test } from "./fixtures";

test.describe("Organization Roles API - Read Operations", () => {
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
    const editorRole = roles.find((r: { name: string }) => r.name === "editor");
    const memberRole = roles.find((r: { name: string }) => r.name === "member");

    expect(adminRole).toBeDefined();
    expect(adminRole.predefined).toBe(true);
    expect(editorRole).toBeDefined();
    expect(editorRole.predefined).toBe(true);
    expect(memberRole).toBeDefined();
    expect(memberRole.predefined).toBe(true);
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
      urlSuffix: "/api/roles/c7528140-07b0-4870-841d-6886a6daeb36",
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(404);
  });
});
