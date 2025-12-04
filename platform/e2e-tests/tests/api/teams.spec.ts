import { ENGINEERING_TEAM_NAME, MARKETING_TEAM_NAME } from "../../consts";
import { expect, test } from "./fixtures";

test.describe("Teams API", () => {
  test.describe("Permission-based Team Visibility", () => {
    test("Admin sees all teams in the organization", async ({
      request,
      makeApiRequest,
    }) => {
      // Admin has team:update permission, so should see all teams
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/teams",
      });
      expect(response.status()).toBe(200);

      const teams = await response.json();
      expect(Array.isArray(teams)).toBe(true);

      // Admin should see both Engineering and Marketing teams (created in auth setup)
      const teamNames = teams.map((t: { name: string }) => t.name);
      expect(teamNames).toContain(ENGINEERING_TEAM_NAME);
      expect(teamNames).toContain(MARKETING_TEAM_NAME);
    });

    test("Member only sees teams they are a member of", async ({
      memberRequest,
      makeApiRequest,
    }) => {
      // Member has limited permissions - should only see teams they're members of
      const response = await makeApiRequest({
        request: memberRequest,
        method: "get",
        urlSuffix: "/api/teams",
      });
      expect(response.status()).toBe(200);

      const teams = await response.json();
      expect(Array.isArray(teams)).toBe(true);

      // Member is only in Marketing Team (per auth setup)
      const teamNames = teams.map((t: { name: string }) => t.name);
      expect(teamNames).toContain(MARKETING_TEAM_NAME);
      // Member should NOT see Engineering Team (they're not a member)
      expect(teamNames).not.toContain(ENGINEERING_TEAM_NAME);
    });

    test("Editor sees teams they are a member of", async ({
      editorRequest,
      makeApiRequest,
    }) => {
      // Editor has limited permissions - should only see teams they're members of
      const response = await makeApiRequest({
        request: editorRequest,
        method: "get",
        urlSuffix: "/api/teams",
      });
      expect(response.status()).toBe(200);

      const teams = await response.json();
      expect(Array.isArray(teams)).toBe(true);

      // Editor is in both Engineering and Marketing Teams (per auth setup)
      const teamNames = teams.map((t: { name: string }) => t.name);
      expect(teamNames).toContain(ENGINEERING_TEAM_NAME);
      expect(teamNames).toContain(MARKETING_TEAM_NAME);
    });
  });

  test.describe("Team CRUD Operations", () => {
    test("should create, read, update, and delete a team", async ({
      request,
      makeApiRequest,
    }) => {
      // Create a team
      const createResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/teams",
        data: {
          name: "Test Team",
          description: "A team for testing purposes",
        },
      });
      expect(createResponse.status()).toBe(200);
      const team = await createResponse.json();
      expect(team.name).toBe("Test Team");
      expect(team.description).toBe("A team for testing purposes");
      expect(team.id).toBeDefined();

      // Read the team
      const readResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/teams/${team.id}`,
      });
      expect(readResponse.status()).toBe(200);
      const readTeam = await readResponse.json();
      expect(readTeam.id).toBe(team.id);
      expect(readTeam.name).toBe("Test Team");

      // Update the team
      const updateResponse = await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/teams/${team.id}`,
        data: {
          name: "Updated Team Name",
          description: "Updated description",
        },
      });
      expect(updateResponse.status()).toBe(200);
      const updatedTeam = await updateResponse.json();
      expect(updatedTeam.name).toBe("Updated Team Name");
      expect(updatedTeam.description).toBe("Updated description");

      // Delete the team
      const deleteResponse = await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/teams/${team.id}`,
      });
      expect(deleteResponse.status()).toBe(200);
      const deleteResult = await deleteResponse.json();
      expect(deleteResult.success).toBe(true);

      // Verify team is deleted
      const verifyResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/teams/${team.id}`,
        ignoreStatusCheck: true,
      });
      expect(verifyResponse.status()).toBe(404);
    });

    test("should list all teams", async ({ request, makeApiRequest }) => {
      // Create a team first
      const createResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/teams",
        data: {
          name: "List Test Team",
        },
      });
      const team = await createResponse.json();

      // List teams
      const listResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/teams",
      });
      expect(listResponse.status()).toBe(200);
      const teams = await listResponse.json();
      expect(Array.isArray(teams)).toBe(true);
      expect(teams.some((t: { id: string }) => t.id === team.id)).toBe(true);

      // Cleanup
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/teams/${team.id}`,
      });
    });

    test("should return 404 for non-existent team", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/teams/non-existent-id",
        ignoreStatusCheck: true,
      });
      expect(response.status()).toBe(404);
    });
  });

  test.describe("Team Members", () => {
    test("should add and remove a member from a team", async ({
      request,
      makeApiRequest,
    }) => {
      // Create a team
      const createTeamResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/teams",
        data: {
          name: "Member Test Team",
        },
      });
      const team = await createTeamResponse.json();

      // Get organization members to find a user ID
      const sessionResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/auth/get-session",
      });
      const session = await sessionResponse.json();
      const userId = session.user.id;

      // Add member to team
      const addMemberResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: `/api/teams/${team.id}/members`,
        data: {
          userId,
          role: "member",
        },
      });
      expect(addMemberResponse.status()).toBe(200);
      const member = await addMemberResponse.json();
      expect(member.userId).toBe(userId);

      // List team members
      const listMembersResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/teams/${team.id}/members`,
      });
      expect(listMembersResponse.status()).toBe(200);
      const members = await listMembersResponse.json();
      expect(members.some((m: { userId: string }) => m.userId === userId)).toBe(
        true,
      );

      // Remove member from team
      const removeMemberResponse = await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/teams/${team.id}/members/${userId}`,
      });
      expect(removeMemberResponse.status()).toBe(200);

      // Verify member is removed
      const verifyMembersResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/teams/${team.id}/members`,
      });
      const remainingMembers = await verifyMembersResponse.json();
      expect(
        remainingMembers.some((m: { userId: string }) => m.userId === userId),
      ).toBe(false);

      // Cleanup
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/teams/${team.id}`,
      });
    });

    test("should return 404 for members of non-existent team", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/teams/non-existent-id/members",
        ignoreStatusCheck: true,
      });
      expect(response.status()).toBe(404);
    });
  });

  test.describe("Team External Groups (Enterprise Feature)", () => {
    // These tests require enterprise license to be enabled
    // If license is not enabled, all these endpoints should return 403

    test("should manage external group mappings when enterprise license is enabled", async ({
      request,
      makeApiRequest,
    }) => {
      // Create a team first
      const createTeamResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/teams",
        data: {
          name: "External Groups Test Team",
        },
      });
      const team = await createTeamResponse.json();

      // Try to get external groups - this will succeed or fail based on license
      const getGroupsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/teams/${team.id}/external-groups`,
        ignoreStatusCheck: true,
      });

      if (getGroupsResponse.status() === 403) {
        // Enterprise license not enabled - expected behavior
        const errorBody = await getGroupsResponse.json();
        expect(errorBody.error.message).toContain("enterprise feature");
      } else if (getGroupsResponse.status() === 200) {
        // Enterprise license is enabled - test the full flow
        const groups = await getGroupsResponse.json();
        expect(Array.isArray(groups)).toBe(true);

        // Add an external group mapping
        const addGroupResponse = await makeApiRequest({
          request,
          method: "post",
          urlSuffix: `/api/teams/${team.id}/external-groups`,
          data: {
            groupIdentifier: "engineering",
          },
        });
        expect(addGroupResponse.status()).toBe(200);
        const addedGroup = await addGroupResponse.json();
        expect(addedGroup.groupIdentifier).toBe("engineering");
        expect(addedGroup.id).toBeDefined();

        // Verify group is added
        const verifyGroupsResponse = await makeApiRequest({
          request,
          method: "get",
          urlSuffix: `/api/teams/${team.id}/external-groups`,
        });
        const updatedGroups = await verifyGroupsResponse.json();
        expect(
          updatedGroups.some(
            (g: { groupIdentifier: string }) =>
              g.groupIdentifier === "engineering",
          ),
        ).toBe(true);

        // Remove the external group mapping
        const removeGroupResponse = await makeApiRequest({
          request,
          method: "delete",
          urlSuffix: `/api/teams/${team.id}/external-groups/${addedGroup.id}`,
        });
        expect(removeGroupResponse.status()).toBe(200);
        const removeResult = await removeGroupResponse.json();
        expect(removeResult.success).toBe(true);
      }

      // Cleanup
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/teams/${team.id}`,
      });
    });

    test("should prevent duplicate external group mappings", async ({
      request,
      makeApiRequest,
    }) => {
      // Create a team
      const createTeamResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/teams",
        data: {
          name: "Duplicate Group Test Team",
        },
      });
      const team = await createTeamResponse.json();

      // Try to add an external group
      const addGroupResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: `/api/teams/${team.id}/external-groups`,
        data: {
          groupIdentifier: "devops",
        },
        ignoreStatusCheck: true,
      });

      if (addGroupResponse.status() === 403) {
        // Enterprise license not enabled - skip this test
      } else if (addGroupResponse.status() === 200) {
        // Try to add the same group again (should fail with 409)
        const duplicateResponse = await makeApiRequest({
          request,
          method: "post",
          urlSuffix: `/api/teams/${team.id}/external-groups`,
          data: {
            groupIdentifier: "devops",
          },
          ignoreStatusCheck: true,
        });
        expect(duplicateResponse.status()).toBe(409);
        const errorBody = await duplicateResponse.json();
        expect(errorBody.error.message).toContain("already mapped");
      }

      // Cleanup
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/teams/${team.id}`,
      });
    });

    test("should normalize group identifiers to lowercase", async ({
      request,
      makeApiRequest,
    }) => {
      // Create a team
      const createTeamResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/teams",
        data: {
          name: "Case Insensitive Test Team",
        },
      });
      const team = await createTeamResponse.json();

      // Try to add an external group with mixed case
      const addGroupResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: `/api/teams/${team.id}/external-groups`,
        data: {
          groupIdentifier: "Engineering-Team",
        },
        ignoreStatusCheck: true,
      });

      if (addGroupResponse.status() === 403) {
        // Enterprise license not enabled - skip this test
      } else if (addGroupResponse.status() === 200) {
        const addedGroup = await addGroupResponse.json();
        // Verify group identifier is lowercased
        expect(addedGroup.groupIdentifier).toBe("engineering-team");
      }

      // Cleanup
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/teams/${team.id}`,
      });
    });
  });
});
