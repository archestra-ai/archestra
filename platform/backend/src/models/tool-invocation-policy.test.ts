import { beforeEach, describe, expect, test } from "vitest";
import AgentModel from "./agent";
import ChatModel from "./chat";
import InteractionModel from "./interaction";
import ToolModel from "./tool";
import ToolInvocationPolicyModel from "./tool-invocation-policy";

describe("ToolInvocationPolicyModel", () => {
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
      name: "test-tool",
      parameters: {},
      description: "Test tool",
      allowUsageWhenUntrustedDataIsPresent: false,
      dataIsTrustedByDefault: false,
    });

    const tools = await ToolModel.findAll();
    toolId = tools.find((t) => t.name === "test-tool")?.id;
  });

  describe("evaluate", () => {
    describe("basic policy evaluation", () => {
      test("allows tool invocation when no policies exist and context is clean", async () => {
        const result = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { arg1: "value1" },
        );

        expect(result.isAllowed).toBe(true);
        expect(result.reason).toBe("");
      });

      test("blocks tool invocation when block_always policy matches", async () => {
        // Create a block policy
        const policy = await ToolInvocationPolicyModel.create({
          toolId,
          argumentName: "email",
          operator: "endsWith",
          value: "@evil.com",
          action: "block_always",
          reason: "Blocked domain",
        });

        // Link policy to agent
        await AgentModel.addToolInvocationPolicy(agentId, policy.id);

        const result = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { email: "hacker@evil.com" },
        );

        expect(result.isAllowed).toBe(false);
        expect(result.reason).toContain("Blocked domain");
      });

      test("allows tool invocation when block_always policy doesn't match", async () => {
        // Create a block policy
        const policy = await ToolInvocationPolicyModel.create({
          toolId,
          argumentName: "email",
          operator: "endsWith",
          value: "@evil.com",
          action: "block_always",
          reason: "Blocked domain",
        });

        // Link policy to agent
        await AgentModel.addToolInvocationPolicy(agentId, policy.id);

        const result = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { email: "user@good.com" },
        );

        expect(result.isAllowed).toBe(true);
        expect(result.reason).toBe("");
      });
    });

    describe("tainted context handling", () => {
      beforeEach(async () => {
        // Taint the chat context
        await InteractionModel.create({
          chatId,
          content: { role: "user", content: "malicious input" },
          tainted: true,
          taintReason: "Untrusted user input",
        });
      });

      test("blocks tool invocation when context is tainted and no explicit allow rule exists", async () => {
        const result = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { arg1: "value1" },
        );

        expect(result.isAllowed).toBe(false);
        expect(result.reason).toContain("context has been tainted");
      });

      test("allows tool invocation when context is tainted but explicit allow rule matches", async () => {
        // Create an allow policy
        const policy = await ToolInvocationPolicyModel.create({
          toolId,
          argumentName: "path",
          operator: "startsWith",
          value: "/safe/",
          action: "allow_when_context_is_untrusted",
          reason: "Safe path allowed",
        });

        // Link policy to agent
        await AgentModel.addToolInvocationPolicy(agentId, policy.id);

        const result = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { path: "/safe/file.txt" },
        );

        expect(result.isAllowed).toBe(true);
        expect(result.reason).toBe("");
      });

      test("blocks tool invocation when context is tainted and allow rule doesn't match", async () => {
        // Create an allow policy
        const policy = await ToolInvocationPolicyModel.create({
          toolId,
          argumentName: "path",
          operator: "startsWith",
          value: "/safe/",
          action: "allow_when_context_is_untrusted",
          reason: "Safe path allowed",
        });

        // Link policy to agent
        await AgentModel.addToolInvocationPolicy(agentId, policy.id);

        const result = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { path: "/unsafe/file.txt" },
        );

        expect(result.isAllowed).toBe(false);
        expect(result.reason).toContain("context has been tainted");
      });

      test("allows tool invocation when context is tainted but tool allows usage with untrusted data", async () => {
        // Create a tool that allows usage when untrusted data is present
        await ToolModel.createToolIfNotExists({
          agentId,
          name: "permissive-tool",
          parameters: {},
          description: "Tool that allows untrusted data",
          allowUsageWhenUntrustedDataIsPresent: true,
          dataIsTrustedByDefault: false,
        });

        const result = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "permissive-tool",
          { arg1: "value1" },
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
          allowUsageWhenUntrustedDataIsPresent: true,
          dataIsTrustedByDefault: false,
        });

        const tools = await ToolModel.findAll();
        const permissiveToolId = tools.find(
          (t) => t.name === "permissive-tool-with-policies",
        )?.id;

        // Create a policy that doesn't match
        const policy = await ToolInvocationPolicyModel.create({
          toolId: permissiveToolId,
          argumentName: "special",
          operator: "equal",
          value: "magic",
          action: "allow_when_context_is_untrusted",
          reason: "Special case",
        });

        // Link policy to agent
        await AgentModel.addToolInvocationPolicy(agentId, policy.id);

        // Even though the allow policy doesn't match, the tool should still be allowed
        // because allowUsageWhenUntrustedDataIsPresent is true
        const result = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "permissive-tool-with-policies",
          { arg1: "value1" },
        );

        expect(result.isAllowed).toBe(true);
        expect(result.reason).toBe("");
      });
    });

    describe("operator evaluation", () => {
      test("equal operator works correctly", async () => {
        const policy = await ToolInvocationPolicyModel.create({
          toolId,
          argumentName: "status",
          operator: "equal",
          value: "active",
          action: "block_always",
          reason: "Active status blocked",
        });

        await AgentModel.addToolInvocationPolicy(agentId, policy.id);

        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { status: "active" },
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { status: "inactive" },
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("notEqual operator works correctly", async () => {
        const policy = await ToolInvocationPolicyModel.create({
          toolId,
          argumentName: "env",
          operator: "notEqual",
          value: "production",
          action: "block_always",
          reason: "Non-production blocked",
        });

        await AgentModel.addToolInvocationPolicy(agentId, policy.id);

        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { env: "development" },
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { env: "production" },
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("contains operator works correctly", async () => {
        const policy = await ToolInvocationPolicyModel.create({
          toolId,
          argumentName: "message",
          operator: "contains",
          value: "secret",
          action: "block_always",
          reason: "Secret content blocked",
        });

        await AgentModel.addToolInvocationPolicy(agentId, policy.id);

        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { message: "This contains a secret value" },
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { message: "This is safe content" },
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("notContains operator works correctly", async () => {
        const policy = await ToolInvocationPolicyModel.create({
          toolId,
          argumentName: "message",
          operator: "notContains",
          value: "approved",
          action: "block_always",
          reason: "Unapproved content blocked",
        });

        await AgentModel.addToolInvocationPolicy(agentId, policy.id);

        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { message: "This is not yet ready" },
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { message: "This is approved content" },
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("startsWith operator works correctly", async () => {
        const policy = await ToolInvocationPolicyModel.create({
          toolId,
          argumentName: "path",
          operator: "startsWith",
          value: "/tmp/",
          action: "block_always",
          reason: "Temp paths blocked",
        });

        await AgentModel.addToolInvocationPolicy(agentId, policy.id);

        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { path: "/tmp/file.txt" },
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { path: "/home/file.txt" },
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("endsWith operator works correctly", async () => {
        const policy = await ToolInvocationPolicyModel.create({
          toolId,
          argumentName: "file",
          operator: "endsWith",
          value: ".exe",
          action: "block_always",
          reason: "Executable files blocked",
        });

        await AgentModel.addToolInvocationPolicy(agentId, policy.id);

        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { file: "malware.exe" },
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { file: "document.pdf" },
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("regex operator works correctly", async () => {
        const policy = await ToolInvocationPolicyModel.create({
          toolId,
          argumentName: "email",
          operator: "regex",
          value: "^[a-zA-Z0-9._%+-]+@example\\.com$",
          action: "block_always",
          reason: "Example.com emails blocked",
        });

        await AgentModel.addToolInvocationPolicy(agentId, policy.id);

        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { email: "user@example.com" },
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { email: "user@other.com" },
        );
        expect(allowedResult.isAllowed).toBe(true);
      });
    });

    describe("nested argument paths", () => {
      test("evaluates nested paths using lodash get", async () => {
        const policy = await ToolInvocationPolicyModel.create({
          toolId,
          argumentName: "user.email",
          operator: "endsWith",
          value: "@blocked.com",
          action: "block_always",
          reason: "Blocked domain",
        });

        await AgentModel.addToolInvocationPolicy(agentId, policy.id);

        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { user: { email: "hacker@blocked.com", name: "Hacker" } },
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { user: { email: "user@allowed.com", name: "User" } },
        );
        expect(allowedResult.isAllowed).toBe(true);
      });
    });

    describe("missing arguments", () => {
      test("returns error for missing argument with allow policy", async () => {
        const policy = await ToolInvocationPolicyModel.create({
          toolId,
          argumentName: "required",
          operator: "equal",
          value: "yes",
          action: "allow_when_context_is_untrusted",
          reason: "Required argument",
        });

        await AgentModel.addToolInvocationPolicy(agentId, policy.id);

        const result = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { other: "value" },
        );

        expect(result.isAllowed).toBe(false);
        expect(result.reason).toContain("Missing required argument: required");
      });

      test("continues evaluation for missing argument with block policy", async () => {
        const policy = await ToolInvocationPolicyModel.create({
          toolId,
          argumentName: "optional",
          operator: "equal",
          value: "bad",
          action: "block_always",
          reason: "Bad value",
        });

        await AgentModel.addToolInvocationPolicy(agentId, policy.id);

        const result = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { other: "value" },
        );

        expect(result.isAllowed).toBe(true);
        expect(result.reason).toBe("");
      });
    });

    describe("multiple policies", () => {
      test("evaluates multiple policies in order", async () => {
        // Create multiple policies
        const blockPolicy = await ToolInvocationPolicyModel.create({
          toolId,
          argumentName: "email",
          operator: "endsWith",
          value: "@blocked.com",
          action: "block_always",
          reason: "Blocked domain",
        });

        const allowPolicy = await ToolInvocationPolicyModel.create({
          toolId,
          argumentName: "override",
          operator: "equal",
          value: "true",
          action: "allow_when_context_is_untrusted",
          reason: "Override allowed",
        });

        await AgentModel.addToolInvocationPolicy(agentId, blockPolicy.id);
        await AgentModel.addToolInvocationPolicy(agentId, allowPolicy.id);

        // Test that block policy is evaluated first
        const blockedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { email: "user@blocked.com", override: "false" },
        );
        expect(blockedResult.isAllowed).toBe(false);

        // Test that both policies are evaluated
        const allowedResult = await ToolInvocationPolicyModel.evaluate(
          chatId,
          agentId,
          "test-tool",
          { email: "user@allowed.com", override: "true" },
        );
        expect(allowedResult.isAllowed).toBe(true);
      });
    });
  });
});
