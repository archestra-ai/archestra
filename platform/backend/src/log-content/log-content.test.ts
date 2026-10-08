/**
 * Contract under test — with `ARCHESTRA_LOGS_CONTENT_MODE` set to
 * "metadata_only", no prompt, response, tool argument or tool result reaches
 * the log tables, while everything usage, cost and the audit trail read from
 * those rows still does.
 */
import {
  isLogContentNotStored,
  MCP_EXECUTED_AS_META_KEY,
  platformExecutedAs,
} from "@archestra/shared";
import { sql } from "drizzle-orm";
import config from "@/config";
import db from "@/database";
import InteractionModel from "@/models/interaction";
import McpToolCallModel from "@/models/mcp-tool-call";
import { afterEach, describe, expect, test } from "@/test";
import type { InteractionRequest, InteractionResponse } from "@/types";

afterEach(() => {
  config.logs.contentMode = "full";
});

const PRIVATE = "the-private-quarterly-numbers";

const request = {
  model: "claude-sonnet-5",
  messages: [{ role: "user", content: `summarize ${PRIVATE}` }],
} as unknown as InteractionRequest;
const response = {
  id: "msg-1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: `here is ${PRIVATE}` }],
} as unknown as InteractionResponse;

describe("LLM interactions", () => {
  test("Metadata only stores usage and attribution, never content", async ({
    makeAgent,
  }) => {
    config.logs.contentMode = "metadata_only";
    const agent = await makeAgent();

    const created = await InteractionModel.create({
      profileId: agent.id,
      type: "anthropic:messages",
      request,
      processedRequest: request,
      response,
      model: "claude-sonnet-5",
      inputTokens: 120,
      outputTokens: 40,
      cost: "0.0012000000",
    });

    const raw = await rawRow("interactions", created.id);
    expect(JSON.stringify(raw)).not.toContain(PRIVATE);
    expect(raw).toMatchObject({
      model: "claude-sonnet-5",
      input_tokens: 120,
      output_tokens: 40,
      processed_request: null,
    });
    expect(Number(raw.cost)).toBeCloseTo(0.0012);

    // Reads back as "not stored" with its outcome, not as a malformed payload.
    const found = await InteractionModel.findById(created.id);
    expect(isLogContentNotStored(found?.request)).toBe(true);
    expect(found?.response).toEqual({
      __redacted: "log_content_policy",
      isError: false,
    });
  });

  test("a failed request keeps that it failed, never the error text", async ({
    makeAgent,
  }) => {
    config.logs.contentMode = "metadata_only";
    const agent = await makeAgent();

    // Provider errors routinely echo the prompt back.
    const created = await InteractionModel.create({
      profileId: agent.id,
      type: "anthropic:messages",
      request,
      response: { error: `invalid request: ${PRIVATE}` },
    });

    const raw = await rawRow("interactions", created.id);
    expect(JSON.stringify(raw)).not.toContain(PRIVATE);
    expect(raw.response).toEqual({
      __redacted: "log_content_policy",
      isError: true,
    });
  });

  test("rows without an agent are withheld too", async () => {
    config.logs.contentMode = "metadata_only";

    const created = await InteractionModel.create({
      profileId: null,
      type: "anthropic:messages",
      request,
      response,
      inputTokens: 5,
    });

    const raw = await rawRow("interactions", created.id);
    expect(JSON.stringify(raw)).not.toContain(PRIVATE);
    expect(raw.input_tokens).toBe(5);
  });

  test("Full content, the default, stores the request and response", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const created = await InteractionModel.create({
      profileId: agent.id,
      type: "anthropic:messages",
      request,
      response,
    });

    expect(JSON.stringify(await rawRow("interactions", created.id))).toContain(
      PRIVATE,
    );
  });
});

describe("MCP tool calls", () => {
  test("Metadata only keeps the tool, status and identity, never arguments or results", async ({
    makeAgent,
  }) => {
    config.logs.contentMode = "metadata_only";
    const agent = await makeAgent();

    const created = await McpToolCallModel.create({
      agentId: agent.id,
      mcpServerName: "gmail",
      method: "tools/call",
      toolCall: {
        id: "call-1",
        name: "gmail__send_email",
        arguments: { to: "cfo@example.com", body: PRIVATE },
      },
      toolResult: {
        id: "call-1",
        name: "gmail__send_email",
        arguments: { body: PRIVATE },
        content: [{ type: "text", text: `sent ${PRIVATE}` }],
        isError: true,
        error: `stopped while sending ${PRIVATE}`,
        _meta: {
          archestraError: { type: "cancelled", message: `stopped: ${PRIVATE}` },
          [MCP_EXECUTED_AS_META_KEY]: platformExecutedAs("user-1"),
        },
      },
    });

    const raw = await rawRow("mcp_tool_calls", created.id);
    expect(JSON.stringify(raw)).not.toContain(PRIVATE);
    expect(raw.tool_call).toEqual({
      id: "call-1",
      name: "gmail__send_email",
      arguments: { __redacted: "log_content_policy" },
    });
    expect(raw.tool_result).toEqual({
      __redacted: "log_content_policy",
      isError: true,
      errorType: "cancelled",
      [MCP_EXECUTED_AS_META_KEY]: { kind: "platform", callerUserId: "user-1" },
    });
  });

  test("app-owned calls are withheld too", async ({
    makeApp,
    makeOrganization,
  }) => {
    config.logs.contentMode = "metadata_only";
    const app = await makeApp({
      organizationId: (await makeOrganization()).id,
    });

    const created = await McpToolCallModel.create({
      ownerType: "app",
      appId: app.id,
      mcpServerName: "notes",
      method: "tools/call",
      toolCall: {
        id: "call-1",
        name: "notes__read",
        arguments: { q: PRIVATE },
      },
      toolResult: { content: PRIVATE, isError: false },
    });

    expect(
      JSON.stringify(await rawRow("mcp_tool_calls", created.id)),
    ).not.toContain(PRIVATE);
  });

  test("discovery results are dropped too", async ({ makeAgent }) => {
    config.logs.contentMode = "metadata_only";
    const agent = await makeAgent();

    const created = await McpToolCallModel.create({
      agentId: agent.id,
      mcpServerName: "mcp-gateway",
      method: "tools/list",
      toolCall: null,
      toolResult: {
        tools: [{ name: "gmail__send_email", description: PRIVATE }],
      },
    });

    const raw = await rawRow("mcp_tool_calls", created.id);
    expect(raw.tool_result).toEqual({ __redacted: "log_content_policy" });
  });
});

// === Internal helpers ===

/** The row as stored, bypassing every read-path transformation. */
async function rawRow(
  table: "interactions" | "mcp_tool_calls",
  id: string,
): Promise<Record<string, unknown>> {
  const result = await db.execute<Record<string, unknown>>(
    sql`SELECT * FROM ${sql.identifier(table)} WHERE id = ${id}::uuid`,
  );
  return result.rows[0];
}
