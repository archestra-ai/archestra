import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { SkillSandboxModel } from "@/models";
import { SKILL_SANDBOX_HOME } from "@/skills-sandbox/runtime-image";
import { afterAll, beforeEach, describe, expect, test } from "@/test";
import {
  CAPPED_TOOL_RESULT_META_KEY,
  MAX_TOOL_RESULT_CONTEXT_CHARS,
  readCappedToolResult,
} from "@/utils/tool-result-cap";
import { capChatToolResult } from "./tool-result-spill";

interface SpillContext {
  organizationId: string;
  userId: string;
  agentId: string;
  conversationId: string;
}

// An agent whose caller can use the sandbox, plus a conversation of theirs.
const sandboxTest = test.extend<{ spillContext: SpillContext }>({
  spillContext: async (
    {
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
      makeAgent,
      makeConversation,
      seedAndAssignArchestraTools,
    },
    use,
  ) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { agent: ["read"] },
    });
    await makeMember(user.id, org.id, { role: role.role });
    const agent = await makeAgent({ name: "Sandbox Agent" });
    // seeding only includes the sandbox tools while the feature flag is on
    (config.skillsSandbox as { enabled: boolean }).enabled = true;
    await seedAndAssignArchestraTools(agent.id);
    const conversation = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });
    await use({
      organizationId: org.id,
      userId: user.id,
      agentId: agent.id,
      conversationId: conversation.id,
    });
  },
});

// Real DB + the real upload path: uploadFile only appends a replay event, so
// enabling the runtime flags is enough (no container is built).
describe("capChatToolResult", () => {
  const originalSkills = config.skillsSandbox.enabled;
  const originalDagger = config.daggerRuntime.enabled;

  beforeEach(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = true;
    (config.daggerRuntime as { enabled: boolean }).enabled = true;
  });
  afterAll(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = originalSkills;
    (config.daggerRuntime as { enabled: boolean }).enabled = originalDagger;
  });

  const oversized = `${"row,".repeat(MAX_TOOL_RESULT_CONTEXT_CHARS / 2)}END`;

  test("appends hook feedback to a result under the cap, keeping its shape", async () => {
    const rich = {
      content: "data",
      _meta: { ui: { resourceUri: "res://ui" } },
      structuredContent: { rows: [1, 2, 3] },
    };
    const context = {
      organizationId: "org",
      userId: "user",
      agentId: "agent",
    };

    expect(
      await capChatToolResult({
        result: "original output",
        hookFeedback: "you shall not pass",
        context,
        toolCallId: "call-1",
      }),
    ).toBe("original output\n\n[hook feedback] you shall not pass");
    expect(
      await capChatToolResult({
        result: rich,
        hookFeedback: "blocked by policy",
        context,
        toolCallId: "call-1",
      }),
    ).toEqual({
      ...rich,
      content: "data\n\n[hook feedback] blocked by policy",
    });
    expect(
      await capChatToolResult({
        result: rich,
        hookFeedback: null,
        context,
        toolCallId: "call-1",
      }),
    ).toBe(rich);
  });

  sandboxTest(
    "saves an oversized result to the conversation sandbox and caps what the model sees",
    async ({ spillContext: context }) => {
      const rich = {
        content: oversized,
        structuredContent: { rows: ["kept for the UI"] },
        rawContent: [{ type: "text", text: oversized }],
        _meta: { ui: { resourceUri: "res://ui" } },
      };

      const capped = await capChatToolResult({
        result: rich,
        hookFeedback: "hook says hi",
        context,
        toolCallId: "call-spill",
      });

      if (typeof capped === "string") throw new Error("expected rich result");
      const marker = readCappedToolResult(capped);
      expect(marker?.totalChars).toBe(oversized.length);
      expect(marker?.path).toMatch(
        new RegExp(`^${SKILL_SANDBOX_HOME}/tool-results/.+\\.txt$`),
      );
      expect(capped.content.length).toBeLessThanOrEqual(
        MAX_TOOL_RESULT_CONTEXT_CHARS,
      );
      expect(capped.content.startsWith(`[Tool result too large`)).toBe(true);
      expect(capped.content).toContain(marker?.path ?? "missing");
      expect(capped.content.endsWith("[hook feedback] hook says hi")).toBe(
        true,
      );
      expect(capped.structuredContent).toEqual(rich.structuredContent);
      expect(capped.rawContent).toEqual(rich.rawContent);
      expect(capped._meta).toMatchObject({ ui: { resourceUri: "res://ui" } });

      const sandbox = await SkillSandboxModel.findOrCreateDefault({
        organizationId: context.organizationId,
        userId: context.userId,
        conversationId: context.conversationId,
        defaultCwd: SKILL_SANDBOX_HOME,
      });
      const files = await sandboxUploads(sandbox.id);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe(marker?.path);
      expect(Buffer.from(files[0].data ?? "").toString("utf8")).toBe(oversized);

      // a replayed call (same toolCallId) reuses the stored file
      await capChatToolResult({
        result: rich,
        hookFeedback: null,
        context,
        toolCallId: "call-spill",
      });
      expect(await sandboxUploads(sandbox.id)).toHaveLength(1);
    },
  );

  sandboxTest(
    "truncates without storing anything in an encrypted chat",
    async ({ spillContext: context }) => {
      const capped = await capChatToolResult({
        result: { content: oversized },
        hookFeedback: null,
        context: { ...context, suppressContentLogging: true },
        toolCallId: "call-encrypted",
      });

      expectTruncatedWithoutPath(capped);
      const sandboxes = await db
        .select()
        .from(schema.skillSandboxesTable)
        .where(
          eq(schema.skillSandboxesTable.conversationId, context.conversationId),
        );
      expect(sandboxes).toHaveLength(0);
    },
  );

  test("truncates when the agent cannot use the sandbox", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeAgent,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { agent: ["read"] },
    });
    await makeMember(user.id, org.id, { role: role.role });
    const agent = await makeAgent({ name: "No Sandbox Agent" });
    const conversation = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });

    const capped = await capChatToolResult({
      result: { content: oversized },
      hookFeedback: null,
      context: {
        organizationId: org.id,
        userId: user.id,
        agentId: agent.id,
        conversationId: conversation.id,
      },
      toolCallId: "call-no-sandbox",
    });

    expectTruncatedWithoutPath(capped);
  });

  test("caps a plain string result without a conversation", async () => {
    const capped = await capChatToolResult({
      result: oversized,
      hookFeedback: null,
      context: { organizationId: "org", userId: "user", agentId: "agent" },
      toolCallId: "call-headless",
    });

    expect(typeof capped).toBe("string");
    expect((capped as string).length).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_CONTEXT_CHARS,
    );
    expect(oversized.startsWith((capped as string).split("\n\n")[1])).toBe(
      true,
    );
  });
});

// === Helpers ===

async function sandboxUploads(sandboxId: string) {
  return db
    .select()
    .from(schema.skillSandboxFilesTable)
    .where(eq(schema.skillSandboxFilesTable.sandboxId, sandboxId));
}

function expectTruncatedWithoutPath(
  capped: Awaited<ReturnType<typeof capChatToolResult>>,
) {
  if (typeof capped === "string") throw new Error("expected rich result");
  expect(capped._meta).toEqual({
    [CAPPED_TOOL_RESULT_META_KEY]: { totalChars: expect.any(Number) },
  });
  expect(capped.content.length).toBeLessThanOrEqual(
    MAX_TOOL_RESULT_CONTEXT_CHARS,
  );
}
