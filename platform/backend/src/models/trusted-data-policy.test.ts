import { beforeEach, describe, expect, test } from "vitest";
import type { Tool } from "../types";
import AgentModel from "./agent";
import ChatModel from "./chat";
import ToolModel from "./tool";
import TrustedDataPolicyModel from "./trusted-data-policy";

describe("TrustedDataPolicyModel", async () => {
  const toolName = "test-tool";

  let agentId: string;
  let chatId: string;
  let toolId: string;

  beforeEach(async () => {
    // Create test agent
    const agent = await AgentModel.create({ name: "Test Agent" });
    agentId = agent.id;

    // Create test chat
    const chat = await ChatModel.create({ agentId });
    chatId = chat.id;

    // Create test tool
    await ToolModel.createToolIfNotExists({
      agentId,
      name: toolName,
      parameters: {},
      description: "Test tool",
      allowUsageWhenUntrustedDataIsPresent: false,
      dataIsTrustedByDefault: false,
    });

    const tool = await ToolModel.findByName(toolName);
    toolId = (tool as Tool).id;
  });

  describe("evaluate", () => {
    describe("basic trust evaluation", () => {
      test("marks data as untrusted when no policies exist", async () => {
        const result = await TrustedDataPolicyModel.evaluate(chatId, toolName, {
          value: "some data",
        });

        expect(result.isTrusted).toBe(false);
        expect(result.reason).toContain("No trust policy defined");
      });

      test("marks data as trusted when policy matches", async () => {
        // Create a trust policy
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "source",
          operator: "equal",
          value: "trusted-api",
          action: "mark_as_trusted",
          description: "Trusted API source",
        });

        const result = await TrustedDataPolicyModel.evaluate(chatId, toolName, {
          value: { source: "trusted-api", data: "some data" },
        });

        expect(result.isTrusted).toBe(true);
        expect(result.reason).toContain("Trusted API source");
      });

      test("marks data as untrusted when policy doesn't match", async () => {
        // Create a trust policy
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "source",
          operator: "equal",
          value: "trusted-api",
          action: "mark_as_trusted",
          description: "Trusted API source",
        });

        const result = await TrustedDataPolicyModel.evaluate(chatId, toolName, {
          value: { source: "untrusted-api", data: "some data" },
        });

        expect(result.isTrusted).toBe(false);
        expect(result.reason).toContain("does not match any trust policies");
      });
    });

    describe("dataIsTrustedByDefault handling", () => {
      test("marks data as trusted when tool has dataIsTrustedByDefault and no policies exist", async () => {
        // Create a tool with dataIsTrustedByDefault
        await ToolModel.createToolIfNotExists({
          agentId,
          name: "trusted-by-default-tool",
          parameters: {},
          description: "Tool that trusts data by default",
          allowUsageWhenUntrustedDataIsPresent: false,
          dataIsTrustedByDefault: true,
        });

        const result = await TrustedDataPolicyModel.evaluate(
          chatId,
          "trusted-by-default-tool",
          { value: "any data" },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.reason).toContain("configured to trust data by default");
      });

      test("marks data as trusted when no policies match but tool has dataIsTrustedByDefault", async () => {
        // Create a tool with dataIsTrustedByDefault
        await ToolModel.createToolIfNotExists({
          agentId,
          name: "trusted-by-default-with-policies",
          parameters: {},
          description: "Tool that trusts data by default",
          allowUsageWhenUntrustedDataIsPresent: false,
          dataIsTrustedByDefault: true,
        });

        const tools = await ToolModel.findAll();
        const trustedToolId = tools.find(
          (t) => t.name === "trusted-by-default-with-policies",
        )?.id;

        // Create a policy that doesn't match
        await TrustedDataPolicyModel.create({
          toolId: trustedToolId as string,
          attributePath: "special",
          operator: "equal",
          value: "magic",
          action: "mark_as_trusted",
          description: "Special case",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          chatId,
          "trusted-by-default-with-policies",
          { value: { normal: "data" } },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.reason).toContain("configured to trust data by default");
      });

      test("respects policy match over dataIsTrustedByDefault", async () => {
        // Create a tool with dataIsTrustedByDefault
        await ToolModel.createToolIfNotExists({
          agentId,
          name: "trusted-default-with-matching-policy",
          parameters: {},
          description: "Tool that trusts data by default",
          allowUsageWhenUntrustedDataIsPresent: false,
          dataIsTrustedByDefault: true,
        });

        const tools = await ToolModel.findAll();
        const trustedToolId = tools.find(
          (t) => t.name === "trusted-default-with-matching-policy",
        )?.id;

        // Create a policy that matches
        await TrustedDataPolicyModel.create({
          toolId: trustedToolId as string,
          attributePath: "verified",
          operator: "equal",
          value: "true",
          action: "mark_as_trusted",
          description: "Verified data",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          chatId,
          "trusted-default-with-matching-policy",
          { value: { verified: "true" } },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.reason).toContain("Verified data"); // Should use policy reason, not default
      });
    });

    describe("operator evaluation", () => {
      test("equal operator works correctly", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "status",
          operator: "equal",
          value: "verified",
          action: "mark_as_trusted",
          description: "Verified status",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { status: "verified" } },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { status: "unverified" } },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("notEqual operator works correctly", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "source",
          operator: "notEqual",
          value: "untrusted",
          action: "mark_as_trusted",
          description: "Not from untrusted source",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { source: "trusted" } },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { source: "untrusted" } },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("contains operator works correctly", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "url",
          operator: "contains",
          value: "trusted-domain.com",
          action: "mark_as_trusted",
          description: "From trusted domain",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { url: "https://api.trusted-domain.com/data" } },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { url: "https://untrusted.com/data" } },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("notContains operator works correctly", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "content",
          operator: "notContains",
          value: "malicious",
          action: "mark_as_trusted",
          description: "No malicious content",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { content: "This is safe content" } },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { content: "This contains malicious code" } },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("startsWith operator works correctly", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "path",
          operator: "startsWith",
          value: "/trusted/",
          action: "mark_as_trusted",
          description: "Trusted path",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { path: "/trusted/data/file.json" } },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { path: "/untrusted/data/file.json" } },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("endsWith operator works correctly", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "email",
          operator: "endsWith",
          value: "@company.com",
          action: "mark_as_trusted",
          description: "Company email",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { email: "user@company.com" } },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { email: "user@external.com" } },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });

      test("regex operator works correctly", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "id",
          operator: "regex",
          value: "^[A-Z]{3}-[0-9]{5}$",
          action: "mark_as_trusted",
          description: "Valid ID format",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { id: "ABC-12345" } },
        );
        expect(trustedResult.isTrusted).toBe(true);

        const untrustedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { id: "invalid-id" } },
        );
        expect(untrustedResult.isTrusted).toBe(false);
      });
    });

    describe("wildcard path evaluation", () => {
      test("evaluates wildcard paths correctly", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "emails[*].from",
          operator: "endsWith",
          value: "@trusted.com",
          action: "mark_as_trusted",
          description: "Emails from trusted domain",
        });

        // All emails from trusted domain - should be trusted
        const trustedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
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
          chatId,
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

      test("handles empty arrays in wildcard paths", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "items[*].verified",
          operator: "equal",
          value: "true",
          action: "mark_as_trusted",
          description: "All items verified",
        });

        // Empty array - should be untrusted (no values to verify)
        const result = await TrustedDataPolicyModel.evaluate(chatId, toolName, {
          value: { items: [] },
        });
        expect(result.isTrusted).toBe(false);
      });

      test("handles non-array values in wildcard paths", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "items[*].verified",
          operator: "equal",
          value: "true",
          action: "mark_as_trusted",
          description: "All items verified",
        });

        // Non-array value - should be untrusted
        const result = await TrustedDataPolicyModel.evaluate(chatId, toolName, {
          value: { items: "not an array" },
        });
        expect(result.isTrusted).toBe(false);
      });
    });

    describe("nested path evaluation", () => {
      test("evaluates deeply nested paths", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "response.data.user.verified",
          operator: "equal",
          value: "true",
          action: "mark_as_trusted",
          description: "User is verified",
        });

        const trustedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
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
          chatId,
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

      test("handles missing nested paths", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "response.data.user.verified",
          operator: "equal",
          value: "true",
          action: "mark_as_trusted",
          description: "User is verified",
        });

        // Missing path - should be untrusted
        const result = await TrustedDataPolicyModel.evaluate(chatId, toolName, {
          value: {
            response: {
              data: {
                // user object missing
              },
            },
          },
        });
        expect(result.isTrusted).toBe(false);
      });
    });

    describe("blocked action", () => {
      test("blocks data when a block_always policy matches", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "source",
          operator: "equal",
          value: "malicious",
          action: "block_always",
          description: "Block malicious sources",
        });

        const result = await TrustedDataPolicyModel.evaluate(chatId, toolName, {
          value: { source: "malicious", data: "some data" },
        });

        expect(result.isTrusted).toBe(false);
        expect(result.isBlocked).toBe(true);
        expect(result.reason).toContain("Data blocked by policy");
      });

      test("blocked policies take precedence over allow policies", async () => {
        // Create an allow policy
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "type",
          operator: "equal",
          value: "email",
          action: "mark_as_trusted",
          description: "Allow email data",
        });

        // Create a block policy for malicious content
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "from",
          operator: "contains",
          value: "hacker",
          action: "block_always",
          description: "Block hacker emails",
        });

        const result = await TrustedDataPolicyModel.evaluate(chatId, toolName, {
          value: { type: "email", from: "hacker@evil.com" },
        });

        expect(result.isTrusted).toBe(false);
        expect(result.isBlocked).toBe(true);
        expect(result.reason).toContain("Block hacker emails");
      });

      test("blocked policies work with wildcard paths", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "emails[*].from",
          operator: "contains",
          value: "spam",
          action: "block_always",
          description: "Block spam emails",
        });

        // Should block if ANY email matches the condition
        const result = await TrustedDataPolicyModel.evaluate(chatId, toolName, {
          value: {
            emails: [
              { from: "user@company.com", subject: "Work" },
              { from: "spam@spammer.com", subject: "Buy now" },
            ],
          },
        });

        expect(result.isTrusted).toBe(false);
        expect(result.isBlocked).toBe(true);
      });

      test("data passes when no blocked policy matches", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "source",
          operator: "equal",
          value: "malicious",
          action: "block_always",
          description: "Block malicious sources",
        });

        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "source",
          operator: "equal",
          value: "trusted",
          action: "mark_as_trusted",
          description: "Allow trusted sources",
        });

        const result = await TrustedDataPolicyModel.evaluate(chatId, toolName, {
          value: { source: "trusted" },
        });

        expect(result.isTrusted).toBe(true);
        expect(result.isBlocked).toBe(false);
        expect(result.reason).toContain("Allow trusted sources");
      });

      test("blocked policies work with different operators", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "domain",
          operator: "endsWith",
          value: ".blocked.com",
          action: "block_always",
          description: "Block blacklisted domains",
        });

        const blockedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { domain: "evil.blocked.com" } },
        );
        expect(blockedResult.isBlocked).toBe(true);

        const allowedResult = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { domain: "safe.com" } },
        );
        expect(allowedResult.isBlocked).toBe(false);
      });

      test("blocked policies override dataIsTrustedByDefault", async () => {
        // Create a tool with dataIsTrustedByDefault
        await ToolModel.createToolIfNotExists({
          agentId,
          name: "default-trusted-tool",
          parameters: {},
          description: "Tool that trusts data by default",
          allowUsageWhenUntrustedDataIsPresent: false,
          dataIsTrustedByDefault: true,
        });

        const tools = await ToolModel.findAll();
        const trustedToolId = tools.find(
          (t) => t.name === "default-trusted-tool",
        )?.id;

        // Create a block policy
        await TrustedDataPolicyModel.create({
          toolId: trustedToolId as string,
          attributePath: "dangerous",
          operator: "equal",
          value: "true",
          action: "block_always",
          description: "Block dangerous data",
        });

        const result = await TrustedDataPolicyModel.evaluate(
          chatId,
          "default-trusted-tool",
          { value: { dangerous: "true", other: "data" } },
        );

        expect(result.isTrusted).toBe(false);
        expect(result.isBlocked).toBe(true);
        expect(result.reason).toContain("Block dangerous data");
      });
    });

    describe("multiple policies", () => {
      test("trusts data when any policy matches", async () => {
        // Create multiple policies
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "source",
          operator: "equal",
          value: "api-v1",
          action: "mark_as_trusted",
          description: "API v1 source",
        });

        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "source",
          operator: "equal",
          value: "api-v2",
          action: "mark_as_trusted",
          description: "API v2 source",
        });

        // Test first policy match
        const result1 = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { source: "api-v1" } },
        );
        expect(result1.isTrusted).toBe(true);
        expect(result1.reason).toContain("API v1 source");

        // Test second policy match
        const result2 = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { source: "api-v2" } },
        );
        expect(result2.isTrusted).toBe(true);
        expect(result2.reason).toContain("API v2 source");

        // Test no match
        const result3 = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { source: "unknown" } },
        );
        expect(result3.isTrusted).toBe(false);
      });

      test("evaluates policies for different attributes", async () => {
        // Create policies for different attributes
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "source",
          operator: "equal",
          value: "trusted",
          action: "mark_as_trusted",
          description: "Trusted source",
        });

        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "verified",
          operator: "equal",
          value: "true",
          action: "mark_as_trusted",
          description: "Verified data",
        });

        // Only first attribute matches - should be trusted
        const result1 = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { source: "trusted", verified: "false" } },
        );
        expect(result1.isTrusted).toBe(true);

        // Only second attribute matches - should be trusted
        const result2 = await TrustedDataPolicyModel.evaluate(
          chatId,
          toolName,
          { value: { source: "untrusted", verified: "true" } },
        );
        expect(result2.isTrusted).toBe(true);
      });
    });

    describe("tool output structure handling", () => {
      test("handles direct value in tool output", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "status",
          operator: "equal",
          value: "success",
          action: "mark_as_trusted",
          description: "Successful response",
        });

        // Direct object (no value wrapper)
        const result = await TrustedDataPolicyModel.evaluate(chatId, toolName, {
          status: "success",
          data: "some data",
        });
        expect(result.isTrusted).toBe(true);
      });

      test("handles value wrapper in tool output", async () => {
        await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "status",
          operator: "equal",
          value: "success",
          action: "mark_as_trusted",
          description: "Successful response",
        });

        // Wrapped in value property
        const result = await TrustedDataPolicyModel.evaluate(chatId, toolName, {
          value: { status: "success", data: "some data" },
        });
        expect(result.isTrusted).toBe(true);
      });
    });
  });
});
