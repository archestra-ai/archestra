import {
  CLAUDE_CODE_CLIENT_ID,
  CODEX_CLIENT_ID,
  CURSOR_CLIENT_ID,
  OPENCODE_CLIENT_ID,
} from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { ToolModel, ToolObservationModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/**
 * Detected servers are derived from what the proxy observed clients declare.
 * The rules under test: a server is one (client family, label) per
 * organization and is shared by every member who connected it; only tools the
 * proxy discovered count, read in the client's own spelling; and nothing from
 * another organization, another kind of tool row, or an unreadable name leaks
 * into the list.
 */
describe("GET /api/mcp_server/detected", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    await makeMember(user.id, organizationId);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });

    const { default: mcpServerRoutes } = await import("./mcp-server");
    await app.register(mcpServerRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("groups observed proxy tools by client family and label, counting distinct observers", async ({
    makeUser,
    makeMember,
  }) => {
    const colleague = await makeUser();
    await makeMember(colleague.id, organizationId);

    await ToolModel.bulkCreateProxyToolsIfNotExists(
      [
        proxyTool("mcp__slack__slack_send_message"),
        proxyTool("mcp__slack__slack_list_channels"),
        proxyTool("mcp__linear__create_issue"),
        proxyTool("mcp:github:create_pr"),
        proxyTool("Bash"),
      ],
      "",
    );
    await ToolObservationModel.recordObservations({
      toolNames: ["mcp__slack__slack_send_message", "Bash"],
      userId: user.id,
      externalAgentId: CLAUDE_CODE_CLIENT_ID,
    });
    await ToolObservationModel.recordObservations({
      toolNames: ["mcp__slack__slack_list_channels"],
      userId: colleague.id,
      externalAgentId: CLAUDE_CODE_CLIENT_ID,
    });
    await ToolObservationModel.recordObservations({
      toolNames: [
        "mcp__slack__slack_send_message",
        "mcp__linear__create_issue",
      ],
      userId: user.id,
      externalAgentId: CODEX_CLIENT_ID,
    });
    await ToolObservationModel.recordObservations({
      toolNames: ["mcp:github:create_pr"],
      userId: user.id,
      externalAgentId: OPENCODE_CLIENT_ID,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/mcp_server/detected",
    });

    expect(response.statusCode).toBe(200);
    const servers = response.json();
    expect(
      servers.map(
        (s: {
          id: string;
          label: string;
          clientFamily: string;
          observerCount: number;
          tools: Array<{ name: string; toolName: string }>;
        }) => ({
          id: s.id,
          label: s.label,
          clientFamily: s.clientFamily,
          observerCount: s.observerCount,
          tools: s.tools.map((t) => [t.name, t.toolName]),
        }),
      ),
    ).toEqual([
      {
        id: "claude-code.slack",
        label: "slack",
        clientFamily: "claude-code",
        observerCount: 2,
        tools: [
          ["mcp__slack__slack_list_channels", "slack_list_channels"],
          ["mcp__slack__slack_send_message", "slack_send_message"],
        ],
      },
      {
        id: "codex.linear",
        label: "linear",
        clientFamily: "codex",
        observerCount: 1,
        tools: [["mcp__linear__create_issue", "create_issue"]],
      },
      {
        id: "codex.slack",
        label: "slack",
        clientFamily: "codex",
        observerCount: 1,
        tools: [["mcp__slack__slack_send_message", "slack_send_message"]],
      },
      {
        id: "opencode.github",
        label: "github",
        clientFamily: "opencode",
        observerCount: 1,
        tools: [["mcp:github:create_pr", "create_pr"]],
      },
    ]);
  });

  test("firstObservedAt is the earliest observation of any of the server's tools", async ({
    makeUser,
    makeMember,
  }) => {
    const colleague = await makeUser();
    await makeMember(colleague.id, organizationId);
    await ToolModel.bulkCreateProxyToolsIfNotExists(
      [proxyTool("mcp__slack__a"), proxyTool("mcp__slack__b")],
      "",
    );
    await ToolObservationModel.recordObservations({
      toolNames: ["mcp__slack__b"],
      userId: user.id,
      externalAgentId: CLAUDE_CODE_CLIENT_ID,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await ToolObservationModel.recordObservations({
      toolNames: ["mcp__slack__a"],
      userId: colleague.id,
      externalAgentId: CLAUDE_CODE_CLIENT_ID,
    });

    const [server] = (
      await app.inject({ method: "GET", url: "/api/mcp_server/detected" })
    ).json();
    const earliest = Math.min(
      ...(
        await ToolObservationModel.listProxyToolObservations(organizationId)
      ).map((row) => row.observedAt.getTime()),
    );
    expect(new Date(server.firstObservedAt).getTime()).toBe(earliest);
  });

  test("leaves out other organizations, catalog tools, unreadable names and unknown clients", async ({
    makeUser,
    makeMember,
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const outsider = await makeUser();
    await makeMember(outsider.id, (await makeOrganization()).id);
    const catalog = await makeInternalMcpCatalog({ organizationId });
    // A catalog tool spelled like a client's local tool is still a catalog tool.
    await makeTool({ catalogId: catalog.id, name: "mcp__notion__search" });
    await ToolModel.bulkCreateProxyToolsIfNotExists(
      [
        proxyTool("mcp__slack__send"),
        proxyTool("mcp__a__b__c"),
        proxyTool("mcp__bad label__send"),
        proxyTool("slack_send"),
      ],
      "",
    );
    await ToolObservationModel.recordObservations({
      toolNames: ["mcp__slack__send"],
      userId: outsider.id,
      externalAgentId: CLAUDE_CODE_CLIENT_ID,
    });
    await ToolObservationModel.recordObservations({
      toolNames: [
        "mcp__notion__search",
        "mcp__a__b__c",
        "mcp__bad label__send",
        "slack_send",
      ],
      userId: user.id,
      externalAgentId: CLAUDE_CODE_CLIENT_ID,
    });
    await ToolObservationModel.recordObservations({
      toolNames: ["slack_send"],
      userId: user.id,
      externalAgentId: OPENCODE_CLIENT_ID,
    });
    await ToolObservationModel.recordObservations({
      toolNames: ["mcp__slack__send"],
      userId: user.id,
      externalAgentId: CURSOR_CLIENT_ID,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/mcp_server/detected",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});

function proxyTool(name: string) {
  return { name, description: null, parameters: { type: "object" } };
}
