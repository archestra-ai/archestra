import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import { createToolOutputLlmSummarizer } from "./tool-output-llm-summarizer";
import {
  compactToolResultForPrompt,
  DbToolArtifactStore,
} from "./tool-output-offload";

const offloadConfig = {
  enabled: true,
  compactPreviewChars: 120,
};

describe("DbToolArtifactStore", () => {
  test("persists raw artifact for offloaded tool results", async ({
    makeAgent,
    makeConversation,
  }) => {
    const agent = await makeAgent();
    const conversation = await makeConversation(agent.id);
    const store = new DbToolArtifactStore();
    const summarizer = createToolOutputLlmSummarizer({
      model: "mock-model" as never,
      modelName: "test-db-store",
      generateObjectFn: (async () => ({
        object: {
          summary: "DB store integration summary without raw preview.",
        },
      })) as never,
      timeoutMs: 100,
    });

    const block = await compactToolResultForPrompt({
      conversationId: conversation.id,
      toolCallId: "call_db_store",
      toolResultId: "tool_result_db_store",
      toolName: "github.search",
      status: "success",
      rawOutput: {
        results: ["ENG-404", "ENG-405"],
        note: "integration ".repeat(400),
      },
      config: offloadConfig,
      store,
      summarizer,
    });

    expect(block.type).toBe("TOOL_RESULT_REF");
    if (block.type !== "TOOL_RESULT_REF") throw new Error("expected ref block");

    const [artifact] = await db
      .select()
      .from(schema.toolOutputArtifactsTable)
      .where(eq(schema.toolOutputArtifactsTable.id, "tool_result_db_store"));
    expect(artifact).toMatchObject({
      conversationId: conversation.id,
      toolName: "github.search",
      status: "success",
    });
    expect(artifact?.rawOutputJson).toMatchObject({
      results: ["ENG-404", "ENG-405"],
    });

    expect(block.summary).toBe(
      "DB store integration summary without raw preview.",
    );

    const raw = await store.getRawToolResult(
      `tool-output://conversation/${conversation.id}/tool-result/${block.toolResultId}`,
      {
        conversationId: conversation.id,
      },
    );
    expect(raw?.rawOutput).toMatchObject({
      results: ["ENG-404", "ENG-405"],
    });
    expect(raw?.toolName).toBe("github.search");
  });
});
