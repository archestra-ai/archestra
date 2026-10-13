import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import {
  AgentConnectorAssignmentModel,
  AgentKnowledgeBaseModel,
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
    expect(statements.length).toBeLessThanOrEqual(60);
  });
});
