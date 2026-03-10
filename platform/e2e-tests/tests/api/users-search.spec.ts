import { expect, test } from "./fixtures";

test.describe("Users/Members Search and Filtering", () => {
  test("should list paginated organization members", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/organization/members/paginated",
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeDefined();
    expect(body.pagination.total).toBeGreaterThan(0);
    expect(body.pagination.currentPage).toBeGreaterThanOrEqual(1);
    expect(typeof body.pagination.hasNext).toBe("boolean");
    expect(body.pagination.totalPages).toBeGreaterThanOrEqual(1);
  });

  test("should search members by name", async ({
    request,
    makeApiRequest,
  }) => {
    // First get all members to find a name to search for
    const allResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/organization/members/paginated",
    });
    const allBody = await allResponse.json();
    const memberWithName = allBody.data.find(
      (m: { name: string | null }) => m.name && m.name.length >= 3,
    );

    if (memberWithName) {
      const searchTerm = memberWithName.name.substring(0, 3);
      const searchResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/organization/members/paginated?search=${encodeURIComponent(searchTerm)}`,
      });
      expect(searchResponse.status()).toBe(200);
      const searchBody = await searchResponse.json();
      expect(searchBody.data.length).toBeGreaterThan(0);
      // Every result should match the search term in name or email
      for (const member of searchBody.data) {
        const matchesName = member.name
          ?.toLowerCase()
          .includes(searchTerm.toLowerCase());
        const matchesEmail = member.email
          ?.toLowerCase()
          .includes(searchTerm.toLowerCase());
        expect(matchesName || matchesEmail).toBe(true);
      }
    }
  });

  test("should search members by email", async ({
    request,
    makeApiRequest,
  }) => {
    // Search for "example.com" which should match seeded test users
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/organization/members/paginated?search=${encodeURIComponent("example.com")}`,
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeGreaterThan(0);
    for (const member of body.data) {
      const matchesName = member.name
        ?.toLowerCase()
        .includes("example.com");
      const matchesEmail = member.email
        ?.toLowerCase()
        .includes("example.com");
      expect(matchesName || matchesEmail).toBe(true);
    }
  });

  test("should search members case-insensitively", async ({
    request,
    makeApiRequest,
  }) => {
    // Get a member to use for case-insensitive search
    const allResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/organization/members/paginated",
    });
    const allBody = await allResponse.json();
    const firstMember = allBody.data[0];

    if (firstMember?.email) {
      // Search with uppercase version of email
      const uppercaseTerm = firstMember.email.toUpperCase();
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/organization/members/paginated?search=${encodeURIComponent(uppercaseTerm)}`,
      });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.data.length).toBeGreaterThan(0);
      expect(
        body.data.some(
          (m: { email: string }) =>
            m.email.toLowerCase() === firstMember.email.toLowerCase(),
        ),
      ).toBe(true);
    }
  });

  test("should filter members by role", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/organization/members/paginated?role=admin",
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeGreaterThan(0);
    // All returned members should have admin role
    for (const member of body.data) {
      expect(member.role).toBe("admin");
    }
  });

  test("should filter members by team", async ({
    request,
    makeApiRequest,
  }) => {
    // Get teams to find one to filter by
    const allTeamsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/teams",
    });
    const teamsBody = await allTeamsResponse.json();
    const teams = teamsBody.data;

    if (teams && teams.length > 0) {
      const teamId = teams[0].id;
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/organization/members/paginated?teamIds=${teamId}`,
      });
      expect(response.status()).toBe(200);
      const body = await response.json();
      // All returned members should belong to the specified team
      for (const member of body.data) {
        expect(
          member.teams.some((t: { id: string }) => t.id === teamId),
        ).toBe(true);
      }
    }
  });

  test("should support pagination with limit and offset", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/organization/members/paginated?limit=1&offset=0",
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeLessThanOrEqual(1);
    expect(body.pagination.limit).toBe(1);
    expect(body.pagination.currentPage).toBe(1);

    // If there are more members, verify next page works
    if (body.pagination.hasNext) {
      const page2 = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/organization/members/paginated?limit=1&offset=1",
      });
      expect(page2.status()).toBe(200);
      const body2 = await page2.json();
      expect(body2.data.length).toBeLessThanOrEqual(1);
      expect(body2.pagination.currentPage).toBe(2);

      // Verify different members on each page
      if (body.data.length > 0 && body2.data.length > 0) {
        expect(body.data[0].email).not.toBe(body2.data[0].email);
      }
    }
  });

  test("should sort members by email ascending", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix:
        "/api/organization/members/paginated?sortBy=email&sortDirection=asc",
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    if (body.data.length > 1) {
      for (let i = 1; i < body.data.length; i++) {
        expect(
          body.data[i].email.localeCompare(body.data[i - 1].email),
        ).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("should sort members by name descending", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix:
        "/api/organization/members/paginated?sortBy=name&sortDirection=desc",
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    const membersWithNames = body.data.filter(
      (m: { name: string | null }) => m.name != null,
    );
    if (membersWithNames.length > 1) {
      for (let i = 1; i < membersWithNames.length; i++) {
        expect(
          membersWithNames[i - 1].name.localeCompare(
            membersWithNames[i].name,
          ),
        ).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("should return empty results for non-matching search", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix:
        "/api/organization/members/paginated?search=nonexistent_user_xyz_123_456",
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveLength(0);
    expect(body.pagination.total).toBe(0);
  });

  test("should include teams array and isPendingSignup in member data", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/organization/members/paginated",
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data.length).toBeGreaterThan(0);
    for (const member of body.data) {
      expect(Array.isArray(member.teams)).toBe(true);
      expect(typeof member.isPendingSignup).toBe("boolean");
      // Each team in the array should have an id
      for (const team of member.teams) {
        expect(team.id).toBeDefined();
      }
    }
  });

  test("should combine search with role filter", async ({
    request,
    makeApiRequest,
  }) => {
    // Search for "example.com" and filter to admin role
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix:
        "/api/organization/members/paginated?search=example.com&role=admin",
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    // All results should be admins matching the search
    for (const member of body.data) {
      expect(member.role).toBe("admin");
      const matchesName = member.name
        ?.toLowerCase()
        .includes("example.com");
      const matchesEmail = member.email
        ?.toLowerCase()
        .includes("example.com");
      expect(matchesName || matchesEmail).toBe(true);
    }
  });
});
