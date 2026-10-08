import {
  CLAUDE_CODE_CLIENT_ID,
  CODEX_CLIENT_ID,
  CURSOR_CLIENT_ID,
  OPENCODE_CLIENT_ID,
} from "@archestra/shared";
import config from "@/config";
import { ToolModel, ToolObservationModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./openappa-coverage.routes";

/**
 * Detected servers are derived from what the proxy observed clients declare
 * and listed beside the registry's servers. The rules under test: a server is
 * one (client family, label) per organization, shared by every member who
 * connected it and never attributed to anyone; only tools the proxy
 * discovered count, read in the client's own spelling; nothing from another
 * organization, another kind of tool row or an unreadable name leaks in; and
 * one paged list carries registry rows first and detected rows after, with
 * the totals of both.
 */
describe("GET /api/openappa/coverage/entities with detected servers", () => {
  const ctx = useRouteTestApp(routes);

  beforeEach(async ({ makeMember }) => {
    config.openappa.enabled = true;
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  });

  test("groups observed proxy tools by client family and label, shared by every member who declared them", async ({
    makeUser,
    makeMember,
  }) => {
    const colleague = await makeUser();
    await makeMember(colleague.id, ctx.organizationId);
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
    await observe(
      ["mcp__slack__slack_send_message", "Bash"],
      ctx.user.id,
      CLAUDE_CODE_CLIENT_ID,
    );
    await observe(
      ["mcp__slack__slack_list_channels"],
      colleague.id,
      CLAUDE_CODE_CLIENT_ID,
    );
    await observe(
      ["mcp__slack__slack_send_message", "mcp__linear__create_issue"],
      ctx.user.id,
      CODEX_CLIENT_ID,
    );
    await observe(["mcp:github:create_pr"], ctx.user.id, OPENCODE_CLIENT_ID);

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/coverage/entities?type=detected_mcp_server",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pagination.total).toBe(4);
    expect(
      body.data.map(
        (s: {
          id: string;
          type: string;
          name: string;
          clientFamily: string;
          toolCount: number;
        }) => [s.type, s.id, s.name, s.clientFamily, s.toolCount],
      ),
    ).toEqual([
      ["detected_mcp_server", "opencode.github", "github", "opencode", 1, 1],
      ["detected_mcp_server", "codex.linear", "linear", "codex", 1, 1],
      [
        "detected_mcp_server",
        "claude-code.slack",
        "slack",
        "claude-code",
        2,
        2,
      ],
      ["detected_mcp_server", "codex.slack", "slack", "codex", 1, 1],
    ]);
  });

  test("one paged list: registry servers first, detected after, totals of both", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "Acme",
    });
    await makeTool({ catalogId: catalog.id, name: "acme__list" });
    await ToolModel.bulkCreateProxyToolsIfNotExists(
      [proxyTool("mcp__slack__send"), proxyTool("mcp__linear__create")],
      "",
    );
    await observe(
      ["mcp__slack__send", "mcp__linear__create"],
      ctx.user.id,
      CLAUDE_CODE_CLIENT_ID,
    );

    const page = (offset: number) =>
      ctx.app.inject({
        method: "GET",
        url: `/api/openappa/coverage/entities?type=mcp_server&includeDetected=true&limit=2&offset=${offset}`,
      });
    const first = (await page(0)).json();
    const second = (await page(2)).json();

    expect(first.pagination).toMatchObject({ total: 3, totalPages: 2 });
    expect(
      first.data.map((row: { type: string; id: string }) => [row.type, row.id]),
    ).toEqual([
      ["mcp_server", catalog.id],
      ["detected_mcp_server", "claude-code.linear"],
    ]);
    expect(
      second.data.map((row: { type: string; id: string }) => [
        row.type,
        row.id,
      ]),
    ).toEqual([["detected_mcp_server", "claude-code.slack"]]);

    const registryOnly = (
      await ctx.app.inject({
        method: "GET",
        url: "/api/openappa/coverage/entities?type=mcp_server",
      })
    ).json();
    expect(registryOnly.pagination.total).toBe(1);
    expect(registryOnly.data.map((row: { type: string }) => row.type)).toEqual([
      "mcp_server",
    ]);

    const searched = (
      await ctx.app.inject({
        method: "GET",
        url: "/api/openappa/coverage/entities?type=mcp_server&includeDetected=true&search=SLA",
      })
    ).json();
    expect(searched.data.map((row: { id: string }) => row.id)).toEqual([
      "claude-code.slack",
    ]);
  });

  test("a target filter names a registry server, so a detected-only list under one is empty", async () => {
    await ToolModel.bulkCreateProxyToolsIfNotExists(
      [proxyTool("mcp__slack__send")],
      "",
    );
    await observe(["mcp__slack__send"], ctx.user.id, CLAUDE_CODE_CLIENT_ID);

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/openappa/coverage/entities?type=detected_mcp_server&toolId=${crypto.randomUUID()}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [],
      pagination: { total: 0 },
    });
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
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
    });
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
    await observe(["mcp__slack__send"], outsider.id, CLAUDE_CODE_CLIENT_ID);
    await observe(
      [
        "mcp__notion__search",
        "mcp__a__b__c",
        "mcp__bad label__send",
        "slack_send",
      ],
      ctx.user.id,
      CLAUDE_CODE_CLIENT_ID,
    );
    await observe(["slack_send"], ctx.user.id, OPENCODE_CLIENT_ID);
    await observe(["mcp__slack__send"], ctx.user.id, CURSOR_CLIENT_ID);

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/coverage/entities?type=detected_mcp_server",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
  });
});

function proxyTool(name: string) {
  return { name, description: null, parameters: { type: "object" } };
}

function observe(toolNames: string[], userId: string, externalAgentId: string) {
  return ToolObservationModel.recordObservations({
    toolNames,
    userId,
    externalAgentId,
  });
}
