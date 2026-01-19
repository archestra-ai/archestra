import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { policyConfigSubagent } from "@/agents/subagents";
import db, { schema } from "@/database";
import { secretManager } from "@/secrets-manager";
import { beforeEach, describe, expect, test } from "@/test";
import { ToolAutoPolicyService } from "./agent-tool-auto-policy";

// Only mock external dependencies that make network calls
vi.mock("@/secrets-manager", () => ({
  secretManager: vi.fn(() => ({
    getSecret: vi.fn(),
  })),
}));

vi.mock("@/agents/subagents", () => ({
  policyConfigSubagent: {
    analyze: vi.fn(),
  },
}));

describe("ToolAutoPolicyService", () => {
  let service: ToolAutoPolicyService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ToolAutoPolicyService();
  });

  describe("isAvailable", () => {
    test("returns false when no chat API key configured", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const result = await service.isAvailable(org.id);

      expect(result).toBe(false);
    });

    test("returns true when org-wide Anthropic API key exists", async ({
      makeOrganization,
      makeSecret,
      makeChatApiKey,
    }) => {
      const org = await makeOrganization();

      // Create a secret
      const secret = await makeSecret({
        name: "Anthropic API Key",
        secret: { apiKey: "sk-ant-test-key" },
      });

      // Create the chat API key record
      await makeChatApiKey(org.id, secret.id, {
        name: "Anthropic Key",
        provider: "anthropic",
        scope: "org_wide",
      });

      // Mock the secret manager to return the API key
      vi.mocked(secretManager).mockReturnValue({
        getSecret: vi.fn().mockResolvedValue({
          secret: { apiKey: "sk-ant-test-key" },
        }),
      } as unknown as ReturnType<typeof secretManager>);

      const result = await service.isAvailable(org.id);

      expect(result).toBe(true);
    });

    test("returns false when secret not found", async ({
      makeOrganization,
      makeSecret,
      makeChatApiKey,
    }) => {
      const org = await makeOrganization();

      // Create a secret
      const secret = await makeSecret({
        name: "Anthropic API Key",
        secret: { apiKey: "sk-ant-test-key" },
      });

      // Create the chat API key record
      await makeChatApiKey(org.id, secret.id, {
        name: "Anthropic Key",
        provider: "anthropic",
        scope: "org_wide",
      });

      // Mock the secret manager to return null (secret not found)
      vi.mocked(secretManager).mockReturnValue({
        getSecret: vi.fn().mockResolvedValue(null),
      } as unknown as ReturnType<typeof secretManager>);

      const result = await service.isAvailable(org.id);

      expect(result).toBe(false);
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
      expect(result.error).toContain(
        "Organization-wide Anthropic API key not configured",
      );
    });

    test("returns error when tool not found", async ({
      makeOrganization,
      makeSecret,
      makeChatApiKey,
    }) => {
      const org = await makeOrganization();

      // Set up API key
      const secret = await makeSecret({
        name: "Anthropic API Key",
        secret: { apiKey: "sk-ant-test-key" },
      });

      await makeChatApiKey(org.id, secret.id, {
        name: "Anthropic Key",
        provider: "anthropic",
        scope: "org_wide",
      });

      vi.mocked(secretManager).mockReturnValue({
        getSecret: vi.fn().mockResolvedValue({
          secret: { apiKey: "sk-ant-test-key" },
        }),
      } as unknown as ReturnType<typeof secretManager>);

      const result = await service.configurePoliciesForTool(
        "nonexistent-tool",
        org.id,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Tool not found");
    });

    test("successfully configures policies for a tool", async ({
      makeOrganization,
      makeSecret,
      makeChatApiKey,
      makeMcpServer,
      makeTool,
    }) => {
      const org = await makeOrganization();

      // Set up API key
      const secret = await makeSecret({
        name: "Anthropic API Key",
        secret: { apiKey: "sk-ant-test-key" },
      });

      await makeChatApiKey(org.id, secret.id, {
        name: "Anthropic Key",
        provider: "anthropic",
        scope: "org_wide",
      });

      vi.mocked(secretManager).mockReturnValue({
        getSecret: vi.fn().mockResolvedValue({
          secret: { apiKey: "sk-ant-test-key" },
        }),
      } as unknown as ReturnType<typeof secretManager>);

      // Create MCP server and tool
      const mcpServer = await makeMcpServer({ name: "test-server" });
      const tool = await makeTool({ mcpServerId: mcpServer.id });

      // Mock the subagent analysis
      vi.mocked(policyConfigSubagent.analyze).mockResolvedValue({
        allowUsageWhenUntrustedDataIsPresent: true,
        toolResultTreatment: "trusted",
        reasoning: "This tool is safe",
      });

      const result = await service.configurePoliciesForTool(tool.id, org.id);

      expect(result.success).toBe(true);
      expect(result.config).toEqual({
        allowUsageWhenUntrustedDataIsPresent: true,
        toolResultTreatment: "trusted",
        reasoning: "This tool is safe",
      });

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
      makeSecret,
      makeChatApiKey,
      makeMcpServer,
      makeTool,
    }) => {
      const org = await makeOrganization();

      // Set up API key
      const secret = await makeSecret({
        name: "Anthropic API Key",
        secret: { apiKey: "sk-ant-test-key" },
      });

      await makeChatApiKey(org.id, secret.id, {
        name: "Anthropic Key",
        provider: "anthropic",
        scope: "org_wide",
      });

      vi.mocked(secretManager).mockReturnValue({
        getSecret: vi.fn().mockResolvedValue({
          secret: { apiKey: "sk-ant-test-key" },
        }),
      } as unknown as ReturnType<typeof secretManager>);

      const mcpServer = await makeMcpServer({ name: "test-server" });
      const tool = await makeTool({ mcpServerId: mcpServer.id });

      // Mock blocking policy response
      vi.mocked(policyConfigSubagent.analyze).mockResolvedValue({
        allowUsageWhenUntrustedDataIsPresent: false,
        toolResultTreatment: "untrusted",
        reasoning: "This tool is risky",
      });

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
      makeSecret,
      makeChatApiKey,
      makeMcpServer,
      makeTool,
    }) => {
      const org = await makeOrganization();

      // Set up API key
      const secret = await makeSecret({
        name: "Anthropic API Key",
        secret: { apiKey: "sk-ant-test-key" },
      });

      await makeChatApiKey(org.id, secret.id, {
        name: "Anthropic Key",
        provider: "anthropic",
        scope: "org_wide",
      });

      vi.mocked(secretManager).mockReturnValue({
        getSecret: vi.fn().mockResolvedValue({
          secret: { apiKey: "sk-ant-test-key" },
        }),
      } as unknown as ReturnType<typeof secretManager>);

      const mcpServer = await makeMcpServer({ name: "test-server" });
      const tool = await makeTool({ mcpServerId: mcpServer.id });

      vi.mocked(policyConfigSubagent.analyze).mockResolvedValue({
        allowUsageWhenUntrustedDataIsPresent: true,
        toolResultTreatment: "sanitize_with_dual_llm",
        reasoning: "This tool needs sanitization",
      });

      await service.configurePoliciesForTool(tool.id, org.id);

      const trustedDataPolicies = await db
        .select()
        .from(schema.trustedDataPoliciesTable)
        .where(eq(schema.trustedDataPoliciesTable.toolId, tool.id));
      expect(trustedDataPolicies[0].action).toBe("sanitize_with_dual_llm");
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
