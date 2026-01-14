import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolAutoPolicyService } from "./agent-tool-auto-policy";

// Mock dependencies
vi.mock("@/logging", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/secrets-manager", () => ({
  secretManager: vi.fn(() => ({
    getSecret: vi.fn(),
  })),
}));

vi.mock("@/subagents", () => ({
  policyConfigSubagent: {
    analyze: vi.fn(),
  },
}));

vi.mock("./chat-api-key", () => ({
  default: {
    findByScope: vi.fn(),
  },
}));

vi.mock("./tool", () => ({
  default: {
    findAll: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("./tool-invocation-policy", () => ({
  default: {
    bulkUpsertDefaultPolicy: vi.fn(),
  },
}));

vi.mock("./trusted-data-policy", () => ({
  default: {
    bulkUpsertDefaultPolicy: vi.fn(),
  },
}));

vi.mock("@/database", () => ({
  default: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  },
}));

vi.mock("@/database/schemas", () => ({
  toolsTable: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a, b) => ({ field: a, value: b })),
}));

const mockChatApiKey = {
  id: "key-1",
  name: "Test Key",
  secretId: "secret-1",
  organizationId: "org-1",
  provider: "anthropic" as const,
  scope: "org_wide" as const,
  teamId: null,
  userId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockTool = {
  id: "tool-1",
  name: "test-tool",
  description: "A test tool",
  parameters: { type: "object", properties: {} },
  catalogId: null,
  promptAgentId: null,
  policiesAutoConfiguredAt: null,
  policiesAutoConfiguringStartedAt: null,
  policiesAutoConfiguredReasoning: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  agent: null,
  mcpServer: { id: "server-1", name: "test-server" },
};

describe("ToolAutoPolicyService", () => {
  let service: ToolAutoPolicyService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ToolAutoPolicyService();
  });

  describe("isAvailable", () => {
    it("returns true when org-wide Anthropic API key exists", async () => {
      const { default: ChatApiKeyModel } = await import("./chat-api-key");
      const { secretManager } = await import("@/secrets-manager");

      vi.mocked(ChatApiKeyModel.findByScope).mockResolvedValue(mockChatApiKey);

      vi.mocked(secretManager).mockReturnValue({
        getSecret: vi.fn().mockResolvedValue({
          secret: { apiKey: "sk-ant-xxx" },
        }),
      } as unknown as ReturnType<typeof secretManager>);

      const result = await service.isAvailable("org-1");

      expect(result).toBe(true);
      expect(ChatApiKeyModel.findByScope).toHaveBeenCalledWith(
        "org-1",
        "anthropic",
        "org_wide",
      );
    });

    it("returns false when no chat API key configured", async () => {
      const { default: ChatApiKeyModel } = await import("./chat-api-key");

      vi.mocked(ChatApiKeyModel.findByScope).mockResolvedValue(null);

      const result = await service.isAvailable("org-1");

      expect(result).toBe(false);
    });

    it("returns false when secret not found", async () => {
      const { default: ChatApiKeyModel } = await import("./chat-api-key");
      const { secretManager } = await import("@/secrets-manager");

      vi.mocked(ChatApiKeyModel.findByScope).mockResolvedValue(mockChatApiKey);

      vi.mocked(secretManager).mockReturnValue({
        getSecret: vi.fn().mockResolvedValue(null),
      } as unknown as ReturnType<typeof secretManager>);

      const result = await service.isAvailable("org-1");

      expect(result).toBe(false);
    });
  });

  describe("configurePoliciesForTool", () => {
    it("returns error when no API key available", async () => {
      const { default: ChatApiKeyModel } = await import("./chat-api-key");

      vi.mocked(ChatApiKeyModel.findByScope).mockResolvedValue(null);

      const result = await service.configurePoliciesForTool("tool-1", "org-1");

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        "Organization-wide Anthropic API key not configured",
      );
    });

    it("returns error when tool not found", async () => {
      const { default: ChatApiKeyModel } = await import("./chat-api-key");
      const { default: ToolModel } = await import("./tool");
      const { secretManager } = await import("@/secrets-manager");

      vi.mocked(ChatApiKeyModel.findByScope).mockResolvedValue(mockChatApiKey);

      vi.mocked(secretManager).mockReturnValue({
        getSecret: vi.fn().mockResolvedValue({
          secret: { apiKey: "sk-ant-xxx" },
        }),
      } as unknown as ReturnType<typeof secretManager>);

      vi.mocked(ToolModel.findAll).mockResolvedValue([]);

      const result = await service.configurePoliciesForTool(
        "nonexistent-tool",
        "org-1",
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Tool not found");
    });

    it("successfully configures policies for a tool", async () => {
      const { default: ChatApiKeyModel } = await import("./chat-api-key");
      const { default: ToolModel } = await import("./tool");
      const { default: ToolInvocationPolicyModel } = await import(
        "./tool-invocation-policy"
      );
      const { default: TrustedDataPolicyModel } = await import(
        "./trusted-data-policy"
      );
      const { secretManager } = await import("@/secrets-manager");
      const { policyConfigSubagent } = await import("@/subagents");

      vi.mocked(ChatApiKeyModel.findByScope).mockResolvedValue(mockChatApiKey);

      vi.mocked(secretManager).mockReturnValue({
        getSecret: vi.fn().mockResolvedValue({
          secret: { apiKey: "sk-ant-xxx" },
        }),
      } as unknown as ReturnType<typeof secretManager>);

      vi.mocked(ToolModel.findAll).mockResolvedValue([mockTool] as Awaited<
        ReturnType<typeof ToolModel.findAll>
      >);

      vi.mocked(ToolModel.update).mockResolvedValue(null);

      vi.mocked(policyConfigSubagent.analyze).mockResolvedValue({
        allowUsageWhenUntrustedDataIsPresent: true,
        toolResultTreatment: "trusted",
        reasoning: "This tool is safe",
      });

      vi.mocked(
        ToolInvocationPolicyModel.bulkUpsertDefaultPolicy,
      ).mockResolvedValue({ updated: 0, created: 1 });
      vi.mocked(
        TrustedDataPolicyModel.bulkUpsertDefaultPolicy,
      ).mockResolvedValue({ updated: 0, created: 1 });

      const result = await service.configurePoliciesForTool("tool-1", "org-1");

      expect(result.success).toBe(true);
      expect(result.config).toEqual({
        allowUsageWhenUntrustedDataIsPresent: true,
        toolResultTreatment: "trusted",
        reasoning: "This tool is safe",
      });

      expect(
        ToolInvocationPolicyModel.bulkUpsertDefaultPolicy,
      ).toHaveBeenCalledWith(["tool-1"], "allow_when_context_is_untrusted");
      expect(
        TrustedDataPolicyModel.bulkUpsertDefaultPolicy,
      ).toHaveBeenCalledWith(["tool-1"], "mark_as_trusted");
    });

    it("maps policy config to correct actions", async () => {
      const { default: ChatApiKeyModel } = await import("./chat-api-key");
      const { default: ToolModel } = await import("./tool");
      const { default: ToolInvocationPolicyModel } = await import(
        "./tool-invocation-policy"
      );
      const { default: TrustedDataPolicyModel } = await import(
        "./trusted-data-policy"
      );
      const { secretManager } = await import("@/secrets-manager");
      const { policyConfigSubagent } = await import("@/subagents");

      vi.mocked(ChatApiKeyModel.findByScope).mockResolvedValue(mockChatApiKey);

      vi.mocked(secretManager).mockReturnValue({
        getSecret: vi.fn().mockResolvedValue({
          secret: { apiKey: "sk-ant-xxx" },
        }),
      } as unknown as ReturnType<typeof secretManager>);

      vi.mocked(ToolModel.findAll).mockResolvedValue([mockTool] as Awaited<
        ReturnType<typeof ToolModel.findAll>
      >);

      vi.mocked(ToolModel.update).mockResolvedValue(null);

      // Test blocking policy
      vi.mocked(policyConfigSubagent.analyze).mockResolvedValue({
        allowUsageWhenUntrustedDataIsPresent: false,
        toolResultTreatment: "untrusted",
        reasoning: "This tool is risky",
      });

      vi.mocked(
        ToolInvocationPolicyModel.bulkUpsertDefaultPolicy,
      ).mockResolvedValue({ updated: 0, created: 1 });
      vi.mocked(
        TrustedDataPolicyModel.bulkUpsertDefaultPolicy,
      ).mockResolvedValue({ updated: 0, created: 1 });

      await service.configurePoliciesForTool("tool-1", "org-1");

      expect(
        ToolInvocationPolicyModel.bulkUpsertDefaultPolicy,
      ).toHaveBeenCalledWith(["tool-1"], "block_always");
      expect(
        TrustedDataPolicyModel.bulkUpsertDefaultPolicy,
      ).toHaveBeenCalledWith(["tool-1"], "block_always");
    });

    it("handles sanitize_with_dual_llm result treatment", async () => {
      const { default: ChatApiKeyModel } = await import("./chat-api-key");
      const { default: ToolModel } = await import("./tool");
      const { default: TrustedDataPolicyModel } = await import(
        "./trusted-data-policy"
      );
      const { default: ToolInvocationPolicyModel } = await import(
        "./tool-invocation-policy"
      );
      const { secretManager } = await import("@/secrets-manager");
      const { policyConfigSubagent } = await import("@/subagents");

      vi.mocked(ChatApiKeyModel.findByScope).mockResolvedValue(mockChatApiKey);

      vi.mocked(secretManager).mockReturnValue({
        getSecret: vi.fn().mockResolvedValue({
          secret: { apiKey: "sk-ant-xxx" },
        }),
      } as unknown as ReturnType<typeof secretManager>);

      vi.mocked(ToolModel.findAll).mockResolvedValue([mockTool] as Awaited<
        ReturnType<typeof ToolModel.findAll>
      >);

      vi.mocked(ToolModel.update).mockResolvedValue(null);

      vi.mocked(policyConfigSubagent.analyze).mockResolvedValue({
        allowUsageWhenUntrustedDataIsPresent: true,
        toolResultTreatment: "sanitize_with_dual_llm",
        reasoning: "This tool needs sanitization",
      });

      vi.mocked(
        ToolInvocationPolicyModel.bulkUpsertDefaultPolicy,
      ).mockResolvedValue({ updated: 0, created: 1 });
      vi.mocked(
        TrustedDataPolicyModel.bulkUpsertDefaultPolicy,
      ).mockResolvedValue({ updated: 0, created: 1 });

      await service.configurePoliciesForTool("tool-1", "org-1");

      expect(
        TrustedDataPolicyModel.bulkUpsertDefaultPolicy,
      ).toHaveBeenCalledWith(["tool-1"], "sanitize_with_dual_llm");
    });
  });

  describe("configurePoliciesForTools", () => {
    it("returns error for all tools when service not available", async () => {
      const { default: ChatApiKeyModel } = await import("./chat-api-key");

      vi.mocked(ChatApiKeyModel.findByScope).mockResolvedValue(null);

      const result = await service.configurePoliciesForTools(
        ["tool-1", "tool-2"],
        "org-1",
      );

      expect(result.success).toBe(false);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].success).toBe(false);
      expect(result.results[1].success).toBe(false);
    });
  });
});
