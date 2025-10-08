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
      const otherAgent = await AgentModel.create({ name: "Other Agent" });

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
      });

      const agentInteractions =
        await InteractionModel.getAllInteractionsForAgent(agentId);
      expect(agentInteractions).toHaveLength(1);
      expect(agentInteractions[0].agentId).toBe(agentId);
    });
  });
});
