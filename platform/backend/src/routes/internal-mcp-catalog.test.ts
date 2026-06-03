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
import { secretManager } from "@/secrets-manager";
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

  test("POST /api/internal_mcp_catalog rejects a clonedFrom in another organization", async ({
    makeInternalMcpCatalog,
    makeOrganization,
  }) => {
    const otherOrganization = await makeOrganization();
    const foreignSource = await makeInternalMcpCatalog({
      name: "foreign-clone-source",
      organizationId: otherOrganization.id,
      scope: "org",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "clone-of-foreign",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        clonedFrom: foreignSource.id,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("POST /api/internal_mcp_catalog accepts a clonedFrom in the active organization", async ({
    makeInternalMcpCatalog,
  }) => {
    const source = await makeInternalMcpCatalog({
      name: "same-org-clone-source",
      organizationId,
      scope: "org",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "clone-of-same-org",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        clonedFrom: source.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().clonedFrom).toBe(source.id);
  });

  test("POST /api/internal_mcp_catalog clones source secret bags when clone payload has no secret values", async ({
    makeInternalMcpCatalog,
    makeSecret,
  }) => {
    const clientSecret = await makeSecret({
      name: "source-client-secret",
      secret: { client_secret: "source-client-secret-value" },
    });
    const localConfigSecret = await makeSecret({
      name: "source-local-config-secret",
      secret: { API_KEY: "source-api-key" },
    });
    const presetSecret = await makeSecret({
      name: "source-preset-secret",
      secret: { token: "source-preset-token" },
    });
    const createdSource = await makeInternalMcpCatalog({
      name: "secret-clone-source",
      organizationId,
      scope: "org",
      serverType: "local",
      oauthConfig: {
        name: "secret-clone-source",
        server_url: "https://example.com/mcp",
        client_id: "client-id",
        grant_type: "client_credentials",
        redirect_uris: [],
        scopes: [],
        default_scopes: [],
        supports_resource_metadata: true,
      },
      localConfig: {
        command: "node",
        arguments: [],
        environment: [
          {
            key: "API_KEY",
            type: "secret",
            promptOnInstallation: false,
          },
        ],
      },
    });
    const source = await InternalMcpCatalogModel.update(createdSource.id, {
      clientSecretId: clientSecret.id,
      localConfigSecretId: localConfigSecret.id,
      presetSecretId: presetSecret.id,
    });
    if (!source) {
      throw new Error("Expected source catalog to exist");
    }

    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "secret-clone-target",
        serverType: "local",
        clonedFrom: source.id,
        oauthConfig: {
          name: "secret-clone-target",
          server_url: "https://example.com/mcp",
          client_id: "client-id",
          grant_type: "client_credentials",
          redirect_uris: [],
          scopes: [],
          default_scopes: [],
          supports_resource_metadata: true,
        },
        localConfig: {
          command: "node",
          arguments: [],
          environment: [
            {
              key: "API_KEY",
              type: "secret",
              promptOnInstallation: false,
            },
          ],
        },
        presetFieldValues: {},
      },
    });

    expect(response.statusCode).toBe(200);
    const clone = await InternalMcpCatalogModel.findById(response.json().id, {
      expandSecrets: false,
    });
    expect(clone?.clientSecretId).toBeTruthy();
    expect(clone?.localConfigSecretId).toBeTruthy();
    expect(clone?.presetSecretId).toBeTruthy();
    expect(clone?.clientSecretId).not.toBe(source.clientSecretId);
    expect(clone?.localConfigSecretId).not.toBe(source.localConfigSecretId);
    expect(clone?.presetSecretId).not.toBe(source.presetSecretId);

    await expect(
      secretManager().getSecret(clone?.clientSecretId ?? ""),
    ).resolves.toMatchObject({
      secret: { client_secret: "source-client-secret-value" },
    });
    await expect(
      secretManager().getSecret(clone?.localConfigSecretId ?? ""),
    ).resolves.toMatchObject({
      secret: { API_KEY: "source-api-key" },
    });
    await expect(
      secretManager().getSecret(clone?.presetSecretId ?? ""),
    ).resolves.toMatchObject({
      secret: { token: "source-preset-token" },
    });
  });
});
