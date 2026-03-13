import { expect, test } from "./fixtures";

test.describe("GET /api/organization/members/:idOrEmail", () => {
  test("should get member by user ID", async ({ request, makeApiRequest }) => {
    // First get the list of members to obtain a valid user ID
    const listResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/organization/members",
    });
    expect(listResponse.status()).toBe(200);

    const members = await listResponse.json();
    expect(members.length).toBeGreaterThan(0);

    const member = members[0];

    // Now fetch that member by ID
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/organization/members/${member.id}`,
    });
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.id).toBe(member.id);
    expect(body.email).toBe(member.email);
    expect(body.name).toBe(member.name);
    expect(body.role).toBeDefined();
  });

  test("should get member by email", async ({ request, makeApiRequest }) => {
    // First get the list of members to obtain a valid email
    const listResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/organization/members",
    });
    const members = await listResponse.json();
    const member = members[0];

    // Now fetch that member by email
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/organization/members/${encodeURIComponent(member.email)}`,
    });
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.id).toBe(member.id);
    expect(body.email).toBe(member.email);
    expect(body.role).toBeDefined();
  });

  test("should return 404 for non-existent user", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/organization/members/non-existent-id",
      ignoreStatusCheck: true,
    });
    expect(response.status()).toBe(404);

    const body = await response.json();
    expect(body.error.message).toBe("Member not found");
  });

  test("should return 404 for non-existent email", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/organization/members/${encodeURIComponent("nobody@nowhere.com")}`,
      ignoreStatusCheck: true,
    });
    expect(response.status()).toBe(404);
  });
});
