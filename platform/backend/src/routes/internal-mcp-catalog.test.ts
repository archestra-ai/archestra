import {
  ARCHESTRA_MCP_CATALOG_ID,
  TOOL_ARTIFACT_WRITE_FULL_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
} from "@shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";

describe("internal MCP catalog routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(internalMcpCatalogRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("GET /api/internal_mcp_catalog/:id/tools hides implicit Archestra meta tools", async ({
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const agent = await makeAgent();
    await seedAndAssignArchestraTools(agent.id);

    const response = await app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${ARCHESTRA_MCP_CATALOG_ID}/tools`,
    });

    expect(response.statusCode).toBe(200);
    const toolNames = response
      .json()
      .map((tool: { name: string }) => tool.name);
    expect(toolNames).not.toContain(TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME);
    expect(toolNames).not.toContain(TOOL_SEARCH_TOOLS_FULL_NAME);
    expect(toolNames).not.toContain(TOOL_RUN_TOOL_FULL_NAME);
    expect(toolNames).toContain(TOOL_ARTIFACT_WRITE_FULL_NAME);
  });
});
