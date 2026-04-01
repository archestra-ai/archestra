import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import { beforeEach, describe, expect, test } from "@/test";
import { resolveSmartDefaultLlm } from "@/utils/llm-resolution";
import { PolicyConfigurationService } from "./policy-configuration";

vi.mock("@/clients/llm-client", () => ({
  createLLMModel: vi.fn(() => "mocked-model"),
}));

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

vi.mock("@/utils/llm-resolution", () => ({
  resolveSmartDefaultLlm: vi.fn(),
}));

const MOCK_BUILT_IN_AGENT = {
  systemPrompt:
    "Analyze this MCP tool: {{tool.name}} - {{tool.description}} - {{mcpServerName}} - {{tool.parameters}}",
};

const MOCK_RESOLVED_LLM = {
  provider: "anthropic" as const,
  apiKey: "sk-ant-test-key",
  modelName: "claude-3-5-sonnet-20241022",
  baseUrl: null,
};

describe("PolicyConfigurationService", () => {
  let service: PolicyConfigurationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PolicyConfigurationService();
    // Default: no LLM available
    vi.mocked(resolveSmartDefaultLlm).mockResolvedValue(null);
  });

  describe("resolveLlm", () => {
    test("returns null when resolveSmartDefaultLlm returns null", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const result = await service.resolveLlm({ organizationId: org.id });

      expect(result).toBeNull();
    });

    test("returns resolved config when resolveSmartDefaultLlm returns a result", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      vi.mocked(resolveSmartDefaultLlm).mockResolvedValue(MOCK_RESOLVED_LLM);

      const result = await service.resolveLlm({ organizationId: org.id });

      expect(result).toEqual(MOCK_RESOLVED_LLM);
    });

    test("passes userId when provided", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      await service.resolveLlm({
        organizationId: org.id,
        userId: "user-123",
      });

      expect(resolveSmartDefaultLlm).toHaveBeenCalledWith({
        organizationId: org.id,
        userId: "user-123",
      });
    });
  });

  describe("configurePoliciesForTool", () => {
    test("returns error when no API key available", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const result = await service.configurePoliciesForTool({
        toolId: "nonexistent-tool",
        organizationId: org.id,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("LLM API key not configured");
    });

    test("returns error when tool not found", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      vi.mocked(resolveSmartDefaultLlm).mockResolvedValue(MOCK_RESOLVED_LLM);

      const result = await service.configurePoliciesForTool({
        toolId: "nonexistent-tool",
        organizationId: org.id,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Tool not found");
    });

    test("successfully configures policies for a tool", async ({
      makeOrganization,
      makeMcpServer,
      makeTool,
    }) => {
      const org = await makeOrganization();

      vi.mocked(resolveSmartDefaultLlm).mockResolvedValue(MOCK_RESOLVED_LLM);
      vi.spyOn(AgentModel, "getBuiltInAgent").mockResolvedValue(
        MOCK_BUILT_IN_AGENT as never,
      );

      // Create MCP server and tool
      const mcpServer = await makeMcpServer({ name: "test-server" });
      const tool = await makeTool({ catalogId: mcpServer.catalogId });

      // Mock the generateObject call (uses new LLM-facing enum values)
      vi.mocked(generateObject).mockResolvedValue({
        object: {
          toolInvocationAction: "allow_when_context_is_sensitive",
          trustedDataAction: "mark_as_safe",
          reasoning: "This tool is safe",
        },
      } as never);

      const result = await service.configurePoliciesForTool({
        toolId: tool.id,
        organizationId: org.id,
      });

      expect(result.success).toBe(true);
      expect(result.config).toEqual({
        toolInvocationAction: "allow_when_context_is_sensitive",
        trustedDataAction: "mark_as_safe",
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

      vi.mocked(resolveSmartDefaultLlm).mockResolvedValue({
        provider: "openai",
        apiKey: "sk-openai-test-key",
        modelName: "gpt-4o",
        baseUrl: null,
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

      await service.configurePoliciesForTool({
        toolId: tool.id,
        organizationId: org.id,
      });

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

      vi.mocked(resolveSmartDefaultLlm).mockResolvedValue(MOCK_RESOLVED_LLM);
      vi.spyOn(AgentModel, "getBuiltInAgent").mockResolvedValue(
        MOCK_BUILT_IN_AGENT as never,
      );

      const mcpServer = await makeMcpServer({ name: "test-server" });
      const tool = await makeTool({ catalogId: mcpServer.catalogId });

      vi.mocked(generateObject).mockResolvedValue({
        object: {
          toolInvocationAction: "allow_when_context_is_sensitive",
          trustedDataAction: "sanitize_with_dual_llm",
          reasoning: "This tool needs sanitization",
        },
      } as never);

      await service.configurePoliciesForTool({
        toolId: tool.id,
        organizationId: org.id,
      });

      const trustedDataPolicies = await db
        .select()
        .from(schema.trustedDataPoliciesTable)
        .where(eq(schema.trustedDataPoliciesTable.toolId, tool.id));
      expect(trustedDataPolicies[0].action).toBe("sanitize_with_dual_llm");
    });

    test("handles block_when_context_is_sensitive invocation action", async ({
      makeOrganization,
      makeMcpServer,
      makeTool,
    }) => {
      const org = await makeOrganization();

      vi.mocked(resolveSmartDefaultLlm).mockResolvedValue(MOCK_RESOLVED_LLM);
      vi.spyOn(AgentModel, "getBuiltInAgent").mockResolvedValue(
        MOCK_BUILT_IN_AGENT as never,
      );

      const mcpServer = await makeMcpServer({ name: "test-server" });
      const tool = await makeTool({ catalogId: mcpServer.catalogId });

      vi.mocked(generateObject).mockResolvedValue({
        object: {
          toolInvocationAction: "block_when_context_is_sensitive",
          trustedDataAction: "mark_as_sensitive",
          reasoning: "External API that could leak data",
        },
      } as never);

      await service.configurePoliciesForTool({
        toolId: tool.id,
        organizationId: org.id,
      });

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

      const result = await service.configurePoliciesForTools({
        toolIds: ["tool-1", "tool-2"],
        organizationId: org.id,
      });

      expect(result.success).toBe(false);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].success).toBe(false);
      expect(result.results[1].success).toBe(false);
    });
  });
});
