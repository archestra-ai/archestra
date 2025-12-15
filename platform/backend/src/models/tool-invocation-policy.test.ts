import { describe, expect, test } from "@/test";
import ToolModel from "./tool";
import ToolInvocationPolicyModel from "./tool-invocation-policy";

describe("ToolInvocationPolicyModel", () => {
  describe("evaluateBatch", () => {
    test("returns success when all tools are allowed", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();
      const tool1 = await makeTool({ agentId: agent.id, name: "tool-1" });
      const tool2 = await makeTool({ agentId: agent.id, name: "tool-2" });
      await makeAgentTool(agent.id, tool1.id);
      await makeAgentTool(agent.id, tool2.id);

      const result = await ToolInvocationPolicyModel.evaluateBatch(
        agent.id,
        [
          { toolCallName: "tool-1", toolInput: { arg: "value1" } },
          { toolCallName: "tool-2", toolInput: { arg: "value2" } },
        ],
        true,
      );

      expect(result.isAllowed).toBe(true);
      expect(result.reason).toBe("");
      expect(result.toolCallName).toBeUndefined();
    });

    test("returns first blocked tool when multiple tools are blocked", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
      makeToolPolicy,
    }) => {
      const agent = await makeAgent();
      const tool1 = await makeTool({ agentId: agent.id, name: "tool-1" });
      const tool2 = await makeTool({ agentId: agent.id, name: "tool-2" });
      const agentTool1 = await makeAgentTool(agent.id, tool1.id);
      const agentTool2 = await makeAgentTool(agent.id, tool2.id);

      // Block both tools
      await makeToolPolicy(agentTool1.id, {
        argumentName: "email",
        operator: "endsWith",
        value: "@evil.com",
        action: "block_always",
        reason: "Tool 1 blocked",
      });
      await makeToolPolicy(agentTool2.id, {
        argumentName: "email",
        operator: "endsWith",
        value: "@evil.com",
        action: "block_always",
        reason: "Tool 2 blocked",
      });

      const result = await ToolInvocationPolicyModel.evaluateBatch(
        agent.id,
        [
          { toolCallName: "tool-1", toolInput: { email: "bad@evil.com" } },
          { toolCallName: "tool-2", toolInput: { email: "bad@evil.com" } },
        ],
        true,
      );

      expect(result.isAllowed).toBe(false);
      expect(result.toolCallName).toBe("tool-1"); // First blocked
      expect(result.reason).toContain("Tool 1 blocked");
    });

    test("returns success when only Archestra tools are in the batch", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();
      await ToolModel.assignArchestraToolsToAgent(agent.id);

      const result = await ToolInvocationPolicyModel.evaluateBatch(
        agent.id,
        [
          { toolCallName: "archestra__whoami", toolInput: {} },
          { toolCallName: "archestra__get_profile", toolInput: { id: "123" } },
        ],
        false, // untrusted context
      );

      expect(result.isAllowed).toBe(true);
      expect(result.reason).toBe("");
    });

    test("skips Archestra tools and evaluates non-Archestra tools", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
      makeToolPolicy,
    }) => {
      const agent = await makeAgent();
      await ToolModel.assignArchestraToolsToAgent(agent.id);

      const tool = await makeTool({ agentId: agent.id, name: "regular-tool" });
      const agentTool = await makeAgentTool(agent.id, tool.id);

      await makeToolPolicy(agentTool.id, {
        argumentName: "action",
        operator: "equal",
        value: "delete",
        action: "block_always",
        reason: "Delete blocked",
      });

      const result = await ToolInvocationPolicyModel.evaluateBatch(
        agent.id,
        [
          { toolCallName: "archestra__whoami", toolInput: {} },
          { toolCallName: "regular-tool", toolInput: { action: "delete" } },
        ],
        true,
      );

      expect(result.isAllowed).toBe(false);
      expect(result.toolCallName).toBe("regular-tool");
      expect(result.reason).toContain("Delete blocked");
    });

    test("returns success for empty tool calls array", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();

      const result = await ToolInvocationPolicyModel.evaluateBatch(
        agent.id,
        [],
        false,
      );

      expect(result.isAllowed).toBe(true);
      expect(result.reason).toBe("");
    });

    test("fetches security config for tools without policies", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();

      // Create tool with allowUsageWhenUntrustedDataIsPresent = true
      const tool = await makeTool({
        agentId: agent.id,
        name: "permissive-tool",
      });
      await makeAgentTool(agent.id, tool.id, {
        allowUsageWhenUntrustedDataIsPresent: true,
      });

      // No policies, but tool allows untrusted data
      const result = await ToolInvocationPolicyModel.evaluateBatch(
        agent.id,
        [{ toolCallName: "permissive-tool", toolInput: { arg: "value" } }],
        false, // untrusted context
      );

      expect(result.isAllowed).toBe(true);
      expect(result.reason).toBe("");
    });

    test("blocks tool when context is untrusted and no allow rule exists", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();
      const tool = await makeTool({ agentId: agent.id, name: "strict-tool" });
      await makeAgentTool(agent.id, tool.id, {
        allowUsageWhenUntrustedDataIsPresent: false,
      });

      const result = await ToolInvocationPolicyModel.evaluateBatch(
        agent.id,
        [{ toolCallName: "strict-tool", toolInput: { arg: "value" } }],
        false, // untrusted context
      );

      expect(result.isAllowed).toBe(false);
      expect(result.toolCallName).toBe("strict-tool");
      expect(result.reason).toContain("context contains untrusted data");
    });

    test("allows tool when explicit allow rule matches in untrusted context", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
      makeToolPolicy,
    }) => {
      const agent = await makeAgent();
      const tool = await makeTool({ agentId: agent.id, name: "guarded-tool" });
      const agentTool = await makeAgentTool(agent.id, tool.id, {
        allowUsageWhenUntrustedDataIsPresent: false,
      });

      await makeToolPolicy(agentTool.id, {
        argumentName: "path",
        operator: "startsWith",
        value: "/safe/",
        action: "allow_when_context_is_untrusted",
        reason: "Safe path allowed",
      });

      const result = await ToolInvocationPolicyModel.evaluateBatch(
        agent.id,
        [
          {
            toolCallName: "guarded-tool",
            toolInput: { path: "/safe/file.txt" },
          },
        ],
        false,
      );

      expect(result.isAllowed).toBe(true);
      expect(result.reason).toBe("");
    });

    test("block_always takes precedence over allowUsageWhenUntrustedDataIsPresent", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
      makeToolPolicy,
    }) => {
      const agent = await makeAgent();
      const tool = await makeTool({ agentId: agent.id, name: "email-tool" });
      const agentTool = await makeAgentTool(agent.id, tool.id, {
        allowUsageWhenUntrustedDataIsPresent: true,
      });

      await makeToolPolicy(agentTool.id, {
        argumentName: "body",
        operator: "contains",
        value: "malicious",
        action: "block_always",
        reason: "Malicious content blocked",
      });

      const result = await ToolInvocationPolicyModel.evaluateBatch(
        agent.id,
        [
          {
            toolCallName: "email-tool",
            toolInput: { body: "malicious content" },
          },
        ],
        false,
      );

      expect(result.isAllowed).toBe(false);
      expect(result.toolCallName).toBe("email-tool");
      expect(result.reason).toContain("Malicious content blocked");
    });

    test("evaluates multiple tools with mixed results correctly", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
      makeToolPolicy,
    }) => {
      const agent = await makeAgent();

      // Tool 1: allowed
      const tool1 = await makeTool({ agentId: agent.id, name: "allowed-tool" });
      await makeAgentTool(agent.id, tool1.id, {
        allowUsageWhenUntrustedDataIsPresent: true,
      });

      // Tool 2: will be blocked by policy
      const tool2 = await makeTool({ agentId: agent.id, name: "blocked-tool" });
      const agentTool2 = await makeAgentTool(agent.id, tool2.id, {
        allowUsageWhenUntrustedDataIsPresent: true,
      });
      await makeToolPolicy(agentTool2.id, {
        argumentName: "dangerous",
        operator: "equal",
        value: "true",
        action: "block_always",
        reason: "Dangerous operation blocked",
      });

      // Tool 3: would also be blocked, but tool 2 should be returned first
      const tool3 = await makeTool({
        agentId: agent.id,
        name: "another-blocked",
      });
      const agentTool3 = await makeAgentTool(agent.id, tool3.id, {
        allowUsageWhenUntrustedDataIsPresent: false,
      });
      await makeToolPolicy(agentTool3.id, {
        argumentName: "bad",
        operator: "equal",
        value: "yes",
        action: "block_always",
        reason: "Bad operation",
      });

      const result = await ToolInvocationPolicyModel.evaluateBatch(
        agent.id,
        [
          { toolCallName: "allowed-tool", toolInput: { safe: "value" } },
          { toolCallName: "blocked-tool", toolInput: { dangerous: "true" } },
          { toolCallName: "another-blocked", toolInput: { bad: "yes" } },
        ],
        true,
      );

      expect(result.isAllowed).toBe(false);
      expect(result.toolCallName).toBe("blocked-tool"); // First blocked in order
      expect(result.reason).toContain("Dangerous operation blocked");
    });

    describe("operator evaluation", () => {
      test("equal operator works correctly", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeToolPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({ agentId: agent.id, name: "test-tool" });
        const agentTool = await makeAgentTool(agent.id, tool.id);

        await makeToolPolicy(agentTool.id, {
          argumentName: "status",
          operator: "equal",
          value: "active",
          action: "block_always",
          reason: "Active status blocked",
        });

        const blockedResult = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [{ toolCallName: "test-tool", toolInput: { status: "active" } }],
          true,
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [{ toolCallName: "test-tool", toolInput: { status: "inactive" } }],
          true,
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("notEqual operator works correctly", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeToolPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({ agentId: agent.id, name: "test-tool" });
        const agentTool = await makeAgentTool(agent.id, tool.id);

        await makeToolPolicy(agentTool.id, {
          argumentName: "env",
          operator: "notEqual",
          value: "production",
          action: "block_always",
          reason: "Non-production blocked",
        });

        const blockedResult = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [{ toolCallName: "test-tool", toolInput: { env: "development" } }],
          true,
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [{ toolCallName: "test-tool", toolInput: { env: "production" } }],
          true,
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("contains operator works correctly", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeToolPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({ agentId: agent.id, name: "test-tool" });
        const agentTool = await makeAgentTool(agent.id, tool.id);

        await makeToolPolicy(agentTool.id, {
          argumentName: "message",
          operator: "contains",
          value: "secret",
          action: "block_always",
          reason: "Secret content blocked",
        });

        const blockedResult = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [
            {
              toolCallName: "test-tool",
              toolInput: { message: "This contains a secret value" },
            },
          ],
          true,
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [
            {
              toolCallName: "test-tool",
              toolInput: { message: "This is safe content" },
            },
          ],
          true,
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("notContains operator works correctly", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeToolPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({ agentId: agent.id, name: "test-tool" });
        const agentTool = await makeAgentTool(agent.id, tool.id);

        await makeToolPolicy(agentTool.id, {
          argumentName: "message",
          operator: "notContains",
          value: "approved",
          action: "block_always",
          reason: "Unapproved content blocked",
        });

        const blockedResult = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [
            {
              toolCallName: "test-tool",
              toolInput: { message: "This is not yet ready" },
            },
          ],
          true,
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [
            {
              toolCallName: "test-tool",
              toolInput: { message: "This is approved content" },
            },
          ],
          true,
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("startsWith operator works correctly", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeToolPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({ agentId: agent.id, name: "test-tool" });
        const agentTool = await makeAgentTool(agent.id, tool.id);

        await makeToolPolicy(agentTool.id, {
          argumentName: "path",
          operator: "startsWith",
          value: "/tmp/",
          action: "block_always",
          reason: "Temp paths blocked",
        });

        const blockedResult = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [{ toolCallName: "test-tool", toolInput: { path: "/tmp/file.txt" } }],
          true,
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [
            {
              toolCallName: "test-tool",
              toolInput: { path: "/home/file.txt" },
            },
          ],
          true,
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("endsWith operator works correctly", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeToolPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({ agentId: agent.id, name: "test-tool" });
        const agentTool = await makeAgentTool(agent.id, tool.id);

        await makeToolPolicy(agentTool.id, {
          argumentName: "file",
          operator: "endsWith",
          value: ".exe",
          action: "block_always",
          reason: "Executable files blocked",
        });

        const blockedResult = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [{ toolCallName: "test-tool", toolInput: { file: "malware.exe" } }],
          true,
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [{ toolCallName: "test-tool", toolInput: { file: "document.pdf" } }],
          true,
        );
        expect(allowedResult.isAllowed).toBe(true);
      });

      test("regex operator works correctly", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeToolPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({ agentId: agent.id, name: "test-tool" });
        const agentTool = await makeAgentTool(agent.id, tool.id);

        await makeToolPolicy(agentTool.id, {
          argumentName: "email",
          operator: "regex",
          value: "^[a-zA-Z0-9._%+-]+@example\\.com$",
          action: "block_always",
          reason: "Example.com emails blocked",
        });

        const blockedResult = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [
            {
              toolCallName: "test-tool",
              toolInput: { email: "user@example.com" },
            },
          ],
          true,
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [
            {
              toolCallName: "test-tool",
              toolInput: { email: "user@other.com" },
            },
          ],
          true,
        );
        expect(allowedResult.isAllowed).toBe(true);
      });
    });

    describe("nested argument paths", () => {
      test("evaluates nested paths using lodash get", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeToolPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({ agentId: agent.id, name: "test-tool" });
        const agentTool = await makeAgentTool(agent.id, tool.id);

        await makeToolPolicy(agentTool.id, {
          argumentName: "user.email",
          operator: "endsWith",
          value: "@blocked.com",
          action: "block_always",
          reason: "Blocked domain",
        });

        const blockedResult = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [
            {
              toolCallName: "test-tool",
              toolInput: {
                user: { email: "hacker@blocked.com", name: "Hacker" },
              },
            },
          ],
          true,
        );
        expect(blockedResult.isAllowed).toBe(false);

        const allowedResult = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [
            {
              toolCallName: "test-tool",
              toolInput: { user: { email: "user@allowed.com", name: "User" } },
            },
          ],
          true,
        );
        expect(allowedResult.isAllowed).toBe(true);
      });
    });

    describe("missing arguments", () => {
      test("returns error for missing argument with allow policy", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeToolPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({ agentId: agent.id, name: "test-tool" });
        const agentTool = await makeAgentTool(agent.id, tool.id);

        await makeToolPolicy(agentTool.id, {
          argumentName: "required",
          operator: "equal",
          value: "yes",
          action: "allow_when_context_is_untrusted",
          reason: "Required argument",
        });

        const result = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [{ toolCallName: "test-tool", toolInput: { other: "value" } }],
          false, // context is untrusted
        );

        expect(result.isAllowed).toBe(false);
        expect(result.reason).toContain("Missing required argument: required");
      });

      test("continues evaluation for missing argument with block policy", async ({
        makeAgent,
        makeTool,
        makeAgentTool,
        makeToolPolicy,
      }) => {
        const agent = await makeAgent();
        const tool = await makeTool({ agentId: agent.id, name: "test-tool" });
        const agentTool = await makeAgentTool(agent.id, tool.id);

        await makeToolPolicy(agentTool.id, {
          argumentName: "optional",
          operator: "equal",
          value: "bad",
          action: "block_always",
          reason: "Bad value",
        });

        const result = await ToolInvocationPolicyModel.evaluateBatch(
          agent.id,
          [{ toolCallName: "test-tool", toolInput: { other: "value" } }],
          true, // context is trusted
        );

        expect(result.isAllowed).toBe(true);
        expect(result.reason).toBe("");
      });
    });
  });
});
