import { beforeEach, describe, expect, test } from "@/test";
import AgentModel from "./agent";
import ConversationModel from "./conversation";
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

  describe("date range filtering", () => {
    test("filters by startDate", async ({ makeAdmin }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // Create interactions with different timestamps
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

      // Interaction from 2 days ago
      await InteractionModel.create({
        profileId: agent.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r1",
          object: "chat.completion",
          created: twoDaysAgo.getTime(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Interaction from yesterday
      await InteractionModel.create({
        profileId: agent.id,
        request: { model: "gpt-4", messages: [] },
        response: {
          id: "r2",
          object: "chat.completion",
          created: yesterday.getTime(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Filter for interactions from yesterday onwards
      const interactions = await InteractionModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { startDate: yesterday },
      );

      // Should include yesterday's interaction and possibly the one just created
      expect(interactions.data.length).toBeGreaterThanOrEqual(1);
    });

    test("filters by endDate", async ({ makeAdmin }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // Create interactions
      await InteractionModel.create({
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

      // Filter for interactions before a past date (should exclude all current interactions)
      const pastDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const interactions = await InteractionModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { endDate: pastDate },
      );

      // Should not include the just-created interaction
      expect(
        interactions.data.every(
          (i) => new Date(i.createdAt).getTime() <= pastDate.getTime(),
        ),
      ).toBe(true);
    });

    test("filters by date range (startDate and endDate)", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // Create an interaction
      await InteractionModel.create({
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

      // Filter for interactions in a date range that includes now
      const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // yesterday
      const endDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // tomorrow

      const interactions = await InteractionModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { startDate, endDate },
      );

      expect(interactions.data.length).toBeGreaterThanOrEqual(1);
      expect(
        interactions.data.every((i) => {
          const createdAt = new Date(i.createdAt).getTime();
          return (
            createdAt >= startDate.getTime() && createdAt <= endDate.getTime()
          );
        }),
      ).toBe(true);
    });

    test("date filter works with other filters", async ({ makeAdmin }) => {
      const admin = await makeAdmin();
      const agent1 = await AgentModel.create({ name: "Agent 1", teams: [] });
      const agent2 = await AgentModel.create({ name: "Agent 2", teams: [] });

      // Create interactions for both agents
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

      // Filter by profileId and date range
      const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const endDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const interactions = await InteractionModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { profileId: agent1.id, startDate, endDate },
      );

      expect(interactions.data).toHaveLength(1);
      expect(interactions.data[0].profileId).toBe(agent1.id);
    });
  });

  describe("getSessions date filtering", () => {
    test("filters sessions by date range", async ({ makeAdmin }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // Create interaction
      await InteractionModel.create({
        profileId: agent.id,
        sessionId: "test-session",
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

      // Filter for sessions in a date range that includes now
      const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const endDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const sessions = await InteractionModel.getSessions(
        { limit: 100, offset: 0 },
        admin.id,
        true,
        { startDate, endDate },
      );

      expect(sessions.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("getSessions search filtering", () => {
    test("searches by request message content (case insensitive)", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      await InteractionModel.create({
        profileId: agent.id,
        sessionId: "session-1",
        request: {
          model: "gpt-4",
          messages: [
            { role: "user", content: "Tell me about quantum computing" },
          ],
        },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Quantum computing is...",
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
        profileId: agent.id,
        sessionId: "session-2",
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "How do I make a sandwich?" }],
        },
        response: {
          id: "r2",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "To make a sandwich...",
                refusal: null,
              },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
        },
        type: "openai:chatCompletions",
      });

      // Search with lowercase
      const sessions = await InteractionModel.getSessions(
        { limit: 100, offset: 0 },
        admin.id,
        true,
        { search: "quantum" },
      );

      expect(sessions.data).toHaveLength(1);
      expect(sessions.data[0].sessionId).toBe("session-1");
    });

    test("searches by response content", async ({ makeAdmin }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      await InteractionModel.create({
        profileId: agent.id,
        sessionId: "session-with-special-response",
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello" }],
        },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content:
                  "This response contains UniqueSearchableKeyword12345 for testing",
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
        profileId: agent.id,
        sessionId: "other-session",
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Test message" }],
        },
        response: {
          id: "r2",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Normal response",
                refusal: null,
              },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
        },
        type: "openai:chatCompletions",
      });

      const sessions = await InteractionModel.getSessions(
        { limit: 100, offset: 0 },
        admin.id,
        true,
        { search: "UniqueSearchableKeyword12345" },
      );

      expect(sessions.data).toHaveLength(1);
      expect(sessions.data[0].sessionId).toBe("session-with-special-response");
    });

    test("search returns multiple matching sessions", async ({ makeAdmin }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      await InteractionModel.create({
        profileId: agent.id,
        sessionId: "python-session-1",
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Help me with Python code" }],
        },
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
        sessionId: "python-session-2",
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Python debugging question" }],
        },
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
        sessionId: "javascript-session",
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "JavaScript question" }],
        },
        response: {
          id: "r3",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const sessions = await InteractionModel.getSessions(
        { limit: 100, offset: 0 },
        admin.id,
        true,
        { search: "python" },
      );

      expect(sessions.data).toHaveLength(2);
    });

    test("search with no matches returns empty", async ({ makeAdmin }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      await InteractionModel.create({
        profileId: agent.id,
        sessionId: "test-session",
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello there" }],
        },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const sessions = await InteractionModel.getSessions(
        { limit: 100, offset: 0 },
        admin.id,
        true,
        { search: "nonexistentsearchterm987654" },
      );

      expect(sessions.data).toHaveLength(0);
    });

    test("search combined with other filters", async ({ makeAdmin }) => {
      const admin = await makeAdmin();
      const agent1 = await AgentModel.create({ name: "Agent 1", teams: [] });
      const agent2 = await AgentModel.create({ name: "Agent 2", teams: [] });

      // Agent 1 with searchable content
      await InteractionModel.create({
        profileId: agent1.id,
        sessionId: "agent1-ml-session",
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Machine learning question" }],
        },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Agent 2 with same searchable content
      await InteractionModel.create({
        profileId: agent2.id,
        sessionId: "agent2-ml-session",
        request: {
          model: "gpt-4",
          messages: [
            { role: "user", content: "Another machine learning topic" },
          ],
        },
        response: {
          id: "r2",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Search + profile filter
      const sessions = await InteractionModel.getSessions(
        { limit: 100, offset: 0 },
        admin.id,
        true,
        { search: "machine learning", profileId: agent1.id },
      );

      expect(sessions.data).toHaveLength(1);
      expect(sessions.data[0].profileId).toBe(agent1.id);
    });

    test("search combined with date filter", async ({ makeAdmin }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      await InteractionModel.create({
        profileId: agent.id,
        sessionId: "searchable-session",
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Unique search term XYZ789" }],
        },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const endDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const sessions = await InteractionModel.getSessions(
        { limit: 100, offset: 0 },
        admin.id,
        true,
        { search: "XYZ789", startDate, endDate },
      );

      expect(sessions.data.length).toBeGreaterThanOrEqual(1);
      expect(sessions.data[0].sessionId).toBe("searchable-session");
    });

    test("searches by conversation title (case insensitive)", async ({
      makeAdmin,
      makeUser,
      makeOrganization,
    }) => {
      const admin = await makeAdmin();
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // Create a conversation with a searchable title
      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "UniqueConversationTitle789 about quantum physics",
        selectedModel: "gpt-4",
      });

      // Create an interaction linked to the conversation via sessionId
      await InteractionModel.create({
        profileId: agent.id,
        sessionId: conversation.id, // Session ID = Conversation ID for chat sessions
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Tell me about atoms" }],
        },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Atoms are...",
                refusal: null,
              },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
        },
        type: "openai:chatCompletions",
      });

      // Create another conversation without the search term in title
      const conversation2 = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Discussion about cooking",
        selectedModel: "gpt-4",
      });

      await InteractionModel.create({
        profileId: agent.id,
        sessionId: conversation2.id,
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "How to make pasta?" }],
        },
        response: {
          id: "r2",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Search by conversation title (case insensitive)
      const sessions = await InteractionModel.getSessions(
        { limit: 100, offset: 0 },
        admin.id,
        true,
        { search: "uniqueconversationtitle789" },
      );

      expect(sessions.data).toHaveLength(1);
      expect(sessions.data[0].sessionId).toBe(conversation.id);
      expect(sessions.data[0].conversationTitle).toBe(
        "UniqueConversationTitle789 about quantum physics",
      );
    });

    test("searches match conversation title OR request/response content", async ({
      makeAdmin,
      makeUser,
      makeOrganization,
    }) => {
      const admin = await makeAdmin();
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // Conversation with "SharedSearchTerm" in title
      const conversation1 = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Discussion about SharedSearchTerm",
        selectedModel: "gpt-4",
      });

      await InteractionModel.create({
        profileId: agent.id,
        sessionId: conversation1.id,
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Regular question" }],
        },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Conversation with "SharedSearchTerm" in request content
      const conversation2 = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Another discussion",
        selectedModel: "gpt-4",
      });

      await InteractionModel.create({
        profileId: agent.id,
        sessionId: conversation2.id,
        request: {
          model: "gpt-4",
          messages: [
            { role: "user", content: "Question about SharedSearchTerm topic" },
          ],
        },
        response: {
          id: "r2",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Conversation without the search term
      const conversation3 = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Unrelated conversation",
        selectedModel: "gpt-4",
      });

      await InteractionModel.create({
        profileId: agent.id,
        sessionId: conversation3.id,
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Different question" }],
        },
        response: {
          id: "r3",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Search should find both conversations (title match + request content match)
      const sessions = await InteractionModel.getSessions(
        { limit: 100, offset: 0 },
        admin.id,
        true,
        { search: "SharedSearchTerm" },
      );

      expect(sessions.data).toHaveLength(2);
      const sessionIds = sessions.data.map((s) => s.sessionId);
      expect(sessionIds).toContain(conversation1.id);
      expect(sessionIds).toContain(conversation2.id);
    });

    test("conversation title search returns correct total count for pagination", async ({
      makeAdmin,
      makeUser,
      makeOrganization,
    }) => {
      // This test verifies that the count query includes the LEFT JOIN with conversations table
      // when searching by conversation title, ensuring pagination total is accurate
      const admin = await makeAdmin();
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // Create multiple conversations with searchable titles
      const searchTerm = "PaginationTestTitle";

      for (let i = 0; i < 5; i++) {
        const conversation = await ConversationModel.create({
          userId: user.id,
          organizationId: org.id,
          agentId: agent.id,
          title: `${searchTerm} conversation ${i}`,
          selectedModel: "gpt-4",
        });

        await InteractionModel.create({
          profileId: agent.id,
          sessionId: conversation.id,
          request: {
            model: "gpt-4",
            messages: [{ role: "user", content: `Question ${i}` }],
          },
          response: {
            id: `r${i}`,
            object: "chat.completion",
            created: Date.now(),
            model: "gpt-4",
            choices: [],
          },
          type: "openai:chatCompletions",
        });
      }

      // Create a conversation without the search term (should not be included)
      const otherConversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Unrelated title",
        selectedModel: "gpt-4",
      });

      await InteractionModel.create({
        profileId: agent.id,
        sessionId: otherConversation.id,
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Unrelated question" }],
        },
        response: {
          id: "r-other",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Search with pagination limit smaller than total results
      const sessions = await InteractionModel.getSessions(
        { limit: 2, offset: 0 },
        admin.id,
        true,
        { search: searchTerm },
      );

      // Should return only 2 items due to limit, but total should be 5
      expect(sessions.data).toHaveLength(2);
      expect(sessions.pagination.total).toBe(5);

      // Verify second page works correctly
      const sessionsPage2 = await InteractionModel.getSessions(
        { limit: 2, offset: 2 },
        admin.id,
        true,
        { search: searchTerm },
      );

      expect(sessionsPage2.data).toHaveLength(2);
      expect(sessionsPage2.pagination.total).toBe(5);
    });
  });

  describe("getSessions lastInteraction and claudeCodeTitle", () => {
    test("returns lastInteractionRequest and lastInteractionType for session with single interaction", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      await InteractionModel.create({
        profileId: agent.id,
        sessionId: "single-interaction-session",
        request: {
          model: "gpt-4",
          messages: [
            {
              role: "user",
              content:
                "This is a meaningful message with more than 20 characters",
            },
          ],
        },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Response",
                refusal: null,
              },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
        },
        type: "openai:chatCompletions",
      });

      const sessions = await InteractionModel.getSessions(
        { limit: 100, offset: 0 },
        admin.id,
        true,
        { sessionId: "single-interaction-session" },
      );

      expect(sessions.data).toHaveLength(1);
      expect(sessions.data[0].lastInteractionRequest).not.toBeNull();
      expect(sessions.data[0].lastInteractionType).toBe(
        "openai:chatCompletions",
      );
    });

    test("skips prompt suggestion generator requests when finding lastInteractionRequest", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // First: a real user request (should be the lastInteractionRequest)
      await InteractionModel.create({
        profileId: agent.id,
        sessionId: "session-with-prompt-suggestion",
        request: {
          model: "gpt-4",
          messages: [
            {
              role: "user",
              content:
                "This is a real user question that should be shown as last request",
            },
          ],
        },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Second: a prompt suggestion request (should be skipped)
      await InteractionModel.create({
        profileId: agent.id,
        sessionId: "session-with-prompt-suggestion",
        request: {
          model: "gpt-4",
          messages: [
            {
              role: "user",
              content:
                "You are a prompt suggestion generator. Generate suggestions.",
            },
          ],
        },
        response: {
          id: "r2",
          object: "chat.completion",
          created: Date.now() + 1000,
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const sessions = await InteractionModel.getSessions(
        { limit: 100, offset: 0 },
        admin.id,
        true,
        { sessionId: "session-with-prompt-suggestion" },
      );

      expect(sessions.data).toHaveLength(1);
      const lastRequest = sessions.data[0].lastInteractionRequest as {
        messages: Array<{ content: string }>;
      };
      expect(lastRequest.messages[0].content).toContain("real user question");
    });

    test("skips title generation requests when finding lastInteractionRequest", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // First: a real user request
      await InteractionModel.create({
        profileId: agent.id,
        sessionId: "session-with-title-gen",
        request: {
          model: "gpt-4",
          messages: [
            {
              role: "user",
              content:
                "This is a real question about programming that should appear",
            },
          ],
        },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      // Second: a title generation request (should be skipped for lastInteractionRequest)
      await InteractionModel.create({
        profileId: agent.id,
        sessionId: "session-with-title-gen",
        request: {
          model: "gpt-4",
          messages: [
            {
              role: "user",
              content: "Please write a 5-10 word title for this conversation.",
            },
          ],
        },
        response: {
          id: "r2",
          object: "chat.completion",
          created: Date.now() + 1000,
          model: "gpt-4",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "My Generated Title Here",
                refusal: null,
              },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
        },
        type: "openai:chatCompletions",
      });

      const sessions = await InteractionModel.getSessions(
        { limit: 100, offset: 0 },
        admin.id,
        true,
        { sessionId: "session-with-title-gen" },
      );

      expect(sessions.data).toHaveLength(1);
      const lastRequest = sessions.data[0].lastInteractionRequest as {
        messages: Array<{ content: string }>;
      };
      expect(lastRequest.messages[0].content).toContain("real question");
    });

    test("extracts claudeCodeTitle from title generation response", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // Real request
      await InteractionModel.create({
        profileId: agent.id,
        sessionId: "session-with-claude-title",
        request: {
          model: "claude-3-5-sonnet",
          messages: [
            {
              role: "user",
              content: "Help me write a Python script for data analysis",
            },
          ],
        },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "claude-3-5-sonnet",
          choices: [],
        },
        type: "anthropic:messages",
      });

      // Title generation request with response containing the title
      await InteractionModel.create({
        profileId: agent.id,
        sessionId: "session-with-claude-title",
        request: {
          model: "claude-3-5-sonnet",
          messages: [
            {
              role: "user",
              content:
                "Please write a 5-10 word title summarizing this conversation.",
            },
          ],
        },
        response: {
          id: "msg_title",
          content: [{ type: "text", text: "Python Data Analysis Script Help" }],
          model: "claude-3-5-sonnet",
          role: "assistant",
          stop_reason: "end_turn",
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 100, output_tokens: 10 },
        },
        type: "anthropic:messages",
      });

      const sessions = await InteractionModel.getSessions(
        { limit: 100, offset: 0 },
        admin.id,
        true,
        { sessionId: "session-with-claude-title" },
      );

      expect(sessions.data).toHaveLength(1);
      expect(sessions.data[0].claudeCodeTitle).toBe(
        "Python Data Analysis Script Help",
      );
    });

    test("handles title generation request with malformed response (no text)", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // Real request (should be returned as lastInteractionRequest)
      await InteractionModel.create({
        profileId: agent.id,
        sessionId: "session-malformed-title",
        request: {
          model: "claude-3-5-sonnet",
          messages: [
            {
              role: "user",
              content: "Help me write a Python script for data analysis",
            },
          ],
        },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "claude-3-5-sonnet",
          choices: [],
        },
        type: "anthropic:messages",
      });

      // Title generation request with malformed response (missing text)
      await InteractionModel.create({
        profileId: agent.id,
        sessionId: "session-malformed-title",
        request: {
          model: "claude-3-5-sonnet",
          messages: [
            {
              role: "user",
              content:
                "Please write a 5-10 word title summarizing this conversation.",
            },
          ],
        },
        response: {
          id: "msg_title",
          content: [], // Empty content array - no text
          model: "claude-3-5-sonnet",
          role: "assistant",
          stop_reason: "end_turn",
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 100, output_tokens: 0 },
        },
        type: "anthropic:messages",
      });

      const sessions = await InteractionModel.getSessions(
        { limit: 100, offset: 0 },
        admin.id,
        true,
        { sessionId: "session-malformed-title" },
      );

      expect(sessions.data).toHaveLength(1);
      // Should have the main interaction but null for title
      expect(sessions.data[0].lastInteractionRequest).not.toBeNull();
      expect(sessions.data[0].claudeCodeTitle).toBeNull();
    });

    test("returns null for lastInteractionRequest when all messages are too short", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // Short utility message (< 20 chars)
      await InteractionModel.create({
        profileId: agent.id,
        sessionId: "short-session",
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "hi" }],
        },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const sessions = await InteractionModel.getSessions(
        { limit: 100, offset: 0 },
        admin.id,
        true,
        { sessionId: "short-session" },
      );

      expect(sessions.data).toHaveLength(1);
      expect(sessions.data[0].lastInteractionRequest).toBeNull();
    });

    test("handles single interactions without sessionId (null session)", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      const interaction = await InteractionModel.create({
        profileId: agent.id,
        // No sessionId - this is a single interaction
        request: {
          model: "gpt-4",
          messages: [
            {
              role: "user",
              content: "This is a standalone interaction without a session ID",
            },
          ],
        },
        response: {
          id: "r1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });

      const sessions = await InteractionModel.getSessions(
        { limit: 100, offset: 0 },
        admin.id,
        true,
      );

      // Find our session (identified by interactionId since sessionId is null)
      const ourSession = sessions.data.find(
        (s) => s.interactionId === interaction.id,
      );
      expect(ourSession).toBeDefined();
      expect(ourSession?.sessionId).toBeNull();
      expect(ourSession?.interactionId).toBe(interaction.id);
      expect(ourSession?.lastInteractionRequest).not.toBeNull();
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
