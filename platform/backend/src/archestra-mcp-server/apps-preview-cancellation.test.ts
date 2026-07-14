import {
  ADMIN_ROLE_NAME,
  getArchestraToolFullName,
  TOOL_PREVIEW_APP_TOOL_SHORT_NAME,
  TOOL_SCAFFOLD_APP_SHORT_NAME,
} from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { afterEach } from "vitest";
import mcpClient from "@/clients/mcp-client";
import { InternalMcpCatalogModel, McpServerModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { executeArchestraTool } from ".";
import { isAbortLikeError } from "./helpers";
import type { ArchestraContext } from "./types";

const MCP_URL = "https://preview.example.com/mcp";
const CATALOG_NAME = "preview-server";
const TOOL_NAME = `${CATALOG_NAME}__search`;

describe("preview_app_tool cancellation", () => {
  const msw = useMswServer();
  let appId: string;
  let context: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeMember, makeTool }) => {
    const agent = await makeAgent({
      name: "Preview Agent",
      accessAllTools: true,
    });
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    context = {
      agent: { id: agent.id, name: agent.name },
      organizationId: agent.organizationId,
      userId: user.id,
      approvalRequiredPoliciesHandled: true,
    };

    const catalog = await InternalMcpCatalogModel.create(
      {
        name: CATALOG_NAME,
        serverType: "remote",
        serverUrl: MCP_URL,
        scope: "org",
      },
      { organizationId: agent.organizationId },
    );
    await McpServerModel.create({
      name: CATALOG_NAME,
      catalogId: catalog.id,
      serverType: "remote",
      scope: "org",
    });
    await makeTool({ name: TOOL_NAME, catalogId: catalog.id });

    const created = await executeArchestraTool(
      getArchestraToolFullName(TOOL_SCAFFOLD_APP_SHORT_NAME),
      { name: "Preview App", tools: [TOOL_NAME] },
      context,
    );
    expect(created).toEqual(
      expect.objectContaining({
        isError: false,
        structuredContent: expect.any(Object),
      }),
    );
    appId = (created.structuredContent as { id: string }).id;
  });

  afterEach(async () => {
    await mcpClient.disconnectAll();
  });

  test("stops an in-flight upstream call when the context is aborted", async () => {
    let releaseToolCall: (() => void) | undefined;
    let markToolCallStarted: (() => void) | undefined;
    const toolCallStarted = new Promise<void>((resolve) => {
      markToolCallStarted = resolve;
    });

    msw.use(
      http.get(MCP_URL, () => new HttpResponse(null, { status: 405 })),
      http.delete(MCP_URL, () => new HttpResponse(null, { status: 202 })),
      http.post(MCP_URL, async ({ request }) => {
        const message = (await request.json()) as {
          id?: string | number;
          method: string;
        };
        const response = (result: unknown) =>
          HttpResponse.json({ jsonrpc: "2.0", id: message.id, result });

        switch (message.method) {
          case "initialize":
            return response({
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: CATALOG_NAME, version: "1.0.0" },
            });
          case "notifications/initialized":
            return new HttpResponse(null, { status: 202 });
          case "tools/list":
            return response({
              tools: [
                {
                  name: "search",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            });
          case "tools/call":
            markToolCallStarted?.();
            await new Promise<void>((resolve) => {
              releaseToolCall = resolve;
            });
            return response({
              content: [{ type: "text", text: "completed" }],
            });
          default:
            return HttpResponse.json(
              {
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32601, message: "Method not found" },
              },
              { status: 404 },
            );
        }
      }),
    );

    const controller = new AbortController();
    const outcome = executeArchestraTool(
      getArchestraToolFullName(TOOL_PREVIEW_APP_TOOL_SHORT_NAME),
      { appId, toolName: TOOL_NAME, args: {} },
      { ...context, abortSignal: controller.signal },
    ).then(
      () => "resolved" as const,
      (error: unknown) => error,
    );

    await toolCallStarted;
    controller.abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      outcome,
      new Promise<"pending">((resolve) => {
        timeout = setTimeout(() => resolve("pending"), 1_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    releaseToolCall?.();
    await outcome;

    expect(isAbortLikeError(settled)).toBe(true);
  });
});
