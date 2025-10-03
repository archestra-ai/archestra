import { beforeEach, describe, expect, test } from "vitest";
import type { Tool } from "../types";
import AgentModel from "./agent";
import ToolModel from "./tool";
import TrustedDataPolicyModel from "./trusted-data-policy";

describe("TrustedDataPolicyModel", () => {
  const toolName = "test-tool";

  let agentId: string;
  let toolId: string;

  beforeEach(async () => {
    // Create test agent
    const agent = await AgentModel.create({ name: "Test Agent" });
    agentId = agent.id;

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
        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: "some data" },
        );

        expect(result.isTrusted).toBe(false);
        expect(result.trustReason).toContain("No trust policy defined");
      });

      test("marks data as trusted when policy matches", async () => {
        // Create a trust policy
        const policy = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "source",
          operator: "equal",
          value: "trusted-api",
          description: "Trusted API source",
        });

        // Link policy to agent
        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "trusted-api", data: "some data" } },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.trustReason).toContain("Trusted API source");
      });

      test("marks data as untrusted when policy doesn't match", async () => {
        // Create a trust policy
        const policy = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "source",
          operator: "equal",
          value: "trusted-api",
          description: "Trusted API source",
        });

        // Link policy to agent
        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "untrusted-api", data: "some data" } },
        );

        expect(result.isTrusted).toBe(false);
        expect(result.trustReason).toContain(
          "does not match any trust policies",
        );
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
          agentId,
          "trusted-by-default-tool",
          { value: "any data" },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.trustReason).toContain(
          "configured to trust data by default",
        );
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
        const policy = await TrustedDataPolicyModel.create({
          toolId: trustedToolId as string,
          attributePath: "special",
          operator: "equal",
          value: "magic",
          description: "Special case",
        });

        // Link policy to agent
        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          "trusted-by-default-with-policies",
          { value: { normal: "data" } },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.trustReason).toContain(
          "configured to trust data by default",
        );
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
        const policy = await TrustedDataPolicyModel.create({
          toolId: trustedToolId as string,
          attributePath: "verified",
          operator: "equal",
          value: "true",
          description: "Verified data",
        });

        // Link policy to agent
        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          "trusted-default-with-matching-policy",
          { value: { verified: "true" } },
        );

        expect(result.isTrusted).toBe(true);
        expect(result.trustReason).toContain("Verified data"); // Should use policy reason, not default
      });
    });

    describe("operator evaluation", () => {
      test("equal operator works correctly", async () => {
        const policy = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "status",
          operator: "equal",
          value: "verified",
          description: "Verified status",
        });

        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

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

      test("notEqual operator works correctly", async () => {
        const policy = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "source",
          operator: "notEqual",
          value: "untrusted",
          description: "Not from untrusted source",
        });

        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

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

      test("contains operator works correctly", async () => {
        const policy = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "url",
          operator: "contains",
          value: "trusted-domain.com",
          description: "From trusted domain",
        });

        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

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

      test("notContains operator works correctly", async () => {
        const policy = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "content",
          operator: "notContains",
          value: "malicious",
          description: "No malicious content",
        });

        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

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

      test("startsWith operator works correctly", async () => {
        const policy = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "path",
          operator: "startsWith",
          value: "/trusted/",
          description: "Trusted path",
        });

        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

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

      test("endsWith operator works correctly", async () => {
        const policy = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "email",
          operator: "endsWith",
          value: "@company.com",
          description: "Company email",
        });

        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

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

      test("regex operator works correctly", async () => {
        const policy = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "id",
          operator: "regex",
          value: "^[A-Z]{3}-[0-9]{5}$",
          description: "Valid ID format",
        });

        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

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
      test("evaluates wildcard paths correctly", async () => {
        const policy = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "emails[*].from",
          operator: "endsWith",
          value: "@trusted.com",
          description: "Emails from trusted domain",
        });

        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

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

      test("handles empty arrays in wildcard paths", async () => {
        const policy = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "items[*].verified",
          operator: "equal",
          value: "true",
          description: "All items verified",
        });

        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

        // Empty array - should be untrusted (no values to verify)
        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { items: [] } },
        );
        expect(result.isTrusted).toBe(false);
      });

      test("handles non-array values in wildcard paths", async () => {
        const policy = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "items[*].verified",
          operator: "equal",
          value: "true",
          description: "All items verified",
        });

        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

        // Non-array value - should be untrusted
        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { items: "not an array" } },
        );
        expect(result.isTrusted).toBe(false);
      });
    });

    describe("nested path evaluation", () => {
      test("evaluates deeply nested paths", async () => {
        const policy = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "response.data.user.verified",
          operator: "equal",
          value: "true",
          description: "User is verified",
        });

        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

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

      test("handles missing nested paths", async () => {
        const policy = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "response.data.user.verified",
          operator: "equal",
          value: "true",
          description: "User is verified",
        });

        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

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

    describe("multiple policies", () => {
      test("trusts data when any policy matches", async () => {
        // Create multiple policies
        const policy1 = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "source",
          operator: "equal",
          value: "api-v1",
          description: "API v1 source",
        });

        const policy2 = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "source",
          operator: "equal",
          value: "api-v2",
          description: "API v2 source",
        });

        await AgentModel.assignTrustedDataPolicy(agentId, policy1.id);
        await AgentModel.assignTrustedDataPolicy(agentId, policy2.id);

        // Test first policy match
        const result1 = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "api-v1" } },
        );
        expect(result1.isTrusted).toBe(true);
        expect(result1.trustReason).toContain("API v1 source");

        // Test second policy match
        const result2 = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "api-v2" } },
        );
        expect(result2.isTrusted).toBe(true);
        expect(result2.trustReason).toContain("API v2 source");

        // Test no match
        const result3 = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { source: "unknown" } },
        );
        expect(result3.isTrusted).toBe(false);
      });

      test("evaluates policies for different attributes", async () => {
        // Create policies for different attributes
        const policy1 = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "source",
          operator: "equal",
          value: "trusted",
          description: "Trusted source",
        });

        const policy2 = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "verified",
          operator: "equal",
          value: "true",
          description: "Verified data",
        });

        await AgentModel.assignTrustedDataPolicy(agentId, policy1.id);
        await AgentModel.assignTrustedDataPolicy(agentId, policy2.id);

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
      test("handles direct value in tool output", async () => {
        const policy = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "status",
          operator: "equal",
          value: "success",
          description: "Successful response",
        });

        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

        // Direct object (no value wrapper)
        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { status: "success", data: "some data" },
        );
        expect(result.isTrusted).toBe(true);
      });

      test("handles value wrapper in tool output", async () => {
        const policy = await TrustedDataPolicyModel.create({
          toolId,
          attributePath: "status",
          operator: "equal",
          value: "success",
          description: "Successful response",
        });

        await AgentModel.assignTrustedDataPolicy(agentId, policy.id);

        // Wrapped in value property
        const result = await TrustedDataPolicyModel.evaluate(
          agentId,
          toolName,
          { value: { status: "success", data: "some data" } },
        );
        expect(result.isTrusted).toBe(true);
      });
    });
  });
});
