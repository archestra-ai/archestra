import { beforeEach, describe, expect, test } from "@/test";
import AgentModel from "./agent";
import InteractionModel from "./interaction";
import TeamModel from "./team";

describe("InteractionModel", () => {
  let profileId: string;

  beforeEach(async ({ makeAgent }) => {
    // Create test profile
    const agent = await makeAgent();
    profileId = agent.id;
  });

  describe("create", () => {
    test("can create an interaction", async () => {
      const interaction = await InteractionModel.create({
        profileId,
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello" }],
        },
        response: {
          id: "test-response",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Hi there",
                refusal: null,
              },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
        },
        type: "openai:chatCompletions",
      });

      expect(interaction).toBeDefined();
      expect(interaction.id).toBeDefined();
      expect(interaction.profileId).toBe(profileId);
      expect(interaction.request).toBeDefined();
      expect(interaction.response).toBeDefined();
    });
  });

  describe("findById", () => {
    test("returns interaction by id", async () => {
      const created = await InteractionModel.create({
        profileId,
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Test message" }],
        },
        response: {
          id: "test-response",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Test response",
                refusal: null,
              },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
        },
        type: "openai:chatCompletions",
      });

      const found = await InteractionModel.findById(created.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
    });

    test("returns null for non-existent id", async () => {
      const found = await InteractionModel.findById(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(found).toBeNull();
    });
  });

  describe("getAllInteractionsForProfile", () => {
    test("returns all interactions for a specific agent", async () => {
      // Create another agent
      const otherAgent = await AgentModel.create({
        name: "Other Agent",
        teams: [],
      });

      // Create interactions for both agents
      await InteractionModel.create({
        profileId,
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Agent 1 message" }],
        },
        response: {
          id: "response-1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Agent 1 response",
                refusal: null,
              },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
        },
        type: "openai:chatCompletions",
      });

      await InteractionModel.create({
        profileId: otherAgent.id,
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Agent 2 message" }],
        },
        response: {
          id: "response-2",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Agent 2 response",
                refusal: null,
              },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
        },
        type: "openai:chatCompletions",
      });

      const agentInteractions =
        await InteractionModel.getAllInteractionsForProfile(profileId);
      expect(agentInteractions).toHaveLength(1);
      expect(agentInteractions[0].profileId).toBe(profileId);
    });
  });

  describe("Access Control", () => {
    test("admin can see all interactions", async ({ makeAdmin }) => {
      const admin = await makeAdmin();

      const agent1 = await AgentModel.create({
        name: "Agent 1",
        teams: [],
      });
      const agent2 = await AgentModel.create({
        name: "Agent 2",
        teams: [],
      });

      await InteractionModel.create({
        profileId: agent1.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      await InteractionModel.create({
        profileId: agent2.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r2",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const interactions = await InteractionModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
      );
      expect(interactions.data).toHaveLength(2);
    });

    test("member only sees interactions for accessible profiles", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const user1 = await makeUser();
      const user2 = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      // Create teams and add users
      const team1 = await makeTeam(org.id, admin.id, { name: "Team 1" });
      await TeamModel.addMember(team1.id, user1.id);

      const team2 = await makeTeam(org.id, admin.id, { name: "Team 2" });
      await TeamModel.addMember(team2.id, user2.id);

      // Create agents with team assignments
      const agent1 = await AgentModel.create({
        name: "Agent 1",
        teams: [team1.id],
      });
      const agent2 = await AgentModel.create({
        name: "Agent 2",
        teams: [team2.id],
      });

      await InteractionModel.create({
        profileId: agent1.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      await InteractionModel.create({
        profileId: agent2.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r2",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const interactions = await InteractionModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        user1.id,
        false,
      );
      expect(interactions.data).toHaveLength(1);
      expect(interactions.data[0].profileId).toBe(agent1.id);
    });

    test("member with no access sees no interactions", async ({ makeUser }) => {
      const user = await makeUser();

      const agent1 = await AgentModel.create({ name: "Agent 1", teams: [] });

      await InteractionModel.create({
        profileId: agent1.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const interactions = await InteractionModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        user.id,
        false,
      );
      expect(interactions.data).toHaveLength(0);
    });

    test("findById returns interaction for admin", async ({ makeAdmin }) => {
      const admin = await makeAdmin();

      const agent = await AgentModel.create({ name: "Test Agent", teams: [] });

      const interaction = await InteractionModel.create({
        profileId: agent.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const found = await InteractionModel.findById(
        interaction.id,
        admin.id,
        true,
      );
      expect(found).not.toBeNull();
      expect(found?.id).toBe(interaction.id);
    });

    test("findById returns interaction for user with profile access", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      // Create team and add user
      const team = await makeTeam(org.id, admin.id);
      await TeamModel.addMember(team.id, user.id);

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [team.id],
      });

      const interaction = await InteractionModel.create({
        profileId: agent.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const found = await InteractionModel.findById(
        interaction.id,
        user.id,
        false,
      );
      expect(found).not.toBeNull();
      expect(found?.id).toBe(interaction.id);
    });

    test("findById returns null for user without profile access", async ({
      makeUser,
    }) => {
      const user = await makeUser();

      const agent = await AgentModel.create({ name: "Test Agent", teams: [] });

      const interaction = await InteractionModel.create({
        profileId: agent.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const found = await InteractionModel.findById(
        interaction.id,
        user.id,
        false,
      );
      expect(found).toBeNull();
    });
  });

  describe("findAllPaginated filters", () => {
    test("filters by profileId", async ({ makeAdmin }) => {
      const admin = await makeAdmin();

      const agent1 = await AgentModel.create({ name: "Agent 1", teams: [] });
      const agent2 = await AgentModel.create({ name: "Agent 2", teams: [] });

      await InteractionModel.create({
        profileId: agent1.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      await InteractionModel.create({
        profileId: agent2.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r2",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const interactions = await InteractionModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { profileId: agent1.id },
      );

      expect(interactions.data).toHaveLength(1);
      expect(interactions.data[0].profileId).toBe(agent1.id);
    });

    test("filters by externalAgentId", async ({ makeAdmin }) => {
      const admin = await makeAdmin();

      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      await InteractionModel.create({
        profileId: agent.id,
        externalAgentId: "my-app-prod",
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      await InteractionModel.create({
        profileId: agent.id,
        externalAgentId: "my-app-staging",
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r2",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      await InteractionModel.create({
        profileId: agent.id,
        // No externalAgentId
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r3",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const interactions = await InteractionModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { externalAgentId: "my-app-prod" },
      );

      expect(interactions.data).toHaveLength(1);
      expect(interactions.data[0].externalAgentId).toBe("my-app-prod");
    });

    test("filters by both profileId and externalAgentId", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();

      const agent1 = await AgentModel.create({ name: "Agent 1", teams: [] });
      const agent2 = await AgentModel.create({ name: "Agent 2", teams: [] });

      // Agent 1 with external ID
      await InteractionModel.create({
        profileId: agent1.id,
        externalAgentId: "my-app",
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Agent 1 without external ID
      await InteractionModel.create({
        profileId: agent1.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r2",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Agent 2 with same external ID
      await InteractionModel.create({
        profileId: agent2.id,
        externalAgentId: "my-app",
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r3",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const interactions = await InteractionModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { profileId: agent1.id, externalAgentId: "my-app" },
      );

      expect(interactions.data).toHaveLength(1);
      expect(interactions.data[0].profileId).toBe(agent1.id);
      expect(interactions.data[0].externalAgentId).toBe("my-app");
    });

    test("filters respect access control for non-admin users", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      const team = await makeTeam(org.id, admin.id);
      await TeamModel.addMember(team.id, user.id);

      const accessibleAgent = await AgentModel.create({
        name: "Accessible Agent",
        teams: [team.id],
      });
      const inaccessibleAgent = await AgentModel.create({
        name: "Inaccessible Agent",
        teams: [],
      });

      // Interaction for accessible agent
      await InteractionModel.create({
        profileId: accessibleAgent.id,
        externalAgentId: "my-app",
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Interaction for inaccessible agent with same external ID
      await InteractionModel.create({
        profileId: inaccessibleAgent.id,
        externalAgentId: "my-app",
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r2",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // User should only see the accessible agent's interaction
      const interactions = await InteractionModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        user.id,
        false,
        { externalAgentId: "my-app" },
      );

      expect(interactions.data).toHaveLength(1);
      expect(interactions.data[0].profileId).toBe(accessibleAgent.id);
    });

    test("filters by userId", async ({ makeAdmin, makeUser }) => {
      const admin = await makeAdmin();
      const user1 = await makeUser();
      const user2 = await makeUser();

      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // Interaction with user1
      await InteractionModel.create({
        profileId: agent.id,
        userId: user1.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Interaction with user2
      await InteractionModel.create({
        profileId: agent.id,
        userId: user2.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r2",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Interaction without userId
      await InteractionModel.create({
        profileId: agent.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r3",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const interactions = await InteractionModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { userId: user1.id },
      );

      expect(interactions.data).toHaveLength(1);
      expect(interactions.data[0].userId).toBe(user1.id);
    });
  });

  describe("getUniqueUserIds", () => {
    test("returns unique user IDs with names", async ({
      makeAdmin,
      makeUser,
    }) => {
      const admin = await makeAdmin();
      const user1 = await makeUser({ name: "User One" });
      const user2 = await makeUser({ name: "User Two" });

      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // Create interactions for both users
      await InteractionModel.create({
        profileId: agent.id,
        userId: user1.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      await InteractionModel.create({
        profileId: agent.id,
        userId: user2.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r2",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Create another interaction for user1 (should not duplicate in result)
      await InteractionModel.create({
        profileId: agent.id,
        userId: user1.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r3",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const userIds = await InteractionModel.getUniqueUserIds(admin.id, true);

      expect(userIds).toHaveLength(2);
      // Results should be sorted by name
      expect(userIds.map((u) => u.name)).toContain("User One");
      expect(userIds.map((u) => u.name)).toContain("User Two");
      expect(userIds.every((u) => u.id && u.name)).toBe(true);
    });

    test("excludes interactions without userId", async ({
      makeAdmin,
      makeUser,
    }) => {
      const admin = await makeAdmin();
      const user = await makeUser({ name: "Test User" });

      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // Interaction with userId
      await InteractionModel.create({
        profileId: agent.id,
        userId: user.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Interaction without userId
      await InteractionModel.create({
        profileId: agent.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r2",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const userIds = await InteractionModel.getUniqueUserIds(admin.id, true);

      expect(userIds).toHaveLength(1);
      expect(userIds[0].name).toBe("Test User");
    });

    test("respects access control for non-admin users", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser({ name: "Regular User" });
      const otherUser = await makeUser({ name: "Other User" });
      const admin = await makeAdmin();
      const org = await makeOrganization();

      const team = await makeTeam(org.id, admin.id);
      await TeamModel.addMember(team.id, user.id);

      const accessibleAgent = await AgentModel.create({
        name: "Accessible Agent",
        teams: [team.id],
      });
      const inaccessibleAgent = await AgentModel.create({
        name: "Inaccessible Agent",
        teams: [],
      });

      // Interaction for accessible agent with otherUser
      await InteractionModel.create({
        profileId: accessibleAgent.id,
        userId: otherUser.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Interaction for inaccessible agent with admin
      await InteractionModel.create({
        profileId: inaccessibleAgent.id,
        userId: admin.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r2",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // User should only see userIds from accessible agent's interactions
      const userIds = await InteractionModel.getUniqueUserIds(user.id, false);

      expect(userIds).toHaveLength(1);
      expect(userIds[0].name).toBe("Other User");
    });
  });
});
