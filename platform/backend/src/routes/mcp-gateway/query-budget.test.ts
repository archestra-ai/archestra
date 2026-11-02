import {
  AGENT_TOOL_PREFIX,
  SKILL_TOOL_PREFIX,
  slugify,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
} from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import {
  AgentConnectorAssignmentModel,
  AgentKnowledgeBaseModel,
  AgentModel,
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

  test("compact gateways skip hidden delegation expansion while search and full mode retain it", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeSkill,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const gateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "search_and_run_only",
    });
    await AgentModel.update(gateway.id, { accessAllSubagents: true });
    const target = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      name: "Discoverable worker",
    });
    const name = `${AGENT_TOOL_PREFIX}${slugify(target.name)}`;
    const skill = await makeSkill(org.id, {
      name: "discoverable-delegated-skill",
      agentName: target.name,
      access: "org",
    });
    const skillName = `${SKILL_TOOL_PREFIX}${slugify(skill.name)}`;
    const token = await UserTokenModel.create(user.id, org.id);
    const request = (method: string, params: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/v1/mcp/${gateway.id}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token.value}`,
        },
        payload: { jsonrpc: "2.0", id: 1, method, params },
      });
    const list = () => request("tools/list", {});
    const expanded = (statements: string[]) =>
      statements.filter(
        (query) =>
          query.includes('from "agents"') && query.includes('"built_in" ='),
      );
    const compact = await recordQueries(list);
    expect(compact.result.statusCode).toBe(200);
    expect(
      compact.result
        .json()
        .result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(
      expect.arrayContaining([
        TOOL_SEARCH_TOOLS_FULL_NAME,
        TOOL_RUN_TOOL_FULL_NAME,
      ]),
    );
    expect(JSON.stringify(compact.result.json().result.tools)).not.toContain(
      name,
    );
    expect(JSON.stringify(compact.result.json().result.tools)).not.toContain(
      skillName,
    );
    expect(expanded(compact.statements)).toHaveLength(0);
    const search = await request("tools/call", {
      name: TOOL_SEARCH_TOOLS_FULL_NAME,
      arguments: { query: target.name },
    });
    expect(search.statusCode).toBe(200);
    expect(JSON.stringify(search.json().result)).toContain(name);
    const skillSearch = await request("tools/call", {
      name: TOOL_SEARCH_TOOLS_FULL_NAME,
      arguments: { query: skill.name },
    });
    expect(skillSearch.statusCode).toBe(200);
    expect(JSON.stringify(skillSearch.json().result)).toContain(skillName);
    await AgentModel.update(gateway.id, { toolExposureMode: "full" });
    const full = await recordQueries(list);
    expect(full.result.statusCode).toBe(200);
    expect(
      full.result
        .json()
        .result.tools.map((tool: { name: string }) => tool.name),
    ).toContain(name);
    expect(
      full.result
        .json()
        .result.tools.map((tool: { name: string }) => tool.name),
    ).toContain(skillName);
    // This guard proves the SQL matcher still recognizes the full-mode scans;
    // the compact zero-query assertion must never pass due to matcher drift.
    expect(expanded(full.statements).length).toBeGreaterThan(0);
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
    // them differently (per-installation descriptions).
    expect(statements.length).toBeLessThanOrEqual(61);
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
    expect(
      statements.filter((query) => query.includes('from "team_member"')),
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
  });
});
