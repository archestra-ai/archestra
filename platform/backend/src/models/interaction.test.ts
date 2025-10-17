import AgentModel from "./agent";
import InteractionModel from "./interaction";

describe("InteractionModel", () => {
  let agentId: string;

  beforeEach(async () => {
    // Create test agent
    const agent = await AgentModel.create({ name: "Test Agent" });
    agentId = agent.id;
  });

  describe("create", () => {
    test("can create an interaction", async () => {
      const interaction = await InteractionModel.create({
        agentId,
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
      expect(interaction.agentId).toBe(agentId);
      expect(interaction.request).toBeDefined();
      expect(interaction.response).toBeDefined();
    });
  });

  describe("findAll", () => {
    test("returns all interactions", async () => {
      await InteractionModel.create({
        agentId,
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Message 1" }],
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
                content: "Response 1",
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
        agentId,
        request: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Message 2" }],
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
                content: "Response 2",
                refusal: null,
              },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
        },
        type: "openai:chatCompletions",
      });

      const interactions = await InteractionModel.findAll();
      expect(interactions).toHaveLength(2);
    });
  });

  describe("findById", () => {
    test("returns interaction by id", async () => {
      const created = await InteractionModel.create({
        agentId,
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

  describe("getAllInteractionsForAgent", () => {
    test("returns all interactions for a specific agent", async () => {
      // Create another agent
      const otherAgent = await AgentModel.create({
        name: "Other Agent",
        usersWithAccess: [],
      });

      // Create interactions for both agents
      await InteractionModel.create({
        agentId,
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
        agentId: otherAgent.id,
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
        await InteractionModel.getAllInteractionsForAgent(agentId);
      expect(agentInteractions).toHaveLength(1);
      expect(agentInteractions[0].agentId).toBe(agentId);
    });
  });

  describe("Access Control", () => {
    test("admin can see all interactions", async () => {
      const agent1 = await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        "user-1",
      );
      const agent2 = await AgentModel.create(
        { name: "Agent 2", usersWithAccess: [] },
        "user-2",
      );

      await InteractionModel.create({
        agentId: agent1.id,
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
        agentId: agent2.id,
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

      const interactions = await InteractionModel.findAll("admin-user", true);
      expect(interactions).toHaveLength(2);
    });

    test("member only sees interactions for accessible agents", async () => {
      const agent1 = await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        "user-1",
      );
      const agent2 = await AgentModel.create(
        { name: "Agent 2", usersWithAccess: [] },
        "user-2",
      );

      await InteractionModel.create({
        agentId: agent1.id,
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
        agentId: agent2.id,
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

      const interactions = await InteractionModel.findAll("user-1", false);
      expect(interactions).toHaveLength(1);
      expect(interactions[0].agentId).toBe(agent1.id);
    });

    test("member with no access sees no interactions", async () => {
      const agent1 = await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        "user-1",
      );

      await InteractionModel.create({
        agentId: agent1.id,
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

      const interactions = await InteractionModel.findAll("user-999", false);
      expect(interactions).toHaveLength(0);
    });

    test("findById returns interaction for admin", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      const interaction = await InteractionModel.create({
        agentId: agent.id,
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
        "admin-user",
        true,
      );
      expect(found).not.toBeNull();
      expect(found?.id).toBe(interaction.id);
    });

    test("findById returns interaction for user with agent access", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      const interaction = await InteractionModel.create({
        agentId: agent.id,
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
        "user-1",
        false,
      );
      expect(found).not.toBeNull();
      expect(found?.id).toBe(interaction.id);
    });

    test("findById returns null for user without agent access", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      const interaction = await InteractionModel.create({
        agentId: agent.id,
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
        "user-999",
        false,
      );
      expect(found).toBeNull();
    });
  });
});
