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
import { McpServerModel, UserTokenModel } from "@/models";
import { secretManager } from "@/secrets-manager";
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

  test.for(
    [
      { method: "resources/list", key: "resources" },
      { method: "resources/templates/list", key: "resourceTemplates" },
      { method: "prompts/list", key: "prompts" },
    ].flatMap((listing) =>
      (["static", "dynamic"] as const).map((mode) => ({ ...listing, mode })),
    ),
  )("$method with $mode credentials batches metadata and lists each upstream once", async ({
    method,
    key,
    mode,
  }, {
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
    makeAgentTool,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const otherUser = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({ organizationId: org.id });
    const token = await UserTokenModel.create(user.id, org.id);
    const listedCatalogs: string[] = [];
    const authorizations: string[] = [];
    const serverIds: string[] = [];
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
            authorizations.push(request.headers.get("authorization") ?? "");
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
      // Another caller's install must not be selected by the batch resolver.
      await makeMcpServer({
        catalogId: catalog.id,
        serverType: "remote",
        scope: "personal",
        ownerId: otherUser.id,
      });
      const secret = await secretManager().createSecret(
        { access_token: `synthetic-listing-${index}` },
        `listing-${index}`,
      );
      const server = await makeMcpServer({
        catalogId: catalog.id,
        serverType: "remote",
        scope: "personal",
        ownerId: user.id,
        secretId: secret.id,
      });
      serverIds.push(server.id);
      for (let toolIndex = 0; toolIndex < 2; toolIndex++) {
        const tool = await makeTool({
          name: `listing-${index}__tool-${toolIndex}`,
          catalogId: catalog.id,
        });
        await makeAgentTool(agent.id, tool.id, {
          mcpServerId: mode === "static" ? server.id : null,
          credentialResolutionMode: mode,
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
    const serverQueries = queries.mock.calls.filter(([sql]) =>
      sql.includes('from "mcp_server"'),
    );
    // One readiness lookup plus at most two listing-wide server lookups.
    expect(serverQueries.length).toBeLessThanOrEqual(3);
    expect(authorizations.sort()).toEqual(
      Array.from(
        { length: 5 },
        (_, index) => `Bearer synthetic-listing-${index}`,
      ),
    );

    const rotated = await secretManager().createSecret(
      { access_token: "synthetic-rotated" },
      "listing-rotated",
    );
    await McpServerModel.update(serverIds[0], { secretId: rotated.id });
    authorizations.length = 0;
    const listAgain = () =>
      app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token.value}`,
        },
        payload: { jsonrpc: "2.0", id: 2, method, params: {} },
      });
    const afterRotation = await listAgain();
    expect(afterRotation.json().result[key]).toHaveLength(5);
    expect(authorizations).toContain("Bearer synthetic-rotated");
    expect(authorizations).not.toContain("Bearer synthetic-listing-0");

    await McpServerModel.delete(serverIds[0]);
    listedCatalogs.length = 0;
    const afterRemoval = await listAgain();
    expect(afterRemoval.json().result[key]).toHaveLength(4);
    expect(listedCatalogs).not.toContain("catalog-0");
  });
});
