import { AgentToolModel, ToolModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import TrustedDataPolicyModel from "./trusted-data-policy";

describe("TrustedDataPolicyModel", () => {
  const toolName = "test-tool";

  let agentId: string;
  let toolId: string;
  let agentToolId: string;

  beforeEach(async ({ makeAgent, makeTool }) => {
    // Create test agent
    const agent = await makeAgent({ name: "Test Agent" });
    agentId = agent.id;

    // Create test tool
    const tool = await makeTool({ agentId: agent.id, name: toolName });
    toolId = tool.id;

    // Create agent-tool relationship with default untrusted configuration
    const agentTool = await AgentToolModel.create(agentId, toolId, {
      allowUsageWhenUntrustedDataIsPresent: false,
      toolResultTreatment: "untrusted",
    });
    agentToolId = agentTool.id;
  });

  describe("evaluate", () => {
    describe("basic trust evaluation", () => {
      test("marks data as untrusted when no policies exist", async () => {
        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: "some data",
          },
        );

        expect(result.isTrusted).toBe(false);
        expect(result.reason).toContain(
          "Tool test-tool is configured as untrusted",
        );
      });

      test("marks data as trusted when policy matches", async ({
        makeTrustedDataPolicy,
      }) => {
        // Create a trust policy
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "source",
          operator: "equal",
          value: "trusted-api",
          action: "mark_as_trusted",
          description: "Trusted API source",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: { source: "trusted-api", data: "some data" },
          },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.reason).toContain("Trusted API source");
      });

      test("marks data as untrusted when policy doesn't match", async ({
        makeTrustedDataPolicy,
      }) => {
        // Create a trust policy
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "source",
          operator: "equal",
          value: "trusted-api",
          action: "mark_as_trusted",
          description: "Trusted API source",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: { source: "untrusted-api", data: "some data" },
          },
        );

        expect(result.isTrusted).toBe(false);
        expect(result.reason).toContain("does not match any trust policies");
      });
    });

    describe("toolResultTreatment handling", () => {
      test("marks data as trusted when tool has trusted treatment and no policies exist", async ({
        makeTool,
      }) => {
        // Create a tool with trusted treatment
        await makeTool({
          agentId,
          name: "trusted-by-default-tool",
          parameters: {},
          description: "Tool that trusts data by default",
        });

        const trustedTool = await ToolModel.findByName(
          "trusted-by-default-tool",
        );
        if (!trustedTool) throw new Error("Tool not found");
        await AgentToolModel.create(agentId, trustedTool.id, {
          allowUsageWhenUntrustedDataIsPresent: false,
          toolResultTreatment: "trusted",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          "trusted-by-default-tool",
          { value: "any data" },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.reason).toContain(
          "Tool trusted-by-default-tool is configured as trusted",
        );
      });

      test("marks data as trusted when no policies match but tool has trusted treatment", async ({
        makeTrustedDataPolicy,
      }) => {
        // Create a tool with trusted treatment
        await ToolModel.createToolIfNotExists({
          agentId,
          name: "trusted-by-default-with-policies",
          parameters: {},
          description: "Tool that trusts data by default",
        });

        const trustedTool = await ToolModel.findByName(
          "trusted-by-default-with-policies",
        );
        if (!trustedTool) throw new Error("Tool not found");
        const trustedAgentTool = await AgentToolModel.create(
          agentId,
          trustedTool.id,
          {
            allowUsageWhenUntrustedDataIsPresent: false,
            toolResultTreatment: "trusted",
          },
        );

        // Create a policy that doesn't match
        await makeTrustedDataPolicy(trustedAgentTool.id, {
          attributePath: "special",
          operator: "equal",
          value: "magic",
          action: "mark_as_trusted",
          description: "Special case",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          "trusted-by-default-with-policies",
          { value: { normal: "data" } },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.reason).toContain(
          "Tool trusted-by-default-with-policies is configured as trusted",
        );
      });

      test("respects policy match over trusted treatment", async ({
        makeTool,
        makeTrustedDataPolicy,
      }) => {
        // Create a tool with trusted treatment
        await makeTool({
          agentId,
          name: "trusted-default-with-matching-policy",
          parameters: { description: "Tool that trusts data by default" },
        });

        const trustedTool = await ToolModel.findByName(
          "trusted-default-with-matching-policy",
        );
        if (!trustedTool) throw new Error("Tool not found");
        const trustedAgentTool = await AgentToolModel.create(
          agentId,
          trustedTool.id,
          {
            allowUsageWhenUntrustedDataIsPresent: false,
            toolResultTreatment: "trusted",
          },
        );

        // Create a policy that matches
        await makeTrustedDataPolicy(trustedAgentTool.id, {
          attributePath: "verified",
          operator: "equal",
          value: "true",
          action: "mark_as_trusted",
          description: "Verified data",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          "trusted-default-with-matching-policy",
          { value: { verified: "true" } },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.reason).toContain("Verified data"); // Should use policy reason, not default
      });
    });

    describe("operator evaluation", () => {
      test("equal operator works correctly", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "status",
          operator: "equal",
          value: "verified",
          action: "mark_as_trusted",
          description: "Verified status",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { status: "verified" } },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { status: "unverified" } },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("notEqual operator works correctly", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "source",
          operator: "notEqual",
          value: "untrusted",
          action: "mark_as_trusted",
          description: "Not from untrusted source",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "trusted" } },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "untrusted" } },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("contains operator works correctly", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "url",
          operator: "contains",
          value: "trusted-domain.com",
          action: "mark_as_trusted",
          description: "From trusted domain",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { url: "https://api.trusted-domain.com/data" } },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { url: "https://untrusted.com/data" } },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("notContains operator works correctly", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "content",
          operator: "notContains",
          value: "malicious",
          action: "mark_as_trusted",
          description: "No malicious content",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { content: "This is safe content" } },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { content: "This contains malicious code" } },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("startsWith operator works correctly", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "path",
          operator: "startsWith",
          value: "/trusted/",
          action: "mark_as_trusted",
          description: "Trusted path",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { path: "/trusted/data/file.json" } },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { path: "/untrusted/data/file.json" } },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("endsWith operator works correctly", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "email",
          operator: "endsWith",
          value: "@company.com",
          action: "mark_as_trusted",
          description: "Company email",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { email: "user@company.com" } },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { email: "user@external.com" } },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("regex operator works correctly", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "id",
          operator: "regex",
          value: "^[A-Z]{3}-[0-9]{5}$",
          action: "mark_as_trusted",
          description: "Valid ID format",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { id: "ABC-12345" } },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { id: "invalid-id" } },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });
    });

    describe("wildcard path evaluation", () => {
      test("evaluates wildcard paths correctly", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "emails[*].from",
          operator: "endsWith",
          value: "@trusted.com",
          action: "mark_as_trusted",
          description: "Emails from trusted domain",
        });

        // All emails from trusted domain - should be trusted
        const trustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: {
              emails: [
                { from: "user1@trusted.com", subject: "Test" },
                { from: "user2@trusted.com", subject: "Test2" },
              ],
            },
          },
        );
        expect(trustedResult.isTrusted).toBe(true);

        // Mixed emails - should be untrusted (ALL must match)
        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: {
              emails: [
                { from: "user1@trusted.com", subject: "Test" },
                { from: "hacker@evil.com", subject: "Malicious" },
              ],
            },
          },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("handles empty arrays in wildcard paths", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "items[*].verified",
          operator: "equal",
          value: "true",
          action: "mark_as_trusted",
          description: "All items verified",
        });

        // Empty array - should be untrusted (no values to verify)
        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: { items: [] },
          },
        );
        expect(result.isTrusted).toBe(false);
      });

      test("handles non-array values in wildcard paths", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "items[*].verified",
          operator: "equal",
          value: "true",
          action: "mark_as_trusted",
          description: "All items verified",
        });

        // Non-array value - should be untrusted
        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: { items: "not an array" },
          },
        );
        expect(result.isTrusted).toBe(false);
      });
    });

    describe("nested path evaluation", () => {
      test("evaluates deeply nested paths", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "response.data.user.verified",
          operator: "equal",
          value: "true",
          action: "mark_as_trusted",
          description: "User is verified",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: {
              response: {
                data: {
                  user: {
                    verified: "true",
                    name: "John",
                  },
                },
              },
            },
          },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: {
              response: {
                data: {
                  user: {
                    verified: "false",
                    name: "John",
                  },
                },
              },
            },
          },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("handles missing nested paths", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "response.data.user.verified",
          operator: "equal",
          value: "true",
          action: "mark_as_trusted",
          description: "User is verified",
        });

        // Missing path - should be untrusted
        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: {
              response: {
                data: {
                  // user object missing
                },
              },
            },
          },
        );
        expect(result.isTrusted).toBe(false);
      });
    });

    describe("blocked action", () => {
      test("blocks data when a block_always policy matches", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "source",
          operator: "equal",
          value: "malicious",
          action: "block_always",
          description: "Block malicious sources",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: { source: "malicious", data: "some data" },
          },
        );

        expect(result.isTrusted).toBe(false);
        expect(result.isBlocked).toBe(true);
        expect(result.reason).toContain("Data blocked by policy");
      });

      test("blocked policies take precedence over allow policies", async ({
        makeTrustedDataPolicy,
      }) => {
        // Create an allow policy
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "type",
          operator: "equal",
          value: "email",
          action: "mark_as_trusted",
          description: "Allow email data",
        });

        // Create a block policy for malicious content
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "from",
          operator: "contains",
          value: "hacker",
          action: "block_always",
          description: "Block hacker emails",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: { type: "email", from: "hacker@evil.com" },
          },
        );

        expect(result.isTrusted).toBe(false);
        expect(result.isBlocked).toBe(true);
        expect(result.reason).toContain("Block hacker emails");
      });

      test("blocked policies work with wildcard paths", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "emails[*].from",
          operator: "contains",
          value: "spam",
          action: "block_always",
          description: "Block spam emails",
        });

        // Should block if ANY email matches the condition
        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: {
              emails: [
                { from: "user@company.com", subject: "Work" },
                { from: "spam@spammer.com", subject: "Buy now" },
              ],
            },
          },
        );

        expect(result.isTrusted).toBe(false);
        expect(result.isBlocked).toBe(true);
      });

      test("data passes when no blocked policy matches", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "source",
          operator: "equal",
          value: "malicious",
          action: "block_always",
          description: "Block malicious sources",
        });

        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "source",
          operator: "equal",
          value: "trusted",
          action: "mark_as_trusted",
          description: "Allow trusted sources",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: { source: "trusted" },
          },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.isBlocked).toBe(false);
        expect(result.reason).toContain("Allow trusted sources");
      });

      test("blocked policies work with different operators", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "domain",
          operator: "endsWith",
          value: ".blocked.com",
          action: "block_always",
          description: "Block blacklisted domains",
        });

        const blockedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { domain: "evil.blocked.com" } },
        );
        expect(blockedResult.isBlocked).toBe(true);

        const allowedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { domain: "safe.com" } },
        );
        expect(allowedResult.isBlocked).toBe(false);
      });

      test("blocked policies override trusted treatment", async ({
        makeTool,
        makeTrustedDataPolicy,
      }) => {
        // Create a tool with trusted treatment
        await makeTool({
          agentId,
          name: "default-trusted-tool",
          parameters: { description: "Tool that trusts data by default" },
        });

        const trustedTool = await ToolModel.findByName("default-trusted-tool");
        if (!trustedTool) throw new Error("Tool not found");
        const trustedAgentTool = await AgentToolModel.create(
          agentId,
          trustedTool.id,
          {
            allowUsageWhenUntrustedDataIsPresent: false,
            toolResultTreatment: "trusted",
          },
        );

        // Create a block policy
        await makeTrustedDataPolicy(trustedAgentTool.id, {
          attributePath: "dangerous",
          operator: "equal",
          value: "true",
          action: "block_always",
          description: "Block dangerous data",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          "default-trusted-tool",
          { value: { dangerous: "true", other: "data" } },
        );

        expect(result.isTrusted).toBe(false);
        expect(result.isBlocked).toBe(true);
        expect(result.reason).toContain("Block dangerous data");
      });
    });

    describe("multiple policies", () => {
      test("trusts data when any policy matches", async ({
        makeTrustedDataPolicy,
      }) => {
        // Create multiple policies
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "source",
          operator: "equal",
          value: "api-v1",
          action: "mark_as_trusted",
          description: "API v1 source",
        });

        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "source",
          operator: "equal",
          value: "api-v2",
          action: "mark_as_trusted",
          description: "API v2 source",
        });

        // Test first policy match
        const result1 = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "api-v1" } },
        );
        expect(result1.isTrusted).toBe(true);
        expect(result1.reason).toContain("API v1 source");

        // Test second policy match
        const result2 = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "api-v2" } },
        );
        expect(result2.isTrusted).toBe(true);
        expect(result2.reason).toContain("API v2 source");

        // Test no match
        const result3 = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "unknown" } },
        );
        expect(result3.isTrusted).toBe(false);
      });

      test("evaluates policies for different attributes", async ({
        makeTrustedDataPolicy,
      }) => {
        // Create policies for different attributes
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "source",
          operator: "equal",
          value: "trusted",
          action: "mark_as_trusted",
          description: "Trusted source",
        });

        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "verified",
          operator: "equal",
          value: "true",
          action: "mark_as_trusted",
          description: "Verified data",
        });

        // Only first attribute matches - should be trusted
        const result1 = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "trusted", verified: "false" } },
        );
        expect(result1.isTrusted).toBe(true);

        // Only second attribute matches - should be trusted
        const result2 = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "untrusted", verified: "true" } },
        );
        expect(result2.isTrusted).toBe(true);
      });
    });

    describe("tool output structure handling", () => {
      test("handles direct value in tool output", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "status",
          operator: "equal",
          value: "success",
          action: "mark_as_trusted",
          description: "Successful response",
        });

        // Direct object (no value wrapper)
        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            status: "success",
            data: "some data",
          },
        );
        expect(result.isTrusted).toBe(true);
      });

      test("handles value wrapper in tool output", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(agentToolId, {
          attributePath: "status",
          operator: "equal",
          value: "success",
          action: "mark_as_trusted",
          description: "Successful response",
        });

        // Wrapped in value property
        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: { status: "success", data: "some data" },
          },
        );
        expect(result.isTrusted).toBe(true);
      });
    });
  });

  describe("Archestra MCP server tools", () => {
    test("always trusts Archestra MCP server tools regardless of policies", async () => {
      // Test with a tool that starts with "archestra__"
      const archestraToolName = "archestra__whoami";

      const result = await TrustedDataPolicyModel.evaluate(
        agentId,
        archestraToolName,
        {
          value: { any: "data", dangerous: "content" },
        },
      );

      expect(result.isTrusted).toBe(true);
      expect(result.isBlocked).toBe(false);
      expect(result.shouldSanitizeWithDualLlm).toBe(false);
      expect(result.reason).toBe("Archestra MCP server tool");
    });

    test("trusts Archestra MCP server tools with different tool names", async () => {
      const archestraTools = [
        "archestra__get_agent",
        "archestra__create_limit",
        "archestra__get_mcp_servers",
        "archestra__bulk_assign_tools_to_agents",
      ];

      for (const toolName of archestraTools) {
        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: { untrusted: "data", source: "malicious" },
          },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.isBlocked).toBe(false);
        expect(result.shouldSanitizeWithDualLlm).toBe(false);
        expect(result.reason).toBe("Archestra MCP server tool");
      }
    });

    test("trusts Archestra tools even with blocking policies in place", async ({
      makeTrustedDataPolicy,
    }) => {
      // Create a blocking policy that would normally block this data
      await makeTrustedDataPolicy(agentToolId, {
        attributePath: "source",
        operator: "equal",
        value: "malicious",
        action: "block_always",
        description: "Block malicious sources",
      });

      const result = await TrustedDataPolicyModel.evaluate(
        agentId,
        "archestra__create_agent",
        {
          value: { source: "malicious", data: "would normally be blocked" },
        },
      );

      expect(result.isTrusted).toBe(true);
      expect(result.isBlocked).toBe(false);
      expect(result.shouldSanitizeWithDualLlm).toBe(false);
      expect(result.reason).toBe("Archestra MCP server tool");
    });

    test("does not affect evaluation of non-Archestra tools", async ({
      makeTrustedDataPolicy,
    }) => {
      // Test that regular tools still follow normal evaluation
      await makeTrustedDataPolicy(agentToolId, {
        attributePath: "source",
        operator: "equal",
        value: "trusted",
        action: "mark_as_trusted",
        description: "Trust specific source",
      });

      // Test regular tool with trusted data
      const trustedResult = await TrustedDataPolicyModel.evaluate(
        agentId,
        toolName,
        {
          value: { source: "trusted" },
        },
      );

      expect(trustedResult.isTrusted).toBe(true);
      expect(trustedResult.reason).toContain("Trust specific source");

      // Test regular tool with untrusted data
      const untrustedResult = await TrustedDataPolicyModel.evaluate(
        agentId,
        toolName,
        {
          value: { source: "untrusted" },
        },
      );

      expect(untrustedResult.isTrusted).toBe(false);
      expect(untrustedResult.reason).toContain(
        "does not match any trust policies",
      );
    });
  });
});
