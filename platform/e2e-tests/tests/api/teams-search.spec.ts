import { expect, test } from "./fixtures";

test.describe("Teams Search and Filtering", () => {
  test("should search teams by name", async ({
    request,
    makeApiRequest,
    createTeam,
    deleteTeam,
  }) => {
    const prefix = `SearchName-${Date.now()}`;
    const team1Response = await createTeam(
      request,
      `${prefix} Alpha Team`,
      "Description one",
    );
    const team1 = await team1Response.json();
    const team2Response = await createTeam(
      request,
      `${prefix} Beta Team`,
      "Description two",
    );
    const team2 = await team2Response.json();

    try {
      // Search for "Alpha" within our prefix
      const searchResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/teams?search=${encodeURIComponent(`${prefix} Alpha`)}`,
      });
      expect(searchResponse.status()).toBe(200);
      const body = await searchResponse.json();
      expect(body.data).toBeDefined();
      expect(body.data.length).toBe(1);
      expect(body.data[0].name).toContain("Alpha");
      expect(body.pagination).toBeDefined();
      expect(body.pagination.total).toBe(1);
    } finally {
      await deleteTeam(request, team1.id);
      await deleteTeam(request, team2.id);
    }
  });

  test("should search teams by description", async ({
    request,
    makeApiRequest,
    createTeam,
    deleteTeam,
  }) => {
    const uniqueToken = `desctest-${Date.now()}`;
    const teamResponse = await createTeam(
      request,
      `DescSearch Team ${uniqueToken}`,
      `A unique ${uniqueToken} description here`,
    );
    const team = await teamResponse.json();

    try {
      const searchResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/teams?search=${encodeURIComponent(uniqueToken)}`,
      });
      expect(searchResponse.status()).toBe(200);
      const body = await searchResponse.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(
        body.data.some((t: { id: string }) => t.id === team.id),
      ).toBe(true);
    } finally {
      await deleteTeam(request, team.id);
    }
  });

  test("should search teams case-insensitively", async ({
    request,
    makeApiRequest,
    createTeam,
    deleteTeam,
  }) => {
    const uniqueToken = `CaseTest-${Date.now()}`;
    const teamResponse = await createTeam(
      request,
      `${uniqueToken} ENGINEERING`,
    );
    const team = await teamResponse.json();

    try {
      // Search with lowercase
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/teams?search=${encodeURIComponent(`${uniqueToken} engineering`)}`,
      });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(
        body.data.some(
          (t: { name: string }) => t.name === `${uniqueToken} ENGINEERING`,
        ),
      ).toBe(true);
    } finally {
      await deleteTeam(request, team.id);
    }
  });

  test("should paginate teams", async ({
    request,
    makeApiRequest,
    createTeam,
    deleteTeam,
  }) => {
    const prefix = `PaginateTest-${Date.now()}`;
    const teams = [];
    for (let i = 0; i < 3; i++) {
      const r = await createTeam(request, `${prefix} Team ${i}`);
      teams.push(await r.json());
    }

    try {
      // First page with limit=2
      const page1 = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/teams?search=${encodeURIComponent(prefix)}&limit=2&offset=0`,
      });
      expect(page1.status()).toBe(200);
      const body1 = await page1.json();
      expect(body1.data).toHaveLength(2);
      expect(body1.pagination.total).toBe(3);
      expect(body1.pagination.hasNext).toBe(true);
      expect(body1.pagination.totalPages).toBe(2);
      expect(body1.pagination.currentPage).toBe(1);

      // Second page
      const page2 = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/teams?search=${encodeURIComponent(prefix)}&limit=2&offset=2`,
      });
      expect(page2.status()).toBe(200);
      const body2 = await page2.json();
      expect(body2.data).toHaveLength(1);
      expect(body2.pagination.hasNext).toBe(false);
      expect(body2.pagination.currentPage).toBe(2);
    } finally {
      for (const team of teams) {
        await deleteTeam(request, team.id);
      }
    }
  });

  test("should sort teams by name ascending", async ({
    request,
    makeApiRequest,
    createTeam,
    deleteTeam,
  }) => {
    const prefix = `SortName-${Date.now()}`;
    const teamA = await (
      await createTeam(request, `${prefix} Zebra`)
    ).json();
    const teamB = await (
      await createTeam(request, `${prefix} Alpha`)
    ).json();

    try {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/teams?search=${encodeURIComponent(prefix)}&sortBy=name&sortDirection=asc`,
      });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.data.length).toBe(2);
      expect(body.data[0].name).toContain("Alpha");
      expect(body.data[1].name).toContain("Zebra");
    } finally {
      await deleteTeam(request, teamA.id);
      await deleteTeam(request, teamB.id);
    }
  });

  test("should sort teams by createdAt", async ({
    request,
    makeApiRequest,
    createTeam,
    deleteTeam,
  }) => {
    const prefix = `SortCreated-${Date.now()}`;
    const teamFirst = await (
      await createTeam(request, `${prefix} First`)
    ).json();
    const teamSecond = await (
      await createTeam(request, `${prefix} Second`)
    ).json();

    try {
      // Sort ascending (oldest first)
      const responseAsc = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/teams?search=${encodeURIComponent(prefix)}&sortBy=createdAt&sortDirection=asc`,
      });
      expect(responseAsc.status()).toBe(200);
      const bodyAsc = await responseAsc.json();
      expect(bodyAsc.data.length).toBe(2);
      expect(bodyAsc.data[0].name).toContain("First");
      expect(bodyAsc.data[1].name).toContain("Second");

      // Sort descending (newest first)
      const responseDesc = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/teams?search=${encodeURIComponent(prefix)}&sortBy=createdAt&sortDirection=desc`,
      });
      expect(responseDesc.status()).toBe(200);
      const bodyDesc = await responseDesc.json();
      expect(bodyDesc.data[0].name).toContain("Second");
      expect(bodyDesc.data[1].name).toContain("First");
    } finally {
      await deleteTeam(request, teamFirst.id);
      await deleteTeam(request, teamSecond.id);
    }
  });

  test("should return empty results for non-matching search", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/teams?search=nonexistent_term_xyz_123_456",
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveLength(0);
    expect(body.pagination.total).toBe(0);
    expect(body.pagination.hasNext).toBe(false);
  });

  test("should combine search with pagination", async ({
    request,
    makeApiRequest,
    createTeam,
    deleteTeam,
  }) => {
    const prefix = `CombinedTest-${Date.now()}`;
    const teams = [];
    for (let i = 0; i < 5; i++) {
      const r = await createTeam(request, `${prefix} Team ${String(i).padStart(2, "0")}`);
      teams.push(await r.json());
    }

    try {
      // Page 1 of search results
      const page1 = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/teams?search=${encodeURIComponent(prefix)}&limit=2&offset=0&sortBy=name&sortDirection=asc`,
      });
      expect(page1.status()).toBe(200);
      const body1 = await page1.json();
      expect(body1.data).toHaveLength(2);
      expect(body1.pagination.total).toBe(5);
      expect(body1.pagination.hasNext).toBe(true);
      expect(body1.pagination.totalPages).toBe(3);

      // Page 2
      const page2 = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/teams?search=${encodeURIComponent(prefix)}&limit=2&offset=2&sortBy=name&sortDirection=asc`,
      });
      expect(page2.status()).toBe(200);
      const body2 = await page2.json();
      expect(body2.data).toHaveLength(2);
      expect(body2.pagination.hasNext).toBe(true);

      // Page 3 (last)
      const page3 = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/teams?search=${encodeURIComponent(prefix)}&limit=2&offset=4&sortBy=name&sortDirection=asc`,
      });
      expect(page3.status()).toBe(200);
      const body3 = await page3.json();
      expect(body3.data).toHaveLength(1);
      expect(body3.pagination.hasNext).toBe(false);

      // Verify no duplicate items across pages
      const allNames = [
        ...body1.data.map((t: { name: string }) => t.name),
        ...body2.data.map((t: { name: string }) => t.name),
        ...body3.data.map((t: { name: string }) => t.name),
      ];
      expect(new Set(allNames).size).toBe(5);
    } finally {
      for (const team of teams) {
        await deleteTeam(request, team.id);
      }
    }
  });
});
