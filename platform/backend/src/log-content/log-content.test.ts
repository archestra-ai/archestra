/**
 * Contract under test — with the organization's Log Content setting on
 * "Metadata only", no prompt, response, tool argument or tool result reaches
 * the log tables, while everything usage, cost and the audit trail read from
 * those rows still does.
 */
import {
  isLogContentNotStored,
  MCP_EXECUTED_AS_META_KEY,
  platformExecutedAs,
} from "@archestra/shared";
import { sql } from "drizzle-orm";
import db from "@/database";
import InteractionModel from "@/models/interaction";
import McpToolCallModel from "@/models/mcp-tool-call";
import OrganizationModel from "@/models/organization";
import { describe, expect, test } from "@/test";
import type { InteractionRequest, InteractionResponse } from "@/types";

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
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, { logContentMode: "metadata_only" });
    const agent = await makeAgent({ organizationId: org.id });

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
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, { logContentMode: "metadata_only" });
    const agent = await makeAgent({ organizationId: org.id });

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

  test("knowledge-base calls follow their connector's organization", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, { logContentMode: "metadata_only" });
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    const created = await InteractionModel.create({
      profileId: null,
      connectorId: connector.id,
      type: "anthropic:messages",
      request,
      response,
    });

    expect(
      JSON.stringify(await rawRow("interactions", created.id)),
    ).not.toContain(PRIVATE);
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

  test("a change applies to the very next write", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const write = () =>
      InteractionModel.create({
        profileId: agent.id,
        type: "anthropic:messages",
        request,
        response,
      });

    await OrganizationModel.patch(org.id, { logContentMode: "metadata_only" });
    const withheld = await write();
    await OrganizationModel.patch(org.id, { logContentMode: "full" });
    const stored = await write();

    expect(
      JSON.stringify(await rawRow("interactions", withheld.id)),
    ).not.toContain(PRIVATE);
    expect(JSON.stringify(await rawRow("interactions", stored.id))).toContain(
      PRIVATE,
    );
  });

  test("a row whose organization cannot be resolved stores metadata only", async () => {
    // Fails closed: an owner-less row has no setting to consult.
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
});

describe("MCP tool calls", () => {
  test("Metadata only keeps the tool, status and identity, never arguments or results", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, { logContentMode: "metadata_only" });
    const agent = await makeAgent({ organizationId: org.id });

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

  test("app-owned calls follow the app's organization", async ({
    makeApp,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, { logContentMode: "metadata_only" });
    const app = await makeApp({ organizationId: org.id });

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

  test("discovery results are dropped too", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, { logContentMode: "metadata_only" });
    const agent = await makeAgent({ organizationId: org.id });

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
