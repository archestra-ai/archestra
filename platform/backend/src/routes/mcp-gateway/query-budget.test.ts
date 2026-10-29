import { TOOL_SEARCH_TOOLS_FULL_NAME } from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import {
  AgentConnectorAssignmentModel,
  AgentKnowledgeBaseModel,
  TeamModel,
  UserTokenModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";
import mcpGatewayRoutes from "./index";

describe("MCP gateway tools/list query budget", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(mcpGatewayRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("search shares authorization reads within a request and observes revoked team access on the next request", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
    makeAgentTool,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      access: "org",
    });
    await seedAndAssignArchestraTools(agent.id);
    for (let index = 0; index < 3; index++) {
      const catalog = await makeInternalMcpCatalog({
        name: `search-budget-${index}`,
        organizationId: org.id,
        serverType: "remote",
        serverUrl: `https://budget.example/search-${index}`,
        access: { teams: [team.id], level: "use" },
      });
      const server = await makeMcpServer({
        catalogId: catalog.id,
        serverType: "remote",
        scope: "personal",
        ownerId: user.id,
      });
      const tool = await makeTool({
        name: `search-budget-${index}__lookup`,
        catalogId: catalog.id,
      });
      await makeAgentTool(agent.id, tool.id, { mcpServerId: server.id });
    }
    const token = await UserTokenModel.create(user.id, org.id);
    const search = () =>
      app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token.value}`,
        },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: TOOL_SEARCH_TOOLS_FULL_NAME,
            arguments: { query: "search-budget", limit: 20 },
          },
        },
      });
    const { result: response, statements } = await recordQueries(search);
    expect(response.statusCode).toBe(200);
    expect(response.json().result.isError).not.toBe(true);
    expect(
      response
        .json()
        .result.structuredContent.tools.map(
          (tool: { toolName: string }) => tool.toolName,
        ),
    ).toEqual(
      expect.arrayContaining([
        "search-budget-0__lookup",
        "search-budget-2__lookup",
      ]),
    );
    expect(
      statements.filter(
        (query) =>
          query.includes('from "team_member"') ||
          query.includes("subject_teams"),
      ),
    ).toHaveLength(1);

    await TeamModel.removeMember(team.id, user.id);
    const revoked = await search();
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().result.isError).not.toBe(true);
    const revokedNames = revoked
      .json()
      .result.structuredContent.tools.map(
        (tool: { toolName: string }) => tool.toolName,
      );
    for (let index = 0; index < 3; index++) {
      expect(revokedNames).not.toContain(`search-budget-${index}__lookup`);
    }
  });

  test("member tools/list", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
    makeAgentTool,
    makeSkill,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "full",
      access: { teams: [team.id], level: "use" },
    });
    await seedAndAssignArchestraTools(agent.id);
    for (let index = 0; index < 3; index++) {
      const catalog = await makeInternalMcpCatalog({
        name: `budget-${index}`,
        organizationId: org.id,
        serverType: "remote",
        serverUrl: `https://budget.example/catalog-${index}`,
      });
      const server = await makeMcpServer({
        catalogId: catalog.id,
        serverType: "remote",
        scope: "personal",
        ownerId: user.id,
      });
      for (let toolIndex = 0; toolIndex < 2; toolIndex++) {
        const tool = await makeTool({
          name: `budget-${index}__tool-${toolIndex}`,
          catalogId: catalog.id,
        });
        await makeAgentTool(agent.id, tool.id, { mcpServerId: server.id });
      }
    }
    for (let index = 0; index < 2; index++) {
      await makeSkill(org.id, { name: `budget-skill-${index}`, access: "org" });
    }
    const kb = await makeKnowledgeBase(org.id, { access: "org" });
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    await AgentKnowledgeBaseModel.assign(agent.id, kb.id);
    await AgentConnectorAssignmentModel.assign(agent.id, connector.id);
    const token = await UserTokenModel.create(user.id, org.id);

    const list = () =>
      app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token.value}`,
        },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
    expect((await list()).statusCode).toBe(200);
    const { result: response, statements } = await recordQueries(list);
    expect(response.statusCode).toBe(200);
    const names = (response.json().result.tools as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "archestra__query_knowledge_sources",
        "archestra__list_skills",
        "budget-0__tool-0",
        "budget-2__tool-1",
      ]),
    );
    // Was 157 before the caller and agent were resolved once per request.
    // One more: the constant check for tools whose installations describe
    // them differently (per-installation descriptions). Seven fewer since a
    // listing shares caller lookups between authentication and the listing.
    expect(statements.length).toBeLessThanOrEqual(54);
    // Listing several installations must batch catalog metadata and labels,
    // reuse caller teams, and avoid enriching each server with its users.
    expect(
      statements.filter((query) => query.includes('from "mcp_catalog_labels"')),
    ).toHaveLength(1);
    expect(
      statements.filter(
        (query) =>
          query.includes('from "internal_mcp_catalog"') &&
          query.includes('"installation_command"'),
      ),
    ).toHaveLength(1);
    // The caller's team memberships, read once by the combined lookup.
    expect(
      statements.filter(
        (query) =>
          query.includes('from "team_member"') ||
          query.includes("subject_teams"),
      ),
    ).toHaveLength(1);
    expect(
      statements.filter((query) => query.includes('from "mcp_server_user"')),
    ).toHaveLength(0);
    expect(
      statements.filter(
        (query) =>
          query.startsWith("select distinct") &&
          query.includes('from "agent_tools"'),
      ),
    ).toHaveLength(0);

    // A tool call reads its catalog item once, without the labels, teams and
    // authors only catalog pages show. The upstream server is unreachable;
    // everything before the upstream call still runs.
    const call = () =>
      app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token.value}`,
        },
        payload: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "budget-0__tool-0", arguments: {} },
        },
      });
    const { statements: callStatements } = await recordQueries(call);
    expect(
      callStatements.filter(
        (query) =>
          query.includes('from "internal_mcp_catalog"') &&
          query.includes('"installation_command"'),
      ),
    ).toHaveLength(1);
    expect(
      callStatements.filter(
        (query) =>
          query.includes('from "mcp_catalog_labels"') ||
          query.includes('from "user" where "user"."id" = ANY'),
      ),
    ).toHaveLength(0);
  });
});
