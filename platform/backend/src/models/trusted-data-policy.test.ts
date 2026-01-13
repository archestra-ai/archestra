import { AgentToolModel, ToolModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import TrustedDataPolicyModel from "./trusted-data-policy";

describe("TrustedDataPolicyModel", () => {
  describe("evaluateBulk", () => {
    test("evaluates multiple tools in one query to avoid N+1", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
      makeTrustedDataPolicy,
    }) => {
      const agent = await makeAgent();

      // Create multiple tools
      const tool1 = await makeTool({ name: "tool-1" });
      const tool2 = await makeTool({ name: "tool-2" });
      const tool3 = await makeTool({ name: "tool-3" });

      // Assign tools to agent
      await makeAgentTool(agent.id, tool1.id);
      await makeAgentTool(agent.id, tool2.id);
      await makeAgentTool(agent.id, tool3.id);

      // Delete auto-created default policies to set up our own
      await TrustedDataPolicyModel.deleteByToolId(tool1.id);
      await TrustedDataPolicyModel.deleteByToolId(tool2.id);
      await TrustedDataPolicyModel.deleteByToolId(tool3.id);

      // Create default policies for different treatments
      await makeTrustedDataPolicy(tool1.id, {
        conditions: [],
        action: "mark_as_trusted",
      });
      // tool2 has no default policy - untrusted by default
      await makeTrustedDataPolicy(tool3.id, {
        conditions: [],
        action: "sanitize_with_dual_llm",
      });

      // Create a conditional policy for tool-2
      await makeTrustedDataPolicy(tool2.id, {
        conditions: [{ key: "status", operator: "equal", value: "safe" }],
        action: "mark_as_trusted",
      });

      // Evaluate multiple tools in bulk
      const results = await TrustedDataPolicyModel.evaluateBulk(
        agent.id,
        [
          { toolName: "tool-1", toolOutput: { value: "data1" } },
          { toolName: "tool-2", toolOutput: { status: "safe" } },
          { toolName: "tool-3", toolOutput: { value: "data3" } },
          { toolName: "unknown-tool", toolOutput: { value: "data4" } },
        ],
        "restrictive",
        { teamIds: [] },
      );

      expect(results.size).toBe(4);

      // Tool 1 - trusted by default (index 0)
      const tool1Result = results.get("0");
      expect(tool1Result?.isTrusted).toBe(true);
      expect(tool1Result?.isBlocked).toBe(false);
      expect(tool1Result?.shouldSanitizeWithDualLlm).toBe(false);
      expect(tool1Result?.reason).toContain("trusted by default policy");

      // Tool 2 - trusted by policy (index 1)
      const tool2Result = results.get("1");
      expect(tool2Result?.isTrusted).toBe(true);
      expect(tool2Result?.isBlocked).toBe(false);
      expect(tool2Result?.shouldSanitizeWithDualLlm).toBe(false);
      expect(tool2Result?.reason).toContain("trusted by policy");

      // Tool 3 - sanitize with dual LLM (index 2)
      const tool3Result = results.get("2");
      expect(tool3Result?.isTrusted).toBe(false);
      expect(tool3Result?.isBlocked).toBe(false);
      expect(tool3Result?.shouldSanitizeWithDualLlm).toBe(true);
      expect(tool3Result?.reason).toContain("dual LLM sanitization");

      // Unknown tool (index 3)
      const unknownResult = results.get("3");
      expect(unknownResult?.isTrusted).toBe(false);
      expect(unknownResult?.isBlocked).toBe(false);
      expect(unknownResult?.shouldSanitizeWithDualLlm).toBe(false);
      expect(unknownResult?.reason).toContain("not registered");
    });

    test("handles blocking policies in bulk evaluation", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
      makeTrustedDataPolicy,
    }) => {
      const agent = await makeAgent();

      const tool1 = await makeTool({ name: "email-tool" });
      const tool2 = await makeTool({ name: "file-tool" });

      await makeAgentTool(agent.id, tool1.id);
      await makeAgentTool(agent.id, tool2.id);

      // Create blocking policies
      await makeTrustedDataPolicy(tool1.id, {
        conditions: [{ key: "from", operator: "endsWith", value: "@spam.com" }],
        action: "block_always",
        description: "Block spam emails",
      });

      await makeTrustedDataPolicy(tool2.id, {
        conditions: [
          { key: "path", operator: "contains", value: "/etc/passwd" },
        ],
        action: "block_always",
        description: "Block sensitive files",
      });

      // Test with spam email (should be blocked)
      const spamResults = await TrustedDataPolicyModel.evaluateBulk(
        agent.id,
        [
          { toolName: "email-tool", toolOutput: { from: "user@spam.com" } },
          { toolName: "file-tool", toolOutput: { path: "/etc/passwd" } },
        ],
        "restrictive",
        { teamIds: [] },
      );

      // Email with spam.com - blocked (index 0)
      const spamEmailResult = spamResults.get("0");
      expect(spamEmailResult?.isBlocked).toBe(true);
      expect(spamEmailResult?.reason).toContain("Block spam emails");

      // File with /etc/passwd - blocked (index 1)
      const fileResult = spamResults.get("1");
      expect(fileResult?.isBlocked).toBe(true);
      expect(fileResult?.reason).toContain("Block sensitive files");

      // Test with safe email (should not be blocked)
      const safeResults = await TrustedDataPolicyModel.evaluateBulk(
        agent.id,
        [{ toolName: "email-tool", toolOutput: { from: "user@safe.com" } }],
        "restrictive",
        { teamIds: [] },
      );

      const safeEmailResult = safeResults.get("0");
      expect(safeEmailResult?.isBlocked).toBe(false);
      expect(safeEmailResult?.isTrusted).toBe(false); // Still untrusted but not blocked
    });

    test("handles Archestra tools in bulk", async ({ makeAgent }) => {
      const agent = await makeAgent();

      const results = await TrustedDataPolicyModel.evaluateBulk(
        agent.id,
        [
          { toolName: "archestra__whoami", toolOutput: { user: "test" } },
          { toolName: "regular-tool", toolOutput: { data: "test" } },
          { toolName: "archestra__create_profile", toolOutput: { id: "123" } },
        ],
        "restrictive",
        { teamIds: [] },
      );

      // Archestra tools should be trusted (indices 0 and 2)
      const whoamiResult = results.get("0");
      expect(whoamiResult?.isTrusted).toBe(true);
      expect(whoamiResult?.reason).toBe("Archestra MCP server tool");

      const createProfileResult = results.get("2");
      expect(createProfileResult?.isTrusted).toBe(true);
      expect(createProfileResult?.reason).toBe("Archestra MCP server tool");

      // Regular tool should be untrusted (not registered) - index 1
      const regularResult = results.get("1");
      expect(regularResult?.isTrusted).toBe(false);
      expect(regularResult?.reason).toContain("not registered");
    });

    test("single evaluate method uses bulk internally", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
      makeTrustedDataPolicy,
    }) => {
      const agent = await makeAgent();
      const tool = await makeTool({ name: "test-tool" });
      await makeAgentTool(agent.id, tool.id);
      // Delete auto-created default policies to set up our own
      await TrustedDataPolicyModel.deleteByToolId(tool.id);
      await makeTrustedDataPolicy(tool.id, {
        conditions: [],
        action: "mark_as_trusted",
      });

      // Single evaluation should still work
      const result = await TrustedDataPolicyModel.evaluate(
        agent.id,
        "test-tool",
        { data: "test" },
        "restrictive",
        { teamIds: [] },
      );

      expect(result.isTrusted).toBe(true);
      expect(result.reason).toContain("trusted by default policy");
    });
  });

  const toolName = "test-tool";

  let agentId: string;
  let toolId: string;

  beforeEach(async ({ makeAgent, makeTool }) => {
    // Create test agent
    const agent = await makeAgent({ name: "Test Agent" });
    agentId = agent.id;

    // Create test tool
    const tool = await makeTool({ agentId: agent.id, name: toolName });
    toolId = tool.id;

    // Create agent-tool relationship (untrusted by default when no policies)
    await AgentToolModel.create(agentId, toolId, {});
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
          "restrictive",
          { teamIds: [] },
        );

        expect(result.isTrusted).toBe(false);
        expect(result.reason).toContain("untrusted by default");
      });

      test("marks data as trusted when policy matches", async ({
        makeTrustedDataPolicy,
      }) => {
        // Create a trust policy
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            { key: "source", operator: "equal", value: "trusted-api" },
          ],
          action: "mark_as_trusted",
          description: "Trusted API source",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: { source: "trusted-api", data: "some data" },
          },
          "restrictive",
          { teamIds: [] },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.reason).toContain("Trusted API source");
      });

      test("marks data as untrusted when policy doesn't match", async ({
        makeTrustedDataPolicy,
      }) => {
        // Create a trust policy
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            { key: "source", operator: "equal", value: "trusted-api" },
          ],
          action: "mark_as_trusted",
          description: "Trusted API source",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: { source: "untrusted-api", data: "some data" },
          },
          "restrictive",
          { teamIds: [] },
        );

        expect(result.isTrusted).toBe(false);
        expect(result.reason).toContain("untrusted");
      });
    });

    describe("default policy handling", () => {
      test("marks data as trusted when tool has trusted default policy and no conditions match", async ({
        makeTool,
        makeTrustedDataPolicy,
      }) => {
        // Create a tool with trusted default policy
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
        await AgentToolModel.create(agentId, trustedTool.id, {});
        // Delete auto-created default policies to set up our own
        await TrustedDataPolicyModel.deleteByToolId(trustedTool.id);
        await makeTrustedDataPolicy(trustedTool.id, {
          conditions: [],
          action: "mark_as_trusted",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          "trusted-by-default-tool",
          { value: "any data" },
          "restrictive",
          { teamIds: [] },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.reason).toContain("trusted by default policy");
      });

      test("marks data as trusted when no conditional policies match but tool has trusted default", async ({
        makeTrustedDataPolicy,
      }) => {
        // Create a tool with trusted default policy
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
        await AgentToolModel.create(agentId, trustedTool.id, {});
        // Delete auto-created default policies to set up our own
        await TrustedDataPolicyModel.deleteByToolId(trustedTool.id);

        // Create a default trusted policy
        await makeTrustedDataPolicy(trustedTool.id, {
          conditions: [],
          action: "mark_as_trusted",
        });

        // Create a conditional policy that doesn't match
        await makeTrustedDataPolicy(trustedTool.id, {
          conditions: [{ key: "special", operator: "equal", value: "magic" }],
          action: "mark_as_trusted",
          description: "Special case",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          "trusted-by-default-with-policies",
          { value: { normal: "data" } },
          "restrictive",
          { teamIds: [] },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.reason).toContain("trusted by default policy");
      });

      test("respects conditional policy match over default policy", async ({
        makeTool,
        makeTrustedDataPolicy,
      }) => {
        // Create a tool with trusted default policy
        await makeTool({
          agentId,
          name: "trusted-default-with-matching-policy",
          parameters: { description: "Tool that trusts data by default" },
        });

        const trustedTool = await ToolModel.findByName(
          "trusted-default-with-matching-policy",
        );
        if (!trustedTool) throw new Error("Tool not found");
        await AgentToolModel.create(agentId, trustedTool.id, {});

        // Create a default trusted policy
        await makeTrustedDataPolicy(trustedTool.id, {
          conditions: [],
          action: "mark_as_trusted",
        });

        // Create a conditional policy that matches
        await makeTrustedDataPolicy(trustedTool.id, {
          conditions: [{ key: "verified", operator: "equal", value: "true" }],
          action: "mark_as_trusted",
          description: "Verified data",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          "trusted-default-with-matching-policy",
          { value: { verified: "true" } },
          "restrictive",
          { teamIds: [] },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.reason).toContain("Verified data"); // Should use policy reason, not default
      });
    });

    describe("operator evaluation", () => {
      test("equal operator works correctly", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [{ key: "status", operator: "equal", value: "verified" }],
          action: "mark_as_trusted",
          description: "Verified status",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { status: "verified" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { status: "unverified" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("notEqual operator works correctly", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            { key: "source", operator: "notEqual", value: "untrusted" },
          ],
          action: "mark_as_trusted",
          description: "Not from untrusted source",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "trusted" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "untrusted" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("contains operator works correctly", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            { key: "url", operator: "contains", value: "trusted-domain.com" },
          ],
          action: "mark_as_trusted",
          description: "From trusted domain",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { url: "https://api.trusted-domain.com/data" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { url: "https://untrusted.com/data" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("notContains operator works correctly", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            { key: "content", operator: "notContains", value: "malicious" },
          ],
          action: "mark_as_trusted",
          description: "No malicious content",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { content: "This is safe content" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { content: "This contains malicious code" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("startsWith operator works correctly", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            { key: "path", operator: "startsWith", value: "/trusted/" },
          ],
          action: "mark_as_trusted",
          description: "Trusted path",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { path: "/trusted/data/file.json" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { path: "/untrusted/data/file.json" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("endsWith operator works correctly", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            { key: "email", operator: "endsWith", value: "@company.com" },
          ],
          action: "mark_as_trusted",
          description: "Company email",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { email: "user@company.com" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { email: "user@external.com" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("regex operator works correctly", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            { key: "id", operator: "regex", value: "^[A-Z]{3}-[0-9]{5}$" },
          ],
          action: "mark_as_trusted",
          description: "Valid ID format",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { id: "ABC-12345" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { id: "invalid-id" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });
    });

    describe("wildcard path evaluation", () => {
      test("evaluates wildcard paths correctly", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            {
              key: "emails[*].from",
              operator: "endsWith",
              value: "@trusted.com",
            },
          ],
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
          "restrictive",
          { teamIds: [] },
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
          "restrictive",
          { teamIds: [] },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("handles empty arrays in wildcard paths", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            { key: "items[*].verified", operator: "equal", value: "true" },
          ],
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
          "restrictive",
          { teamIds: [] },
        );
        expect(result.isTrusted).toBe(false);
      });

      test("handles non-array values in wildcard paths", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            { key: "items[*].verified", operator: "equal", value: "true" },
          ],
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
          "restrictive",
          { teamIds: [] },
        );
        expect(result.isTrusted).toBe(false);
      });
    });

    describe("nested path evaluation", () => {
      test("evaluates deeply nested paths", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            {
              key: "response.data.user.verified",
              operator: "equal",
              value: "true",
            },
          ],
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
          "restrictive",
          { teamIds: [] },
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
          "restrictive",
          { teamIds: [] },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("handles missing nested paths", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            {
              key: "response.data.user.verified",
              operator: "equal",
              value: "true",
            },
          ],
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
          "restrictive",
          { teamIds: [] },
        );
        expect(result.isTrusted).toBe(false);
      });
    });

    describe("blocked action", () => {
      test("blocks data when a block_always policy matches", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            { key: "source", operator: "equal", value: "malicious" },
          ],
          action: "block_always",
          description: "Block malicious sources",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: { source: "malicious", data: "some data" },
          },
          "restrictive",
          { teamIds: [] },
        );

        expect(result.isTrusted).toBe(false);
        expect(result.isBlocked).toBe(true);
        expect(result.reason).toContain("Data blocked by policy");
      });

      test("blocked policies take precedence over allow policies", async ({
        makeTrustedDataPolicy,
      }) => {
        // Create an allow policy
        await makeTrustedDataPolicy(toolId, {
          conditions: [{ key: "type", operator: "equal", value: "email" }],
          action: "mark_as_trusted",
          description: "Allow email data",
        });

        // Create a block policy for malicious content
        await makeTrustedDataPolicy(toolId, {
          conditions: [{ key: "from", operator: "contains", value: "hacker" }],
          action: "block_always",
          description: "Block hacker emails",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: { type: "email", from: "hacker@evil.com" },
          },
          "restrictive",
          { teamIds: [] },
        );

        expect(result.isTrusted).toBe(false);
        expect(result.isBlocked).toBe(true);
        expect(result.reason).toContain("Block hacker emails");
      });

      test("blocked policies work with wildcard paths", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            { key: "emails[*].from", operator: "contains", value: "spam" },
          ],
          action: "block_always",
          description: "Block spam emails",
        });

        // Block policy matches when ALL values at wildcard path match the condition
        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: {
              emails: [
                { from: "spam@spammer.com", subject: "Buy now" },
                { from: "spam@evil.com", subject: "Click here" },
              ],
            },
          },
          "restrictive",
          { teamIds: [] },
        );

        expect(result.isTrusted).toBe(false);
        expect(result.isBlocked).toBe(true);
      });

      test("data passes when no blocked policy matches", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            { key: "source", operator: "equal", value: "malicious" },
          ],
          action: "block_always",
          description: "Block malicious sources",
        });

        await makeTrustedDataPolicy(toolId, {
          conditions: [{ key: "source", operator: "equal", value: "trusted" }],
          action: "mark_as_trusted",
          description: "Allow trusted sources",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: { source: "trusted" },
          },
          "restrictive",
          { teamIds: [] },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.isBlocked).toBe(false);
        expect(result.reason).toContain("Allow trusted sources");
      });

      test("blocked policies work with different operators", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            { key: "domain", operator: "endsWith", value: ".blocked.com" },
          ],
          action: "block_always",
          description: "Block blacklisted domains",
        });

        const blockedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { domain: "evil.blocked.com" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(blockedResult.isBlocked).toBe(true);

        const allowedResult = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { domain: "safe.com" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(allowedResult.isBlocked).toBe(false);
      });

      test("blocked policies override trusted default policy", async ({
        makeTool,
        makeTrustedDataPolicy,
      }) => {
        // Create a tool with trusted default policy
        await makeTool({
          agentId,
          name: "default-trusted-tool",
          parameters: { description: "Tool that trusts data by default" },
        });

        const trustedTool = await ToolModel.findByName("default-trusted-tool");
        if (!trustedTool) throw new Error("Tool not found");
        await AgentToolModel.create(agentId, trustedTool.id, {});

        // Create default trusted policy
        await makeTrustedDataPolicy(trustedTool.id, {
          conditions: [],
          action: "mark_as_trusted",
        });

        // Create a block policy
        await makeTrustedDataPolicy(trustedTool.id, {
          conditions: [{ key: "dangerous", operator: "equal", value: "true" }],
          action: "block_always",
          description: "Block dangerous data",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          "default-trusted-tool",
          { value: { dangerous: "true", other: "data" } },
          "restrictive",
          { teamIds: [] },
        );

        expect(result.isTrusted).toBe(false);
        expect(result.isBlocked).toBe(true);
        expect(result.reason).toContain("Block dangerous data");
      });
    });

    describe("multiple conditions (AND logic)", () => {
      test("applies when all output conditions match", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            { key: "source", operator: "equal", value: "internal" },
            { key: "verified", operator: "equal", value: "true" },
          ],
          action: "mark_as_trusted",
          description: "Internal verified data",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: { source: "internal", verified: "true", data: "content" },
          },
          "restrictive",
          { teamIds: [] },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.reason).toContain("Internal verified data");
      });

      test("does not apply when only some output conditions match", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            { key: "source", operator: "equal", value: "internal" },
            { key: "verified", operator: "equal", value: "true" },
          ],
          action: "mark_as_trusted",
          description: "Internal verified data",
        });

        // Only first condition matches
        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: { source: "internal", verified: "false", data: "content" },
          },
          "restrictive",
          { teamIds: [] },
        );

        expect(result.isTrusted).toBe(false);
      });

      test("handles mixed output and context conditions", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [
            { key: "type", operator: "equal", value: "email" },
            { key: "from", operator: "endsWith", value: "@malicious.com" },
          ],
          action: "block_always",
          description: "Block malicious emails",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          {
            value: { type: "email", from: "hacker@malicious.com" },
          },
          "restrictive",
          { teamIds: [] },
        );

        expect(result.isBlocked).toBe(true);
        expect(result.reason).toContain("Block malicious emails");
      });
    });

    describe("multiple policies", () => {
      test("trusts data when any policy matches", async ({
        makeTrustedDataPolicy,
      }) => {
        // Create multiple policies
        await makeTrustedDataPolicy(toolId, {
          conditions: [{ key: "source", operator: "equal", value: "api-v1" }],
          action: "mark_as_trusted",
          description: "API v1 source",
        });

        await makeTrustedDataPolicy(toolId, {
          conditions: [{ key: "source", operator: "equal", value: "api-v2" }],
          action: "mark_as_trusted",
          description: "API v2 source",
        });

        // Test first policy match
        const result1 = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "api-v1" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(result1.isTrusted).toBe(true);
        expect(result1.reason).toContain("API v1 source");

        // Test second policy match
        const result2 = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "api-v2" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(result2.isTrusted).toBe(true);
        expect(result2.reason).toContain("API v2 source");

        // Test no match
        const result3 = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "unknown" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(result3.isTrusted).toBe(false);
      });

      test("evaluates policies for different attributes", async ({
        makeTrustedDataPolicy,
      }) => {
        // Create policies for different attributes
        await makeTrustedDataPolicy(toolId, {
          conditions: [{ key: "source", operator: "equal", value: "trusted" }],
          action: "mark_as_trusted",
          description: "Trusted source",
        });

        await makeTrustedDataPolicy(toolId, {
          conditions: [{ key: "verified", operator: "equal", value: "true" }],
          action: "mark_as_trusted",
          description: "Verified data",
        });

        // Only first attribute matches - should be trusted
        const result1 = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "trusted", verified: "false" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(result1.isTrusted).toBe(true);

        // Only second attribute matches - should be trusted
        const result2 = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "untrusted", verified: "true" } },
          "restrictive",
          { teamIds: [] },
        );
        expect(result2.isTrusted).toBe(true);
      });
    });

    describe("tool output structure handling", () => {
      test("handles direct value in tool output", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [{ key: "status", operator: "equal", value: "success" }],
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
          "restrictive",
          { teamIds: [] },
        );
        expect(result.isTrusted).toBe(true);
      });

      test("handles value wrapper in tool output", async ({
        makeTrustedDataPolicy,
      }) => {
        await makeTrustedDataPolicy(toolId, {
          conditions: [{ key: "status", operator: "equal", value: "success" }],
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
          "restrictive",
          { teamIds: [] },
        );
        expect(result.isTrusted).toBe(true);
      });
    });
  });

  describe("context-based conditions", () => {
    describe("context.externalAgentId", () => {
      test("trusts data when context.externalAgentId matches with equal operator", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeTrustedDataPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({
          agentId: agent.id,
          name: "context-tool",
        });
        await makeAgentTool(agent.id, tool.id);
        await TrustedDataPolicyModel.deleteByToolId(tool.id);

        await makeTrustedDataPolicy(tool.id, {
          conditions: [
            {
              key: "context.externalAgentId",
              operator: "equal",
              value: "trusted-external-agent",
            },
          ],
          action: "mark_as_trusted",
          description: "Trusted external agent",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agent.id,
          "context-tool",
          { value: { data: "any" } },
          "restrictive",
          { teamIds: [], externalAgentId: "trusted-external-agent" },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.reason).toContain("Trusted external agent");
      });

      test("does not trust data when context.externalAgentId does not match with equal operator", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeTrustedDataPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({
          agentId: agent.id,
          name: "context-tool-2",
        });
        await makeAgentTool(agent.id, tool.id);
        await TrustedDataPolicyModel.deleteByToolId(tool.id);

        await makeTrustedDataPolicy(tool.id, {
          conditions: [
            {
              key: "context.externalAgentId",
              operator: "equal",
              value: "trusted-external-agent",
            },
          ],
          action: "mark_as_trusted",
          description: "Trusted external agent",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agent.id,
          "context-tool-2",
          { value: { data: "any" } },
          "restrictive",
          { teamIds: [], externalAgentId: "other-agent" },
        );

        expect(result.isTrusted).toBe(false);
      });

      test("trusts data when context.externalAgentId matches with notEqual operator", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeTrustedDataPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({
          agentId: agent.id,
          name: "context-tool-3",
        });
        await makeAgentTool(agent.id, tool.id);
        await TrustedDataPolicyModel.deleteByToolId(tool.id);

        await makeTrustedDataPolicy(tool.id, {
          conditions: [
            {
              key: "context.externalAgentId",
              operator: "notEqual",
              value: "blocked-agent",
            },
          ],
          action: "mark_as_trusted",
          description: "Not blocked agent",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agent.id,
          "context-tool-3",
          { value: { data: "any" } },
          "restrictive",
          { teamIds: [], externalAgentId: "allowed-agent" },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.reason).toContain("Not blocked agent");
      });

      test("blocks data when context.externalAgentId matches block_always policy", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeTrustedDataPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({
          agentId: agent.id,
          name: "context-tool-4",
        });
        await makeAgentTool(agent.id, tool.id);
        await TrustedDataPolicyModel.deleteByToolId(tool.id);

        await makeTrustedDataPolicy(tool.id, {
          conditions: [
            {
              key: "context.externalAgentId",
              operator: "equal",
              value: "blocked-agent",
            },
          ],
          action: "block_always",
          description: "Blocked external agent",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agent.id,
          "context-tool-4",
          { value: { data: "any" } },
          "restrictive",
          { teamIds: [], externalAgentId: "blocked-agent" },
        );

        expect(result.isBlocked).toBe(true);
        expect(result.reason).toContain("Blocked external agent");
      });
    });

    describe("context.teamIds", () => {
      test("trusts data when context.teamIds contains the specified team with contains operator", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeTrustedDataPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({ agentId: agent.id, name: "team-tool" });
        await makeAgentTool(agent.id, tool.id);
        await TrustedDataPolicyModel.deleteByToolId(tool.id);

        await makeTrustedDataPolicy(tool.id, {
          conditions: [
            {
              key: "context.teamIds",
              operator: "contains",
              value: "trusted-team-id",
            },
          ],
          action: "mark_as_trusted",
          description: "Trusted team",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agent.id,
          "team-tool",
          { value: { data: "any" } },
          "restrictive",
          {
            teamIds: ["other-team", "trusted-team-id"],
            externalAgentId: undefined,
          },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.reason).toContain("Trusted team");
      });

      test("does not trust data when context.teamIds does not contain the specified team", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeTrustedDataPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({ agentId: agent.id, name: "team-tool-2" });
        await makeAgentTool(agent.id, tool.id);
        await TrustedDataPolicyModel.deleteByToolId(tool.id);

        await makeTrustedDataPolicy(tool.id, {
          conditions: [
            {
              key: "context.teamIds",
              operator: "contains",
              value: "trusted-team-id",
            },
          ],
          action: "mark_as_trusted",
          description: "Trusted team",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agent.id,
          "team-tool-2",
          { value: { data: "any" } },
          "restrictive",
          {
            teamIds: ["other-team", "another-team"],
            externalAgentId: undefined,
          },
        );

        expect(result.isTrusted).toBe(false);
      });

      test("trusts data when context.teamIds does not contain blocked team with notContains operator", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeTrustedDataPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({ agentId: agent.id, name: "team-tool-3" });
        await makeAgentTool(agent.id, tool.id);
        await TrustedDataPolicyModel.deleteByToolId(tool.id);

        await makeTrustedDataPolicy(tool.id, {
          conditions: [
            {
              key: "context.teamIds",
              operator: "notContains",
              value: "blocked-team-id",
            },
          ],
          action: "mark_as_trusted",
          description: "Not from blocked team",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agent.id,
          "team-tool-3",
          { value: { data: "any" } },
          "restrictive",
          {
            teamIds: ["allowed-team", "another-team"],
            externalAgentId: undefined,
          },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.reason).toContain("Not from blocked team");
      });

      test("does not trust data when context.teamIds contains blocked team with notContains operator", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeTrustedDataPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({ agentId: agent.id, name: "team-tool-4" });
        await makeAgentTool(agent.id, tool.id);
        await TrustedDataPolicyModel.deleteByToolId(tool.id);

        await makeTrustedDataPolicy(tool.id, {
          conditions: [
            {
              key: "context.teamIds",
              operator: "notContains",
              value: "blocked-team-id",
            },
          ],
          action: "mark_as_trusted",
          description: "Not from blocked team",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agent.id,
          "team-tool-4",
          { value: { data: "any" } },
          "restrictive",
          {
            teamIds: ["allowed-team", "blocked-team-id"],
            externalAgentId: undefined,
          },
        );

        expect(result.isTrusted).toBe(false);
      });

      test("blocks data when context.teamIds matches block_always policy", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeTrustedDataPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({ agentId: agent.id, name: "team-tool-5" });
        await makeAgentTool(agent.id, tool.id);
        await TrustedDataPolicyModel.deleteByToolId(tool.id);

        await makeTrustedDataPolicy(tool.id, {
          conditions: [
            {
              key: "context.teamIds",
              operator: "contains",
              value: "blocked-team-id",
            },
          ],
          action: "block_always",
          description: "Blocked team",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          agent.id,
          "team-tool-5",
          { value: { data: "any" } },
          "restrictive",
          {
            teamIds: ["other-team", "blocked-team-id"],
            externalAgentId: undefined,
          },
        );

        expect(result.isBlocked).toBe(true);
        expect(result.reason).toContain("Blocked team");
      });
    });

    describe("context condition without context provided", () => {
      test("does not match context condition when no context is provided", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeTrustedDataPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({
          agentId: agent.id,
          name: "no-context-tool",
        });
        await makeAgentTool(agent.id, tool.id);
        await TrustedDataPolicyModel.deleteByToolId(tool.id);

        await makeTrustedDataPolicy(tool.id, {
          conditions: [
            {
              key: "context.externalAgentId",
              operator: "equal",
              value: "some-agent",
            },
          ],
          action: "mark_as_trusted",
          description: "Requires context",
        });

        // No context provided
        const result = await TrustedDataPolicyModel.evaluate(
          agent.id,
          "no-context-tool",
          { value: { data: "any" } },
          "restrictive",
          { teamIds: [] },
        );

        expect(result.isTrusted).toBe(false);
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
        "restrictive",
        { teamIds: [] },
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
          "restrictive",
          { teamIds: [] },
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
      await makeTrustedDataPolicy(toolId, {
        conditions: [{ key: "source", operator: "equal", value: "malicious" }],
        action: "block_always",
        description: "Block malicious sources",
      });

      const result = await TrustedDataPolicyModel.evaluate(
        agentId,
        "archestra__create_agent",
        {
          value: { source: "malicious", data: "would normally be blocked" },
        },
        "restrictive",
        { teamIds: [] },
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
      await makeTrustedDataPolicy(toolId, {
        conditions: [{ key: "source", operator: "equal", value: "trusted" }],
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
        "restrictive",
        { teamIds: [] },
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
        "restrictive",
        { teamIds: [] },
      );

      expect(untrustedResult.isTrusted).toBe(false);
      expect(untrustedResult.reason).toContain("untrusted");
    });
  });
});
