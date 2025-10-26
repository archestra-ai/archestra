import type { Tool } from "@/types";

import AgentModel from "./agent";
import AgentToolModel from "./agent-tool";
import ToolModel from "./tool";
import ToolInvocationPolicyModel from "./tool-invocation-policy";

describe("ToolInvocationPolicyModel", () => {
  const toolName = "test-tool";

  let agentId: string;
  let toolId: string;
  let agentToolId: string;

  beforeEach(async () => {
    // Create test agent
    const agent = await AgentModel.create({
      name: "Test Agent",
      teams: [],
    });
    agentId = agent.id;

    // Create test tool
    await ToolModel.createToolIfNotExists({
      agentId,
      name: toolName,
      parameters: {},
      description: "Test tool",
    });

    const tool = await ToolModel.findByName(toolName);
    toolId = (tool as Tool).id;

    // Create agent-tool relationship with security config
    const agentTool = await AgentToolModel.create(agentId, toolId, {
      allowUsageWhenUntrustedDataIsPresent: false,
      toolResultTreatment: "untrusted",
    });
    agentToolId = agentTool.id;
  });

  describe("evaluate", () => {
    describe("basic policy evaluation", () => {
      test("allows tool invocation when no policies exist and context is trusted", async () => {
        const result = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { arg1: "value1" },
          true, // context is trusted
        );

        expect(result.isAllowed).toBe(true);
        expect(result.reason).toBe("");
      });

      test("blocks tool invocation when block_always policy matches", async () => {
        // Create a block policy
        await ToolInvocationPolicyModel.create({
          agentToolId,
          argumentName: "email",
          operator: "endsWith",
          value: "@evil.com",
          action: "block_always",
          reason: "Blocked domain",
        });

        const result = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { email: "hacker@evil.com" },
          true,
        );

        expect(result.isAllowed).toBe(false);
        expect(result.reason).toContain("Blocked domain");
      });

      test("allows tool invocation when block_always policy doesn't match", async () => {
        // Create a block policy
        await ToolInvocationPolicyModel.create({
          agentToolId,
          argumentName: "email",
          operator: "endsWith",
          value: "@evil.com",
          action: "block_always",
          reason: "Blocked domain",
        });

        const result = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { email: "user@good.com" },
          true,
        );

        expect(result.isAllowed).toBe(true);
        expect(result.reason).toBe("");
      });
    });

    describe("untrusted context handling", () => {
      test("blocks tool invocation when context is untrusted and no explicit allow rule exists", async () => {
        const result = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { arg1: "value1" },
          false, // context is untrusted
        );

        expect(result.isAllowed).toBe(false);
        expect(result.reason).toContain("context contains untrusted data");
      });

      test("allows tool invocation when context is untrusted but explicit allow rule matches", async () => {
        // Create an allow policy
        await ToolInvocationPolicyModel.create({
          agentToolId,
          argumentName: "path",
          operator: "startsWith",
          value: "/safe/",
          action: "allow_when_context_is_untrusted",
          reason: "Safe path allowed",
        });

        const result = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { path: "/safe/file.txt" },
          false, // context is untrusted
        );

        expect(result.isAllowed).toBe(true);
        expect(result.reason).toBe("");
      });

      test("blocks tool invocation when context is untrusted and allow rule doesn't match", async () => {
        // Create an allow policy
        await ToolInvocationPolicyModel.create({
          agentToolId,
          argumentName: "path",
          operator: "startsWith",
          value: "/safe/",
          action: "allow_when_context_is_untrusted",
          reason: "Safe path allowed",
        });

        const result = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { path: "/unsafe/file.txt" },
          false, // context is untrusted
        );

        expect(result.isAllowed).toBe(false);
        expect(result.reason).toContain("context contains untrusted data");
      });

      test("allows tool invocation when context is untrusted but tool allows usage with untrusted data", async () => {
        // Create a tool that allows usage when untrusted data is present
        await ToolModel.createToolIfNotExists({
          agentId,
          name: "permissive-tool",
          parameters: {},
          description: "Tool that allows untrusted data",
        });

        const permissiveTool = await ToolModel.findByName("permissive-tool");
        const permissiveToolId = (permissiveTool as Tool).id;

        // Create agent-tool relationship with permissive security config
        await AgentToolModel.create(agentId, permissiveToolId, {
          allowUsageWhenUntrustedDataIsPresent: true,
          toolResultTreatment: "untrusted",
        });

        const result = await ToolInvocationPolicyModel.evaluate(
          agentId,
          "permissive-tool",
          { arg1: "value1" },
          false, // context is untrusted
        );

        expect(result.isAllowed).toBe(true);
        expect(result.reason).toBe("");
      });

      test("respects tool's allowUsageWhenUntrustedDataIsPresent flag when policies exist", async () => {
        // Create a tool that allows usage when untrusted data is present
        await ToolModel.createToolIfNotExists({
          agentId,
          name: "permissive-tool-with-policies",
          parameters: {},
          description: "Tool that allows untrusted data",
        });

        const tool = await ToolModel.findByName(
          "permissive-tool-with-policies",
        );
        const permissiveToolId = (tool as Tool).id;

        // Create agent-tool relationship with permissive security config
        const permissiveAgentTool = await AgentToolModel.create(
          agentId,
          permissiveToolId,
          {
            allowUsageWhenUntrustedDataIsPresent: true,
            toolResultTreatment: "untrusted",
          },
        );

        // Create a policy that doesn't match
        await ToolInvocationPolicyModel.create({
          agentToolId: permissiveAgentTool.id,
          argumentName: "special",
          operator: "equal",
          value: "magic",
          action: "allow_when_context_is_untrusted",
          reason: "Special case",
        });

        // Even though the allow policy doesn't match, the tool should still be allowed
        // because allowUsageWhenUntrustedDataIsPresent is true
        const result = await ToolInvocationPolicyModel.evaluate(
          agentId,
          "permissive-tool-with-policies",
          { arg1: "value1" },
          false, // context is untrusted
        );

        expect(result.isAllowed).toBe(true);
        expect(result.reason).toBe("");
      });
    });

    describe("operator evaluation", () => {
      test("equal operator works correctly", async () => {
        await ToolInvocationPolicyModel.create({
          agentToolId,
          argumentName: "status",
          operator: "equal",
          value: "active",
          action: "block_always",
          reason: "Active status blocked",
        });

        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { status: "active" },
          true,
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { status: "inactive" },
          true,
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("notEqual operator works correctly", async () => {
        await ToolInvocationPolicyModel.create({
          agentToolId,
          argumentName: "env",
          operator: "notEqual",
          value: "production",
          action: "block_always",
          reason: "Non-production blocked",
        });

        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { env: "development" },
          true,
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { env: "production" },
          true,
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("contains operator works correctly", async () => {
        await ToolInvocationPolicyModel.create({
          agentToolId,
          argumentName: "message",
          operator: "contains",
          value: "secret",
          action: "block_always",
          reason: "Secret content blocked",
        });

        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { message: "This contains a secret value" },
          true,
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { message: "This is safe content" },
          true,
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("notContains operator works correctly", async () => {
        await ToolInvocationPolicyModel.create({
          agentToolId,
          argumentName: "message",
          operator: "notContains",
          value: "approved",
          action: "block_always",
          reason: "Unapproved content blocked",
        });

        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { message: "This is not yet ready" },
          true,
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { message: "This is approved content" },
          true,
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("startsWith operator works correctly", async () => {
        await ToolInvocationPolicyModel.create({
          agentToolId,
          argumentName: "path",
          operator: "startsWith",
          value: "/tmp/",
          action: "block_always",
          reason: "Temp paths blocked",
        });

        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { path: "/tmp/file.txt" },
          true,
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { path: "/home/file.txt" },
          true,
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("endsWith operator works correctly", async () => {
        await ToolInvocationPolicyModel.create({
          agentToolId,
          argumentName: "file",
          operator: "endsWith",
          value: ".exe",
          action: "block_always",
          reason: "Executable files blocked",
        });

        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { file: "malware.exe" },
          true,
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { file: "document.pdf" },
          true,
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("regex operator works correctly", async () => {
        await ToolInvocationPolicyModel.create({
          agentToolId,
          argumentName: "email",
          operator: "regex",
          value: "^[a-zA-Z0-9._%+-]+@example\\.com$",
          action: "block_always",
          reason: "Example.com emails blocked",
        });

        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { email: "user@example.com" },
          true,
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { email: "user@other.com" },
          true,
        );
        expect(allowedResult.isAllowed).toBe(true);
      });
    });

    describe("nested argument paths", () => {
      test("evaluates nested paths using lodash get", async () => {
        await ToolInvocationPolicyModel.create({
          agentToolId,
          argumentName: "user.email",
          operator: "endsWith",
          value: "@blocked.com",
          action: "block_always",
          reason: "Blocked domain",
        });

        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { user: { email: "hacker@blocked.com", name: "Hacker" } },
          true,
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { user: { email: "user@allowed.com", name: "User" } },
          true,
        );
        expect(allowedResult.isAllowed).toBe(true);
      });
    });

    describe("missing arguments", () => {
      test("returns error for missing argument with allow policy", async () => {
        await ToolInvocationPolicyModel.create({
          agentToolId,
          argumentName: "required",
          operator: "equal",
          value: "yes",
          action: "allow_when_context_is_untrusted",
          reason: "Required argument",
        });

        const result = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { other: "value" },
          false, // context is untrusted
        );

        expect(result.isAllowed).toBe(false);
        expect(result.reason).toContain("Missing required argument: required");
      });

      test("continues evaluation for missing argument with block policy", async () => {
        await ToolInvocationPolicyModel.create({
          agentToolId,
          argumentName: "optional",
          operator: "equal",
          value: "bad",
          action: "block_always",
          reason: "Bad value",
        });

        const result = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { other: "value" },
          true, // context is trusted
        );

        expect(result.isAllowed).toBe(true);
        expect(result.reason).toBe("");
      });
    });

    describe("multiple policies", () => {
      test("evaluates multiple policies in order", async () => {
        // Create multiple policies
        await ToolInvocationPolicyModel.create({
          agentToolId,
          argumentName: "email",
          operator: "endsWith",
          value: "@blocked.com",
          action: "block_always",
          reason: "Blocked domain",
        });

        await ToolInvocationPolicyModel.create({
          agentToolId,
          argumentName: "override",
          operator: "equal",
          value: "true",
          action: "allow_when_context_is_untrusted",
          reason: "Override allowed",
        });

        // Test that block policy is evaluated first
        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { email: "user@blocked.com", override: "false" },
          true,
        );
        expect(blockedResult.isAllowed).toBe(false);

        // Test that both policies are evaluated
        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          agentId,
          toolName,
          { email: "user@allowed.com", override: "true" },
          false, // untrusted context but override allowed
        );
        expect(allowedResult.isAllowed).toBe(true);
      });
    });
  });
});
