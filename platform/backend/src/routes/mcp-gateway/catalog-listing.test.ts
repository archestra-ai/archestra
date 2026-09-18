import { PGlite } from "@electric-sql/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import mcpClient from "@/clients/mcp-client";
import { TeamTokenModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import mcpGatewayRoutes from "./index";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper, not a React hook
const upstream = useMswServer();

describe("MCP gateway catalog listing", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(mcpGatewayRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await mcpClient.disconnectAll();
    await app.close();
  });

  test.for([
    { method: "resources/list", key: "resources" },
    { method: "resources/templates/list", key: "resourceTemplates" },
    { method: "prompts/list", key: "prompts" },
  ])("$method loads catalog metadata in a batch and lists each upstream once", async ({
    method,
    key,
  }, {
    makeOrganization,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
    makeAgentTool,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Listing token",
      teamId: null,
      isOrganizationToken: true,
    });
    const listedCatalogs: string[] = [];
    upstream.use(
      http.get(
        "https://listing.example/:catalog",
        () => new HttpResponse(null, { status: 405 }),
      ),
      http.post(
        "https://listing.example/:catalog",
        async ({ request, params }) => {
          const body = (await request.json()) as {
            id?: number;
            method: string;
          };
          if (body.id === undefined)
            return new HttpResponse(null, { status: 202 });
          let result: Record<string, unknown> = {};
          if (body.method === "initialize") {
            result = {
              protocolVersion: "2025-03-26",
              capabilities: { resources: {}, prompts: {} },
              serverInfo: { name: "synthetic-listing", version: "1.0.0" },
            };
          } else if (body.method === method) {
            const name = String(params.catalog);
            listedCatalogs.push(name);
            result = {
              [key]: [
                {
                  name,
                  uri: `resource://${name}`,
                  uriTemplate: `resource://${name}/{id}`,
                },
              ],
            };
          }
          return HttpResponse.json({ jsonrpc: "2.0", id: body.id, result });
        },
      ),
    );

    for (let index = 0; index < 5; index++) {
      const catalog = await makeInternalMcpCatalog({
        name: `listing-${index}`,
        organizationId: org.id,
        serverType: "remote",
        serverUrl: `https://listing.example/catalog-${index}`,
      });
      const server = await makeMcpServer({
        catalogId: catalog.id,
        serverType: "remote",
        scope: "org",
      });
      for (let toolIndex = 0; toolIndex < 2; toolIndex++) {
        const tool = await makeTool({
          name: `listing-${index}__tool-${toolIndex}`,
          catalogId: catalog.id,
        });
        await makeAgentTool(agent.id, tool.id, {
          mcpServerId: server.id,
          credentialResolutionMode: "static",
        });
      }
    }

    // Observe the real database boundary; all queries still execute.
    const queries = vi.spyOn(PGlite.prototype, "query");
    queries.mockClear();
    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.value}`,
      },
      payload: { jsonrpc: "2.0", id: 1, method, params: {} },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result[key]).toHaveLength(5);
    expect(listedCatalogs.sort()).toEqual([
      "catalog-0",
      "catalog-1",
      "catalog-2",
      "catalog-3",
      "catalog-4",
    ]);
    const labelQueries = queries.mock.calls.filter(([sql]) =>
      sql.includes('from "mcp_catalog_labels"'),
    );
    expect(labelQueries).toHaveLength(1);
  });
});
