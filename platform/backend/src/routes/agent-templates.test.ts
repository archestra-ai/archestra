import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { McpServerModel } from "@/models";
import { ApiError } from "@/types";
import type { User } from "@/types";

const GENERAL_PURPOSE_TEMPLATE_ID = "general-purpose-agent";
const TEMPLATE_WITH_TOOLS_ID = "test-template-with-tools";
const INVALID_TOOLS_TEMPLATE_ID = "test-template-invalid-tools";
const UNKNOWN_SERVER_TEMPLATE_ID = "test-template-unknown-server";
const DEDUP_TOOLS_TEMPLATE_ID = "test-template-dedup-tools";
const MULTI_SERVER_TOOLS_TEMPLATE_ID = "test-template-multi-server-tools";

const templateWithTools = vi.hoisted(() => ({
  // Must not reference non-hoisted variables here (vi.mock is hoisted).
  id: "test-template-with-tools",
  name: "Test Template (tools)",
  description: "Synthetic test template with tool assignments",
  type: "test",
  categories: ["mcp"],
  systemPrompt: "Test prompt",
  llmModel: null,
  tools: ["internal-dev-test-server__print_archestra_test"],
  labels: [],
  icon: null,
}));

const templateWithInvalidTools = vi.hoisted(() => ({
  id: "test-template-invalid-tools",
  name: "Test Template (invalid tools)",
  description: "Synthetic test template with invalid tool full names",
  type: "test",
  categories: ["mcp"],
  systemPrompt: "Test prompt",
  llmModel: null,
  tools: ["this_is_not_a_valid_full_tool_name"],
  labels: [],
  icon: null,
}));

const templateWithUnknownServer = vi.hoisted(() => ({
  id: "test-template-unknown-server",
  name: "Test Template (unknown server)",
  description: "Synthetic test template with tools referencing unknown server",
  type: "test",
  categories: ["mcp"],
  systemPrompt: "Test prompt",
  llmModel: null,
  tools: ["unknown-server__some_tool"],
  labels: [],
  icon: null,
}));

const templateWithDuplicateToolsSameServer = vi.hoisted(() => ({
  id: "test-template-dedup-tools",
  name: "Test Template (dedup tools)",
  description: "Synthetic test template with multiple tools on same server",
  type: "test",
  categories: ["mcp"],
  systemPrompt: "Test prompt",
  llmModel: null,
  tools: [
    "internal-dev-test-server__tool_a",
    "internal-dev-test-server__tool_b",
  ],
  labels: [],
  icon: null,
}));

const templateWithToolsAcrossMultipleServers = vi.hoisted(() => ({
  id: "test-template-multi-server-tools",
  name: "Test Template (multi server tools)",
  description: "Synthetic test template with tools across multiple MCP servers",
  type: "test",
  categories: ["mcp"],
  systemPrompt: "Test prompt",
  llmModel: null,
  tools: ["server-a__tool_a", "server-b__tool_b"],
  labels: [],
  icon: null,
}));

const requirePermissionMock = vi.hoisted(() => vi.fn());

vi.mock("@/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/auth")>();
  return {
    ...actual,
    getAgentTypePermissionChecker: async () => ({
      require: requirePermissionMock,
    }),
  };
});

vi.mock("@shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared")>();

  return {
    ...actual,
    AGENT_TEMPLATES: [
      ...actual.AGENT_TEMPLATES,
      templateWithTools,
      templateWithInvalidTools,
      templateWithUnknownServer,
      templateWithDuplicateToolsSameServer,
      templateWithToolsAcrossMultipleServers,
    ],
    getAgentTemplateById: (id: string) => {
      if (id === TEMPLATE_WITH_TOOLS_ID) return templateWithTools;
      if (id === INVALID_TOOLS_TEMPLATE_ID) return templateWithInvalidTools;
      if (id === UNKNOWN_SERVER_TEMPLATE_ID) return templateWithUnknownServer;
      if (id === DEDUP_TOOLS_TEMPLATE_ID) return templateWithDuplicateToolsSameServer;
      if (id === MULTI_SERVER_TOOLS_TEMPLATE_ID) {
        return templateWithToolsAcrossMultipleServers;
      }
      return actual.getAgentTemplateById(id);
    },
  };
});

describe("agent template routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
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
      ).organizationId = organizationId;
    });

    const { default: agentTemplateRoutes } = await import("./agent-templates");
    await app.register(agentTemplateRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("GET /api/agent_templates returns templates with tools field", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/agent_templates",
    });

    expect(response.statusCode).toBe(200);
    const templates = response.json() as Array<{ id: string; tools: unknown }>;
    expect(Array.isArray(templates)).toBe(true);
    expect(templates.some((t) => t.id === GENERAL_PURPOSE_TEMPLATE_ID)).toBe(
      true,
    );
    for (const t of templates) {
      expect(Array.isArray(t.tools)).toBe(true);
    }
  });

  test("GET /api/agent_templates returns 403 when user lacks agent create permission", async () => {
    requirePermissionMock.mockImplementationOnce(() => {
      throw new ApiError(403, "Forbidden");
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/agent_templates",
    });

    expect(response.statusCode).toBe(403);
  });

  test("GET /api/agent_templates/:id/requirements returns empty when template has no tools", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/agent_templates/${encodeURIComponent(
        GENERAL_PURPOSE_TEMPLATE_ID,
      )}/requirements`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      templateId: string;
      missingCatalogIds: string[];
      missingCatalogs: unknown[];
    };
    expect(body.templateId).toBe(GENERAL_PURPOSE_TEMPLATE_ID);
    expect(body.missingCatalogIds).toEqual([]);
    expect(body.missingCatalogs).toEqual([]);
  });

  test("GET /api/agent_templates/:id/requirements returns 404 for unknown template", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/agent_templates/${encodeURIComponent(
        "does-not-exist-template-id",
      )}/requirements`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("GET /api/agent_templates/:id/requirements returns 403 when user lacks agent create permission", async () => {
    requirePermissionMock.mockImplementationOnce(() => {
      throw new ApiError(403, "Forbidden");
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/agent_templates/${encodeURIComponent(
        GENERAL_PURPOSE_TEMPLATE_ID,
      )}/requirements`,
    });

    expect(response.statusCode).toBe(403);
  });

  test("GET /api/agent_templates/:id/requirements returns catalog IDs for template tools", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "internal-dev-test-server",
      serverType: "local",
      localConfig: {
        command: "sh",
        arguments: ["-c", "echo hi"],
        transportType: "stdio",
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/agent_templates/${encodeURIComponent(
        TEMPLATE_WITH_TOOLS_ID,
      )}/requirements`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      templateId: string;
      missingCatalogIds: string[];
      missingCatalogs: Array<{ catalogId: string; catalogName: string }>;
    };

    expect(body.templateId).toBe(TEMPLATE_WITH_TOOLS_ID);
    expect(body.missingCatalogIds).toContain(catalog.id);
    expect(body.missingCatalogs.map((c) => c.catalogId)).toContain(catalog.id);
    expect(body.missingCatalogs.map((c) => c.catalogName)).toContain(
      "internal-dev-test-server",
    );
  });

  test("GET /api/agent_templates/:id/requirements does not include missing catalogs when server is already accessible", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "internal-dev-test-server",
      serverType: "local",
      localConfig: {
        command: "sh",
        arguments: ["-c", "echo hi"],
        transportType: "stdio",
      },
    });

    vi.spyOn(McpServerModel, "findAll").mockResolvedValueOnce([
      { catalogId: catalog.id } as never,
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/api/agent_templates/${encodeURIComponent(
        TEMPLATE_WITH_TOOLS_ID,
      )}/requirements`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      templateId: string;
      missingCatalogIds: string[];
      missingCatalogs: unknown[];
    };

    expect(body.templateId).toBe(TEMPLATE_WITH_TOOLS_ID);
    expect(body.missingCatalogIds).toEqual([]);
    expect(body.missingCatalogs).toEqual([]);
  });

  test("GET /api/agent_templates/:id/requirements deduplicates catalog IDs when multiple tools use the same server", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "internal-dev-test-server",
      serverType: "local",
      localConfig: {
        command: "sh",
        arguments: ["-c", "echo hi"],
        transportType: "stdio",
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/agent_templates/${encodeURIComponent(
        DEDUP_TOOLS_TEMPLATE_ID,
      )}/requirements`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      templateId: string;
      missingCatalogIds: string[];
    };

    expect(body.templateId).toBe(DEDUP_TOOLS_TEMPLATE_ID);
    expect(body.missingCatalogIds).toEqual([catalog.id]);
  });

  test("GET /api/agent_templates/:id/requirements ignores tools referencing unknown serverName", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/agent_templates/${encodeURIComponent(
        UNKNOWN_SERVER_TEMPLATE_ID,
      )}/requirements`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      templateId: string;
      missingCatalogIds: string[];
      missingCatalogs: unknown[];
    };

    expect(body.templateId).toBe(UNKNOWN_SERVER_TEMPLATE_ID);
    expect(body.missingCatalogIds).toEqual([]);
    expect(body.missingCatalogs).toEqual([]);
  });

  test("GET /api/agent_templates/:id/requirements ignores invalid tool full names", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/agent_templates/${encodeURIComponent(
        INVALID_TOOLS_TEMPLATE_ID,
      )}/requirements`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      templateId: string;
      missingCatalogIds: string[];
      missingCatalogs: unknown[];
    };

    expect(body.templateId).toBe(INVALID_TOOLS_TEMPLATE_ID);
    expect(body.missingCatalogIds).toEqual([]);
    expect(body.missingCatalogs).toEqual([]);
  });

  test("GET /api/agent_templates/:id/requirements supports tools across multiple MCP servers", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalogA = await makeInternalMcpCatalog({
      organizationId,
      name: "server-a",
      serverType: "local",
      localConfig: {
        command: "sh",
        arguments: ["-c", "echo hi"],
        transportType: "stdio",
      },
    });
    const catalogB = await makeInternalMcpCatalog({
      organizationId,
      name: "server-b",
      serverType: "local",
      localConfig: {
        command: "sh",
        arguments: ["-c", "echo hi"],
        transportType: "stdio",
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/agent_templates/${encodeURIComponent(
        MULTI_SERVER_TOOLS_TEMPLATE_ID,
      )}/requirements`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      templateId: string;
      missingCatalogIds: string[];
      missingCatalogs: Array<{ catalogId: string; catalogName: string }>;
    };

    expect(body.templateId).toBe(MULTI_SERVER_TOOLS_TEMPLATE_ID);
    expect(body.missingCatalogIds).toEqual(
      expect.arrayContaining([catalogA.id, catalogB.id]),
    );
    expect(body.missingCatalogIds).toHaveLength(2);
    expect(body.missingCatalogs.map((c) => c.catalogId)).toEqual(
      expect.arrayContaining([catalogA.id, catalogB.id]),
    );
    expect(body.missingCatalogs.map((c) => c.catalogName)).toEqual(
      expect.arrayContaining(["server-a", "server-b"]),
    );
  });
});
