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
import { type Mock, vi } from "vitest";
import { hasPermission } from "@/auth";
import { InternalMcpCatalogModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

const mockHasPermission = hasPermission as Mock;

describe("internal MCP catalog routes", () => {
  let app: FastifyInstance;
  let organizationId: string;

  beforeEach(async ({ makeMember, makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    const organization = await makeOrganization();
    organizationId = organization.id;
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError) {
        return reply.status(error.statusCode).send({
          error: { message: error.message, type: error.type },
        });
      }
      const err = error as Error & { statusCode?: number };
      const status = err.statusCode ?? 500;
      return reply.status(status).send({ error: { message: err.message } });
    });
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          user: User;
          organizationId: string;
        }
      ).user = user;
      (
        request as typeof request & {
          user: User;
          organizationId: string;
        }
      ).organizationId = organization.id;
    });
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

  test("DELETE /api/internal_mcp_catalog/by-name/:name is scoped to the active organization", async ({
    makeInternalMcpCatalog,
    makeOrganization,
  }) => {
    const otherOrganization = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({
      name: "other-org-catalog",
      organizationId: otherOrganization.id,
      scope: "org",
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/internal_mcp_catalog/by-name/other-org-catalog",
    });

    expect(response.statusCode).toBe(404);
    await expect(
      InternalMcpCatalogModel.findById(catalog.id),
    ).resolves.not.toBeNull();

    await makeInternalMcpCatalog({
      name: "active-org-catalog",
      organizationId,
      scope: "org",
    });

    const activeOrgResponse = await app.inject({
      method: "DELETE",
      url: "/api/internal_mcp_catalog/by-name/active-org-catalog",
    });

    expect(activeOrgResponse.statusCode).toBe(200);
  });
});
