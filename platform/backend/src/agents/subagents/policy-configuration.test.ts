import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { resolveProviderApiKey } from "@/clients/llm-client";
import db, { schema } from "@/database";
import { ApiKeyModelModel } from "@/models";
import AgentModel from "@/models/agent";
import { beforeEach, describe, expect, test } from "@/test";
import { PolicyConfigurationService } from "./policy-configuration";

vi.mock("@/clients/llm-client", () => ({
  resolveProviderApiKey: vi.fn(),
  createDirectLLMModel: vi.fn(() => "mocked-model"),
}));

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

const NO_KEY = {
  apiKey: undefined,
  source: "environment",
  chatApiKeyId: undefined,
  baseUrl: null,
};

const MOCK_MODEL = {
  id: "model-1",
  externalId: "anthropic/claude-3-5-sonnet",
  modelId: "claude-3-5-sonnet-20241022",
  provider: "anthropic" as const,
  description: null,
  contextLength: null,
  inputModalities: null,
  outputModalities: null,
  supportsToolCalling: null,
  promptPricePerToken: null,
  completionPricePerToken: null,
  customPricePerMillionInput: null,
  customPricePerMillionOutput: null,
  lastSyncedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_BUILT_IN_AGENT = {
  systemPrompt:
    "Analyze this MCP tool: {tool.name} - {tool.description} - {mcpServerName} - {tool.parameters}",
};

/**
 * Helper: mock resolveProviderApiKey to return a key for a specific provider
 * and NO_KEY for all others.
 */
function mockProviderKey(
  provider: string,
  apiKey: string,
  chatApiKeyId: string,
) {
  vi.mocked(resolveProviderApiKey).mockImplementation(async (params) => {
    if (params.provider === provider) {
      return { apiKey, source: "org_wide", chatApiKeyId, baseUrl: null };
    }
    return NO_KEY;
  });
}

describe("PolicyConfigurationService", () => {
  let service: PolicyConfigurationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PolicyConfigurationService();
    // Default: no provider has a key
    vi.mocked(resolveProviderApiKey).mockResolvedValue(NO_KEY);
  });

  describe("isAvailable", () => {
    test("returns false when no API key configured", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const result = await service.isAvailable(org.id);

      expect(result).toBe(false);
    });

    test("returns true when a provider key exists", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      mockProviderKey("anthropic", "sk-ant-test-key", "key-123");
      vi.spyOn(ApiKeyModelModel, "getBestModel").mockResolvedValue(MOCK_MODEL);

      const result = await service.isAvailable(org.id);

      expect(result).toBe(true);
    });

    test("passes userId when provided", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      await service.isAvailable(org.id, "user-123");

      // Should have been called with userId for at least the first provider
      expect(resolveProviderApiKey).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: org.id,
          userId: "user-123",
        }),
      );
    });
  });

  describe("configurePoliciesForTool", () => {
    test("returns error when no API key available", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const result = await service.configurePoliciesForTool(
        "nonexistent-tool",
        org.id,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("LLM API key not configured");
    });

    test("returns error when tool not found", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      mockProviderKey("anthropic", "sk-ant-test-key", "key-123");
      vi.spyOn(ApiKeyModelModel, "getBestModel").mockResolvedValue(MOCK_MODEL);

      const result = await service.configurePoliciesForTool(
        "nonexistent-tool",
        org.id,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Tool not found");
    });

    test("successfully configures policies for a tool", async ({
      makeOrganization,
      makeMcpServer,
      makeTool,
    }) => {
      const org = await makeOrganization();

      mockProviderKey("anthropic", "sk-ant-test-key", "key-123");
      vi.spyOn(ApiKeyModelModel, "getBestModel").mockResolvedValue(MOCK_MODEL);
      vi.spyOn(AgentModel, "getBuiltInAgent").mockResolvedValue(
        MOCK_BUILT_IN_AGENT as never,
      );

      // Create MCP server and tool
      const mcpServer = await makeMcpServer({ name: "test-server" });
      const tool = await makeTool({ catalogId: mcpServer.catalogId });

      // Mock the generateObject call
      vi.mocked(generateObject).mockResolvedValue({
        object: {
          toolInvocationAction: "allow_when_context_is_untrusted",
          trustedDataAction: "mark_as_trusted",
          reasoning: "This tool is safe",
        },
      } as never);

      const result = await service.configurePoliciesForTool(tool.id, org.id);

      expect(result.success).toBe(true);
      expect(result.config).toEqual({
        toolInvocationAction: "allow_when_context_is_untrusted",
        trustedDataAction: "mark_as_trusted",
        reasoning: "This tool is safe",
      });

      // Verify generateObject was called
      expect(generateObject).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "mocked-model",
          schema: expect.any(Object),
          prompt: expect.any(String),
        }),
      );

      // Verify policies were created in the database
      const invocationPolicies = await db
        .select()
        .from(schema.toolInvocationPoliciesTable)
        .where(eq(schema.toolInvocationPoliciesTable.toolId, tool.id));
      expect(invocationPolicies.length).toBeGreaterThan(0);
      expect(invocationPolicies[0].action).toBe(
        "allow_when_context_is_untrusted",
      );

      const trustedDataPolicies = await db
        .select()
        .from(schema.trustedDataPoliciesTable)
        .where(eq(schema.trustedDataPoliciesTable.toolId, tool.id));
      expect(trustedDataPolicies.length).toBeGreaterThan(0);
      expect(trustedDataPolicies[0].action).toBe("mark_as_trusted");
    });

    test("maps blocking policy config to correct actions", async ({
      makeOrganization,
      makeMcpServer,
      makeTool,
    }) => {
      const org = await makeOrganization();

      mockProviderKey("openai", "sk-openai-test-key", "key-456");
      vi.spyOn(ApiKeyModelModel, "getBestModel").mockResolvedValue({
        ...MOCK_MODEL,
        id: "model-2",
        externalId: "openai/gpt-4o",
        modelId: "gpt-4o",
        provider: "openai",
      });
      vi.spyOn(AgentModel, "getBuiltInAgent").mockResolvedValue(
        MOCK_BUILT_IN_AGENT as never,
      );

      const mcpServer = await makeMcpServer({ name: "test-server" });
      const tool = await makeTool({ catalogId: mcpServer.catalogId });

      // Mock blocking policy response
      vi.mocked(generateObject).mockResolvedValue({
        object: {
          toolInvocationAction: "block_always",
          trustedDataAction: "block_always",
          reasoning: "This tool is risky",
        },
      } as never);

      await service.configurePoliciesForTool(tool.id, org.id);

      // Verify blocking policies were created
      const invocationPolicies = await db
        .select()
        .from(schema.toolInvocationPoliciesTable)
        .where(eq(schema.toolInvocationPoliciesTable.toolId, tool.id));
      expect(invocationPolicies[0].action).toBe("block_always");

      const trustedDataPolicies = await db
        .select()
        .from(schema.trustedDataPoliciesTable)
        .where(eq(schema.trustedDataPoliciesTable.toolId, tool.id));
      expect(trustedDataPolicies[0].action).toBe("block_always");
    });

    test("handles sanitize_with_dual_llm result treatment", async ({
      makeOrganization,
      makeMcpServer,
      makeTool,
    }) => {
      const org = await makeOrganization();

      mockProviderKey("anthropic", "sk-ant-test-key", "key-123");
      vi.spyOn(ApiKeyModelModel, "getBestModel").mockResolvedValue(MOCK_MODEL);
      vi.spyOn(AgentModel, "getBuiltInAgent").mockResolvedValue(
        MOCK_BUILT_IN_AGENT as never,
      );

      const mcpServer = await makeMcpServer({ name: "test-server" });
      const tool = await makeTool({ catalogId: mcpServer.catalogId });

      vi.mocked(generateObject).mockResolvedValue({
        object: {
          toolInvocationAction: "allow_when_context_is_untrusted",
          trustedDataAction: "sanitize_with_dual_llm",
          reasoning: "This tool needs sanitization",
        },
      } as never);

      await service.configurePoliciesForTool(tool.id, org.id);

      const trustedDataPolicies = await db
        .select()
        .from(schema.trustedDataPoliciesTable)
        .where(eq(schema.trustedDataPoliciesTable.toolId, tool.id));
      expect(trustedDataPolicies[0].action).toBe("sanitize_with_dual_llm");
    });

    test("handles block_when_context_is_untrusted invocation action", async ({
      makeOrganization,
      makeMcpServer,
      makeTool,
    }) => {
      const org = await makeOrganization();

      mockProviderKey("anthropic", "sk-ant-test-key", "key-123");
      vi.spyOn(ApiKeyModelModel, "getBestModel").mockResolvedValue(MOCK_MODEL);
      vi.spyOn(AgentModel, "getBuiltInAgent").mockResolvedValue(
        MOCK_BUILT_IN_AGENT as never,
      );

      const mcpServer = await makeMcpServer({ name: "test-server" });
      const tool = await makeTool({ catalogId: mcpServer.catalogId });

      vi.mocked(generateObject).mockResolvedValue({
        object: {
          toolInvocationAction: "block_when_context_is_untrusted",
          trustedDataAction: "mark_as_untrusted",
          reasoning: "External API that could leak data",
        },
      } as never);

      await service.configurePoliciesForTool(tool.id, org.id);

      const invocationPolicies = await db
        .select()
        .from(schema.toolInvocationPoliciesTable)
        .where(eq(schema.toolInvocationPoliciesTable.toolId, tool.id));
      expect(invocationPolicies[0].action).toBe(
        "block_when_context_is_untrusted",
      );

      const trustedDataPolicies = await db
        .select()
        .from(schema.trustedDataPoliciesTable)
        .where(eq(schema.trustedDataPoliciesTable.toolId, tool.id));
      expect(trustedDataPolicies[0].action).toBe("mark_as_untrusted");
    });
  });

  describe("configurePoliciesForTools", () => {
    test("returns error for all tools when service not available", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const result = await service.configurePoliciesForTools(
        ["tool-1", "tool-2"],
        org.id,
      );

      expect(result.success).toBe(false);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].success).toBe(false);
      expect(result.results[1].success).toBe(false);
    });
  });
});
