// biome-ignore-all lint/suspicious/noExplicitAny: test
/**
 * Contract under test: with an organization's "Keep media in logs" off, the
 * default, no image, audio or file bytes reach the LLM or MCP log tables,
 * whoever wrote the row; the text, usage and the media's place stay. Turned
 * on, rows keep their media.
 */
import { MEDIA_NOT_KEPT } from "@archestra/shared";
import { sql } from "drizzle-orm";
import db from "@/database";
import AgentModel from "@/models/agent";
import EnvironmentModel from "@/models/environment";
import InteractionModel from "@/models/interaction";
import McpToolCallModel from "@/models/mcp-tool-call";
import OrganizationModel from "@/models/organization";
import { describe, expect, test } from "@/test";
import type { InteractionRequest, InteractionResponse } from "@/types";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
const WAV = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

/** A chat turn with an attached image and a spoken reply, as Chat sends it. */
const request = {
  model: "gpt-audio",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What is this circle?" },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${PNG}` },
        },
      ],
    },
  ],
} as unknown as InteractionRequest;
const response = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "gpt-audio",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: null,
        audio: { id: "audio_1", data: WAV, transcript: "A blue circle." },
      },
    },
  ],
} as unknown as InteractionResponse;

async function organizationOf(agentId: string) {
  const agent = await AgentModel.findById(agentId);
  if (!agent) throw new Error("agent not found");
  return agent.organizationId;
}

async function setKeepMedia(organizationId: string, keepMediaInLogs: boolean) {
  await OrganizationModel.patch(organizationId, { keepMediaInLogs });
}

describe("LLM interactions", () => {
  test("with media logging off, a row keeps the text and usage and marks where the media was", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    await setKeepMedia(await organizationOf(agent.id), false);

    const created = await InteractionModel.create({
      profileId: agent.id,
      type: "openai:chatCompletions",
      request,
      processedRequest: request,
      response,
      model: "gpt-audio",
      inputTokens: 120,
      outputTokens: 40,
      cost: "0.0012000000",
    });

    const raw = await rawRow("interactions", created.id);
    const stored = JSON.stringify(raw);
    expect(stored).not.toContain(PNG);
    expect(stored).not.toContain(WAV);
    expect(stored).toContain("What is this circle?");
    expect(stored).toContain("A blue circle.");
    expect(raw).toMatchObject({ input_tokens: 120, output_tokens: 40 });
    expect(
      (raw.request as typeof request & { messages: any[] }).messages[0]
        .content[1].image_url.url,
    ).toBe(`data:image/png;${MEDIA_NOT_KEPT},`);
    expect((raw.response as any).choices[0].message.audio.data).toBe(
      MEDIA_NOT_KEPT,
    );
  });

  test("the caller's own request and response objects are left untouched", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    await setKeepMedia(await organizationOf(agent.id), false);
    const ownRequest = structuredClone(request);
    await InteractionModel.create({
      profileId: agent.id,
      type: "openai:chatCompletions",
      request: ownRequest,
      response,
      model: "gpt-audio",
    });
    expect(ownRequest).toEqual(request);
  });

  test("rows without an agent follow their environment's organization", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    await setKeepMedia(organization.id, false);
    const environment = await EnvironmentModel.create({
      organizationId: organization.id,
      name: `media-${crypto.randomUUID().slice(0, 8)}`,
    });
    const created = await InteractionModel.create({
      profileId: null,
      environmentId: environment.id,
      type: "openai:chatCompletions",
      request,
      response,
      model: "gpt-audio",
    });
    expect(
      JSON.stringify(await rawRow("interactions", created.id)),
    ).not.toContain(PNG);
  });

  test("off by default; turned on, the next row keeps its media, and turned off again, the next does not", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const organizationId = await organizationOf(agent.id);
    const write = () =>
      InteractionModel.create({
        profileId: agent.id,
        type: "openai:chatCompletions",
        request,
        response,
        model: "gpt-audio",
      });

    expect(
      JSON.stringify(await rawRow("interactions", (await write()).id)),
    ).not.toContain(PNG);
    await setKeepMedia(organizationId, true);
    expect(
      JSON.stringify(await rawRow("interactions", (await write()).id)),
    ).toContain(PNG);
    await setKeepMedia(organizationId, false);
    expect(
      JSON.stringify(await rawRow("interactions", (await write()).id)),
    ).not.toContain(PNG);
  });
});

describe("MCP tool calls", () => {
  test("with media logging off, a tool's screenshot is not stored, and its text is", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    await setKeepMedia(await organizationOf(agent.id), false);
    const toolResult = {
      isError: false,
      content: [
        { type: "text", text: "Took a screenshot of the page" },
        { type: "image", data: PNG, mimeType: "image/png" },
      ],
    };

    const created = await McpToolCallModel.create({
      agentId: agent.id,
      mcpServerName: "browser",
      method: "tools/call",
      toolCall: {
        id: "call-1",
        name: "browser__screenshot",
        arguments: { reference: `data:image/png;base64,${PNG}` },
      },
      toolResult,
    });

    const raw = await rawRow("mcp_tool_calls", created.id);
    const stored = JSON.stringify(raw);
    expect(stored).not.toContain(PNG);
    expect(stored).toContain("Took a screenshot of the page");
    expect(stored).toContain(MEDIA_NOT_KEPT);
    // The caller still holds the full result to return to the client.
    expect(toolResult.content[1]).toMatchObject({ data: PNG });
    expect(JSON.stringify(created.toolResult)).not.toContain(PNG);
  });

  test("an app's own tool calls follow the app's organization", async ({
    makeApp,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    await setKeepMedia(organization.id, false);
    const app = await makeApp({ organizationId: organization.id });
    const created = await McpToolCallModel.create({
      agentId: null,
      appId: app.id,
      mcpServerName: "app",
      method: "tools/call",
      toolCall: { id: "call-1", name: "app__render", arguments: {} },
      toolResult: {
        isError: false,
        content: [{ type: "image", data: PNG, mimeType: "image/png" }],
      },
    });
    expect(
      JSON.stringify(await rawRow("mcp_tool_calls", created.id)),
    ).not.toContain(PNG);
  });

  test("turned on, a tool's screenshot is stored", async ({ makeAgent }) => {
    const agent = await makeAgent();
    await setKeepMedia(await organizationOf(agent.id), true);
    const created = await McpToolCallModel.create({
      agentId: agent.id,
      mcpServerName: "browser",
      method: "tools/call",
      toolCall: { id: "call-1", name: "browser__screenshot", arguments: {} },
      toolResult: {
        isError: false,
        content: [{ type: "image", data: PNG, mimeType: "image/png" }],
      },
    });
    expect(
      JSON.stringify(await rawRow("mcp_tool_calls", created.id)),
    ).toContain(PNG);
  });
});

async function rawRow(
  table: "interactions" | "mcp_tool_calls",
  id: string,
): Promise<Record<string, unknown>> {
  const result = await db.execute<Record<string, unknown>>(
    sql`SELECT * FROM ${sql.identifier(table)} WHERE id = ${id}::uuid`,
  );
  return result.rows[0];
}
