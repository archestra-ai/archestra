// Set required env vars BEFORE any module imports so config.ts doesn't throw
process.env.DATABASE_URL = "memory://test";
process.env.ARCHESTRA_AUTH_SECRET = "auth-secret-unit-tests-32-chars!";

import { AGENT_TEMPLATES, ARCHESTRA_MCP_CATALOG_ID } from "@shared";
import { vi } from "vitest";
import { hasPermission } from "@/auth";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

vi.mock("@/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/auth")>();
  return {
    ...actual,
    hasPermission: vi.fn().mockResolvedValue({ success: false }),
  };
});

vi.mock("@shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared")>();
  return {
    ...actual,
    archestraCatalogSdk: {
      ...actual.archestraCatalogSdk,
      getMcpServer: vi.fn().mockResolvedValue({ data: null }),
    },
  };
});

vi.mock("@/observability", () => ({
  initializeObservabilityMetrics: vi.fn(),
  metrics: {
    llm: { initializeMetrics: vi.fn() },
    mcp: { initializeMcpMetrics: vi.fn() },
    agentExecution: { initializeAgentExecutionMetrics: vi.fn() },
  },
}));

vi.mock("@/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/models")>();
  return {
    ...actual,
    InternalMcpCatalogModel: {
      ...actual.InternalMcpCatalogModel,
      create: vi.fn(),
      findByName: vi.fn().mockResolvedValue(null),
      findAll: vi.fn().mockResolvedValue([]),
    },
    ToolModel: {
      ...actual.ToolModel,
      findByCatalogId: vi.fn().mockResolvedValue([]),
    },
    McpServerModel: {
      ...actual.McpServerModel,
      findAll: vi.fn().mockResolvedValue([]),
    },
  };
});

import { archestraCatalogSdk } from "@shared";
import { InternalMcpCatalogModel, McpServerModel, ToolModel } from "@/models";

const hasPermissionMock = vi.mocked(hasPermission);
const getMcpServerMock = vi.mocked(archestraCatalogSdk.getMcpServer);

function mockCodeReviewerDependencies(options?: {
  githubCatalog?: Record<string, unknown> | null;
  slackCatalog?: Record<string, unknown> | null;
  githubTools?: Array<{ id: string; name: string }>;
  slackTools?: Array<{ id: string; name: string }>;
  builtInTools?: Array<{ id: string; name: string }>;
}) {
  const githubCatalog =
    options?.githubCatalog === undefined
      ? {
          id: "github-catalog-id",
          name: "github",
          description: "GitHub tools",
          serverType: "remote",
          oauthConfig: null,
          enterpriseManagedConfig: null,
          userConfig: null,
          localConfig: null,
          authFields: null,
          labels: [],
          teams: [],
        }
      : options.githubCatalog;
  const slackCatalog =
    options?.slackCatalog === undefined
      ? {
          id: "slack-catalog-id",
          name: "slack",
          description: "Slack tools",
          serverType: "remote",
          oauthConfig: null,
          enterpriseManagedConfig: null,
          userConfig: null,
          localConfig: null,
          authFields: null,
          labels: [],
          teams: [],
        }
      : options.slackCatalog;

  vi.mocked(InternalMcpCatalogModel.findByName).mockImplementation(
    async (serverName: string) => {
      if (serverName === "github") {
        return (githubCatalog ?? null) as never;
      }

      if (serverName === "slack") {
        return (slackCatalog ?? null) as never;
      }

      return null as never;
    },
  );
  vi.mocked(InternalMcpCatalogModel.findAll).mockResolvedValue(
    [githubCatalog, slackCatalog].filter(Boolean) as never,
  );

  vi.mocked(ToolModel.findByCatalogId).mockImplementation(
    async (catalogId: string) => {
      if (
        githubCatalog &&
        typeof githubCatalog === "object" &&
        "id" in githubCatalog &&
        catalogId === githubCatalog.id
      ) {
        return (options?.githubTools ?? [
          { id: "tool-issues", name: "github__list_issues" },
          { id: "tool-repos", name: "github__search_repositories" },
        ]) as never;
      }

      if (
        slackCatalog &&
        typeof slackCatalog === "object" &&
        "id" in slackCatalog &&
        catalogId === slackCatalog.id
      ) {
        return (options?.slackTools ?? [
          { id: "tool-slack", name: "slack__send_message" },
        ]) as never;
      }

      if (catalogId === ARCHESTRA_MCP_CATALOG_ID) {
        return (options?.builtInTools ?? [
          {
            id: "tool-knowledge",
            name: "archestra__query_knowledge_sources",
          },
        ]) as never;
      }

      return [] as never;
    },
  );
}

describe("agent template routes", () => {
  let app: ReturnType<typeof createFastifyInstance>;
  let organizationId: string;

  beforeEach(async ({ makeUser, makeOrganization }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    organizationId = org.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: agentTemplateRoutes } = await import("./agent-templates");
    await app.register(agentTemplateRoutes);

    vi.clearAllMocks();
    vi.mocked(McpServerModel.findAll).mockResolvedValue([] as never);
    hasPermissionMock.mockResolvedValue({ success: false } as never);
    vi.mocked(InternalMcpCatalogModel.create).mockReset();
    getMcpServerMock.mockResolvedValue({ data: null } as never);
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /api/agent_templates", () => {
    test("returns the final static catalog contract", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent_templates",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(3);
      expect(body).toEqual(AGENT_TEMPLATES);
      expect(body.map((template: { id: string }) => template.id)).toEqual([
        "ops-engineer",
        "code-reviewer",
        "general-purpose",
      ]);
      for (const template of body as Array<Record<string, unknown>>) {
        expect(Object.keys(template)).toEqual([
          "id",
          "name",
          "description",
          "type",
          "categories",
          "systemPrompt",
          "llmModel",
          "tools",
          "labels",
          "icon",
        ]);
        expect(
          template.llmModel === null || typeof template.llmModel === "string",
        ).toBe(true);
        expect(
          template.icon === null || typeof template.icon === "string",
        ).toBe(true);
      }
    });
  });

  describe("GET /api/agent_templates/:id/requirements", () => {
    test("returns 404 for unknown template id", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent_templates/does-not-exist/requirements",
      });
      expect(response.statusCode).toBe(404);
    });

    test("returns the full requirements contract for a built-in template", async () => {
      vi.mocked(ToolModel.findByCatalogId).mockResolvedValue([
        { id: "tool-1", name: "archestra__list_agents" },
        { id: "tool-2", name: "archestra__get_mcp_servers" },
        { id: "tool-4", name: "archestra__get_limits" },
      ] as never);

      const response = await app.inject({
        method: "GET",
        url: "/api/agent_templates/ops-engineer/requirements",
      });

      expect(response.statusCode).toBe(200);
      expect(ToolModel.findByCatalogId).toHaveBeenCalledWith(
        expect.any(String),
      );
      expect(response.json()).toEqual({
        templateId: "ops-engineer",
        agentConfig: {
          name: "Ops Engineer",
          description: expect.any(String),
          systemPrompt: expect.any(String),
          llmModel: null,
          labels: expect.any(Array),
          agentType: "agent",
          scope: "personal",
          teams: [],
        },
        toolAssignments: [
          {
            toolId: "tool-1",
            catalogId: null,
            requiresUserConfig: false,
          },
          {
            toolId: "tool-2",
            catalogId: null,
            requiresUserConfig: false,
          },
          {
            toolId: "tool-4",
            catalogId: null,
            requiresUserConfig: false,
          },
        ],
        missingCatalogs: [],
        unavailableTools: [],
      });
      expect(ToolModel.findByCatalogId).toHaveBeenCalledTimes(1);
      expect(ToolModel.findByCatalogId).toHaveBeenCalledWith(
        ARCHESTRA_MCP_CATALOG_ID,
      );
    });

    test("only treats current-user-accessible installed servers as already provisioned", async () => {
      hasPermissionMock.mockResolvedValue({ success: false } as never);
      mockCodeReviewerDependencies({
        githubCatalog: {
          id: "github-catalog-id",
          name: "github",
          description: "GitHub tools",
          serverType: "remote",
          oauthConfig: null,
          enterpriseManagedConfig: null,
          userConfig: {
            token: {
              type: "string",
              title: "Token",
              description: "API token",
              required: true,
            },
          },
          localConfig: null,
          authFields: null,
          labels: [],
          teams: [],
        },
      });
      vi.mocked(McpServerModel.findAll).mockResolvedValue([
        {
          id: "server-visible-only-to-someone-else",
          catalogId: "slack-catalog-id",
        },
      ] as never);

      const response = await app.inject({
        method: "GET",
        url: "/api/agent_templates/code-reviewer/requirements",
      });

      expect(response.statusCode).toBe(200);
      expect(McpServerModel.findAll).toHaveBeenCalledWith(
        expect.any(String),
        false,
      );
      expect(response.json().missingCatalogs).toEqual([
        expect.objectContaining({
          catalogId: "github-catalog-id",
        }),
      ]);
    });

    test("resolves external catalogs through the current user's accessible catalog list", async () => {
      mockCodeReviewerDependencies();

      const response = await app.inject({
        method: "GET",
        url: "/api/agent_templates/code-reviewer/requirements",
      });

      expect(response.statusCode).toBe(200);
      expect(InternalMcpCatalogModel.findAll).toHaveBeenCalledWith({
        expandSecrets: false,
        userId: expect.any(String),
        isAdmin: false,
      });
      expect(InternalMcpCatalogModel.findByName).not.toHaveBeenCalled();
    });

    test("does not resolve catalogs from another organization", async () => {
      mockCodeReviewerDependencies({
        githubCatalog: {
          id: "other-org-github-catalog-id",
          name: "github",
          description: "GitHub tools",
          serverType: "remote",
          oauthConfig: null,
          enterpriseManagedConfig: null,
          userConfig: null,
          localConfig: null,
          authFields: null,
          organizationId: "other-organization-id",
          labels: [],
          teams: [],
        },
        slackCatalog: null,
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/agent_templates/code-reviewer/requirements",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        unavailableTools: expect.arrayContaining([
          expect.objectContaining({
            toolName: "github__*",
            reason: "catalog_not_found",
          }),
        ]),
      });
      expect(ToolModel.findByCatalogId).not.toHaveBeenCalledWith(
        "other-org-github-catalog-id",
      );
    });

    test("keeps requirements usable when a catalog cannot be resolved", async () => {
      mockCodeReviewerDependencies({ githubCatalog: null });

      const response = await app.inject({
        method: "GET",
        url: "/api/agent_templates/code-reviewer/requirements",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        templateId: "code-reviewer",
        unavailableTools: expect.arrayContaining([
          expect.objectContaining({
            toolName: "github__*",
            reason: "catalog_not_found",
          }),
        ]),
      });
      expect(response.json().toolAssignments).toEqual([]);
    });

    test("wildcard resolves all tools from an installed catalog", async () => {
      mockCodeReviewerDependencies({
        githubTools: [
          { id: "tool-repos", name: "github__search_repositories" },
          { id: "tool-issues", name: "github__list_issues" },
          { id: "tool-prs", name: "github__list_pull_requests" },
        ],
      });

      vi.mocked(McpServerModel.findAll).mockResolvedValue([
        { id: "server-github", catalogId: "github-catalog-id" },
      ] as never);

      const response = await app.inject({
        method: "GET",
        url: "/api/agent_templates/code-reviewer/requirements",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().toolAssignments).toHaveLength(3);
      expect(response.json().missingCatalogs).toEqual([]);
      expect(response.json().unavailableTools).toEqual([]);
    });

    test("caches catalog lookups per request", async () => {
      mockCodeReviewerDependencies();

      const response = await app.inject({
        method: "GET",
        url: "/api/agent_templates/code-reviewer/requirements",
      });

      expect(response.statusCode).toBe(200);
      expect(InternalMcpCatalogModel.findAll).toHaveBeenCalledTimes(1);
    });

    test("caches tool lookups per request with installed catalogs", async () => {
      mockCodeReviewerDependencies({
        githubTools: [
          { id: "tool-a", name: "github__a" },
          { id: "tool-b", name: "github__b" },
        ],
      });

      vi.mocked(McpServerModel.findAll).mockResolvedValue([
        { id: "server-github", catalogId: "github-catalog-id" },
      ] as never);

      const response = await app.inject({
        method: "GET",
        url: "/api/agent_templates/code-reviewer/requirements",
      });

      expect(response.statusCode).toBe(200);
      expect(InternalMcpCatalogModel.findAll).toHaveBeenCalledTimes(1);
      expect(ToolModel.findByCatalogId).toHaveBeenCalledTimes(1);
      expect(ToolModel.findByCatalogId).toHaveBeenCalledWith(
        "github-catalog-id",
      );
    });

    test("wildcard skips tool resolution until server is installed", async () => {
      mockCodeReviewerDependencies();

      const response = await app.inject({
        method: "GET",
        url: "/api/agent_templates/code-reviewer/requirements",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        templateId: "code-reviewer",
        toolAssignments: [],
        missingCatalogs: expect.arrayContaining([
          expect.objectContaining({
            catalogId: "github-catalog-id",
            catalogName: "github",
            serverType: "remote",
            requiresOauth: false,
            canAutoInstall: true,
          }),
        ]),
        unavailableTools: [],
      });
    });

    test("config form fields exposed for manual installs via wildcard", async () => {
      mockCodeReviewerDependencies({
        githubCatalog: {
          id: "github-catalog-id",
          name: "github",
          description: "GitHub tools",
          serverType: "remote",
          oauthConfig: null,
          enterpriseManagedConfig: null,
          userConfig: {
            token: {
              type: "string",
              title: "Token",
              description: "API token",
              required: true,
            },
          },
          localConfig: null,
          authFields: null,
          labels: [],
          teams: [],
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/agent_templates/code-reviewer/requirements",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        toolAssignments: [],
        missingCatalogs: expect.arrayContaining([
          expect.objectContaining({
            catalogId: "github-catalog-id",
            catalogName: "github",
            canAutoInstall: false,
            userConfigFields: [
              expect.objectContaining({
                key: "token",
                type: "string",
                title: "Token",
              }),
            ],
          }),
        ]),
      });
    });

    test("enterprise managed config prevents auto-install", async () => {
      mockCodeReviewerDependencies({
        githubCatalog: {
          id: "enterprise-catalog-id",
          name: "github",
          description: "GitHub tools",
          serverType: "remote",
          oauthConfig: null,
          enterpriseManagedConfig: { identityProviderId: "idp-1" },
          userConfig: null,
          localConfig: null,
          authFields: null,
          labels: [],
          teams: [],
        },
        slackCatalog: null,
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/agent_templates/code-reviewer/requirements",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        toolAssignments: [],
        missingCatalogs: expect.arrayContaining([
          expect.objectContaining({
            catalogId: "enterprise-catalog-id",
            canAutoInstall: false,
          }),
        ]),
      });
    });

    test("does not persist external catalogs while resolving requirements", async () => {
      getMcpServerMock.mockResolvedValue({
        data: {
          description: "GitHub remote tools",
          instructions: "Install GitHub remote tools",
          server: {
            type: "remote",
            url: "https://example.com/mcp",
            docs_url: "https://example.com/docs",
          },
          user_config: null,
        },
      } as never);

      mockCodeReviewerDependencies({ githubCatalog: null, slackCatalog: null });

      const createSpy = vi.spyOn(InternalMcpCatalogModel, "create");

      const response = await app.inject({
        method: "GET",
        url: "/api/agent_templates/code-reviewer/requirements",
      });

      expect(response.statusCode).toBe(200);
      expect(getMcpServerMock).toHaveBeenCalledWith({
        path: { name: "githubcopilot__remote-mcp" },
      });
      expect(createSpy).not.toHaveBeenCalled();
      expect(response.json()).toMatchObject({
        missingCatalogs: expect.arrayContaining([
          expect.objectContaining({
            catalogName: "github",
            serverType: "remote",
          }),
        ]),
      });
    });

    test("preserves oauth requirements for external catalogs", async () => {
      getMcpServerMock.mockResolvedValue({
        data: {
          description: "GitHub remote tools",
          instructions: "Install GitHub remote tools",
          server: {
            type: "remote",
            url: "https://example.com/mcp",
            docs_url: "https://example.com/docs",
          },
          user_config: null,
          oauth_config: {
            name: "GitHub OAuth",
            server_url: "https://example.com/mcp",
            client_id: "client-id",
            redirect_uris: [],
            scopes: ["repo"],
            default_scopes: ["repo"],
            supports_resource_metadata: false,
          },
        },
      } as never);

      mockCodeReviewerDependencies({ githubCatalog: null, slackCatalog: null });

      const response = await app.inject({
        method: "GET",
        url: "/api/agent_templates/code-reviewer/requirements",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        missingCatalogs: expect.arrayContaining([
          expect.objectContaining({
            catalogName: "github",
            requiresOauth: true,
            canAutoInstall: false,
          }),
        ]),
      });
    });

    test("strips runtime environment values from missing catalog fields", async () => {
      getMcpServerMock.mockResolvedValue({
        data: {
          description: "GitHub local tools",
          instructions: "Install GitHub local tools",
          server: {
            type: "local",
            command: "node",
            args: ["server.js"],
            env: {
              API_TOKEN: "sensitive-token",
            },
          },
          user_config: null,
        },
      } as never);

      mockCodeReviewerDependencies({ githubCatalog: null, slackCatalog: null });

      const response = await app.inject({
        method: "GET",
        url: "/api/agent_templates/code-reviewer/requirements",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        missingCatalogs: expect.arrayContaining([
          expect.objectContaining({
            catalogName: "github",
            environmentFields: [
              expect.objectContaining({
                key: "API_TOKEN",
                promptOnInstallation: true,
              }),
            ],
          }),
        ]),
      });

      const githubCatalog = response
        .json()
        .missingCatalogs.find(
          (catalog: { catalogName: string }) =>
            catalog.catalogName === "github",
        );
      expect(githubCatalog?.environmentFields).toEqual([
        {
          key: "API_TOKEN",
          type: "plain_text",
          promptOnInstallation: true,
        },
      ]);
    });

    test("returns an empty requirements payload for the general-purpose template", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent_templates/general-purpose/requirements",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        templateId: "general-purpose",
        agentConfig: {
          name: "General Purpose",
          description: expect.any(String),
          systemPrompt: expect.any(String),
          llmModel: null,
          labels: [],
          agentType: "agent",
          scope: "personal",
          teams: [],
        },
        toolAssignments: [],
        missingCatalogs: [],
        unavailableTools: [],
      });
    });
  });

  describe("401 — unauthenticated requests", () => {
    test("GET /api/agent_templates requires agent:create permission", async () => {
      const { requiredEndpointPermissionsMap } = await import(
        "@shared/access-control"
      );
      const { RouteId } = await import("@shared");

      const perms = requiredEndpointPermissionsMap[RouteId.GetAgentTemplates];
      expect(perms).toBeDefined();
      expect(perms?.agent).toContain("create");
    });

    test("GET /api/agent_templates/:id/requirements requires agent:create permission", async () => {
      const { requiredEndpointPermissionsMap } = await import(
        "@shared/access-control"
      );
      const { RouteId } = await import("@shared");

      const perms =
        requiredEndpointPermissionsMap[RouteId.GetAgentTemplateRequirements];
      expect(perms).toBeDefined();
      expect(perms?.agent).toContain("create");
    });
  });
});
