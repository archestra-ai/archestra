import { and, eq, sql } from "drizzle-orm";
import { vi } from "vitest";
import { authPlugin } from "@/auth/fastify-plugin";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { AgentModel, AuditLogModel } from "@/models";
import ServiceAccountModel from "@/models/service-account";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import agentRoutes from "./agent";
import appRoutes from "./app/app.routes";
import auditLogRoutes from "./audit-log/audit-log.routes";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";
import knowledgeBaseRoutes from "./knowledge-base";
import knowledgeFileRoutes from "./knowledge-file/knowledge-file.routes";
import llmProviderApiKeyRoutes from "./llm-provider-api-keys";
import pluginRoutes from "./plugin/plugin.routes";
import projectRoutes from "./project/project.routes";
import serviceAccountRoutes from "./service-account";
import skillRoutes from "./skill/skill.routes";
import virtualApiKeyRoutes from "./virtual-api-key/virtual-api-key.routes";

vi.mock("@/observability");
vi.mock("@/config", async () => ({
  ...(await vi.importActual<typeof import("@/config")>("@/config")),
  ...(await (
    await import("@/test/mocks/config")
  ).configModuleMock({ plugins: { enabled: true } })),
}));

describe("Resource creation with service-account authentication", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let serviceAccountId: string;
  let authorization: string;

  beforeEach(async ({ makeOrganization }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url === "http://127.0.0.1:1/v1/models")
          return Response.json({ data: [] });
        throw new Error(`Unexpected network request: ${url}`);
      }),
    );
    const organization = await makeOrganization();
    organizationId = organization.id;
    const account = await ServiceAccountModel.create({
      organizationId,
      name: "Local automation bot",
      role: "admin",
      createdBy: null,
    });
    serviceAccountId = account.id;
    const token = await ServiceAccountModel.createToken({
      serviceAccountId,
      organizationId,
      name: "Agent lifecycle",
    });
    authorization = token.token;
    app = createFastifyInstance();
    await app.register(authPlugin);
    registerAuditLogHook(app);
    await app.register(agentRoutes);
    await app.register(auditLogRoutes);
    await app.register(serviceAccountRoutes);
    await app.register(skillRoutes);
    await app.register(knowledgeBaseRoutes);
    await app.register(internalMcpCatalogRoutes);
    await app.register(knowledgeFileRoutes);
    await app.register(virtualApiKeyRoutes);
    await app.register(llmProviderApiKeyRoutes);
    await app.register(pluginRoutes);
    await app.register(appRoutes);
    await app.register(projectRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("rejects personal project ownership with a clear client error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization },
      payload: { name: "Personal project" },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.message).toBe(
      "Projects require a personal user account.",
    );
  });

  test.each([
    {
      url: "/api/knowledge-directories",
      payload: { name: "Shared notes", visibility: "org-wide" },
    },
    {
      url: "/api/apps",
      payload: { name: "Automation dashboard", scope: "org" },
    },
    {
      url: "/api/plugins",
      payload: {
        displayName: "Automation plugin",
        clientType: "claude-code",
        scope: "org",
        files: [{ path: "README.md", content: "Automation instructions" }],
      },
    },
    {
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "Automation tools",
        serverType: "remote",
        serverUrl: "https://tools.example.invalid/mcp",
        scope: "org",
      },
    },
    {
      url: "/api/llm-virtual-keys",
      payload: { name: "Automation key", scope: "org", keyType: "standard" },
    },
    {
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Local inference",
        provider: "ollama",
        scope: "org",
        baseUrl: "http://127.0.0.1:1",
      },
    },

    {
      url: "/api/skills",
      payload: {
        content:
          "---\nname: automation-guide\ndescription: A shared automation guide.\n---\nUse this guide to prepare a release.",
        scope: "org",
      },
    },
    {
      url: "/api/knowledge-bases",
      payload: { name: "Automation knowledge", visibility: "org-wide" },
    },
    {
      url: "/api/service-accounts",
      payload: { name: "Deployment assistant", role: "member" },
    },
  ])("attributes service-account-created resources at $url", async ({
    url,
    payload,
  }) => {
    let requestPayload: Record<string, unknown> = payload;
    if (url === "/api/llm-virtual-keys") {
      const provider = await app.inject({
        method: "POST",
        url: "/api/llm-provider-api-keys",
        headers: { authorization },
        payload: {
          name: "Local provider",
          provider: "ollama",
          baseUrl: "http://127.0.0.1:1",
          scope: "org",
        },
      });
      expect(provider.statusCode, provider.body).toBe(200);
      requestPayload = {
        ...payload,
        providerApiKeys: [
          { provider: "ollama", providerApiKeyId: provider.json().id },
        ],
      };
    }
    const response = await app.inject({
      method: "POST",
      url,
      headers: { authorization },
      payload: requestPayload,
    });
    expect(response.statusCode, response.body).toBe(200);
    const resource = response.json();
    expect(resource.createdBy).toMatchObject({
      id: `service-account:${serviceAccountId}`,
      name: "Local automation bot",
      type: "service_account",
      email: null,
    });
    if (url !== "/api/knowledge-directories") {
      const read = await app.inject({
        method: "GET",
        url: `${url}/${resource.id}`,
        headers: { authorization },
      });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().createdBy).toEqual(resource.createdBy);
    }
    const list = await app.inject({
      method: "GET",
      url,
      headers: { authorization },
    });
    expect(list.statusCode, list.body).toBe(200);
    const rows = Array.isArray(list.json()) ? list.json() : list.json().data;
    expect(
      rows.find((row: { id: string }) => row.id === resource.id)?.createdBy,
      JSON.stringify(rows),
    ).toEqual(resource.createdBy);
  });

  test("creates a shared agent on a healthy generated-column schema and audits the real actor", async () => {
    const column = await db.execute(sql`
      SELECT is_generated FROM information_schema.columns
      WHERE table_name = 'agents' AND column_name = 'built_in'
    `);
    expect(column.rows).toEqual([{ is_generated: "ALWAYS" }]);

    const list = await app.inject({
      method: "GET",
      url: "/api/agents?limit=1",
      headers: { authorization },
    });
    expect(list.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { authorization },
      payload: {
        name: "Release helper",
        agentType: "agent",
        scope: "org",
        teams: [],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const agent = response.json();
    expect(agent).toMatchObject({
      name: "Release helper",
      organizationId,
      authorId: null,
      scope: "org",
      builtIn: false,
    });
    expect(await AgentModel.findById(agent.id)).toMatchObject({
      authorId: null,
      builtIn: false,
    });

    const read = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}`,
      headers: { authorization },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      id: agent.id,
      authorId: null,
      createdByServiceAccountId: serviceAccountId,
      createdBy: {
        id: `service-account:${serviceAccountId}`,
        type: "service_account",
        name: "Local automation bot",
        email: null,
      },
    });

    await expect
      .poll(async () => {
        return db
          .select()
          .from(schema.auditLogsTable)
          .where(
            and(
              eq(schema.auditLogsTable.resourceId, agent.id),
              eq(schema.auditLogsTable.action, "agent.created"),
            ),
          );
      })
      .toEqual([
        expect.objectContaining({
          actorId: null,
          actorName: "Local automation bot",
          actorEmail: `${serviceAccountId}@service-account.local`,
          actorType: "service_account",
          outcome: "success",
          before: null,
          after: expect.objectContaining({
            name: "Release helper",
            scope: "org",
          }),
        }),
      ]);
  });

  for (const agentType of ["agent", "mcp_gateway"] as const) {
    test(`rejects a foreign organization for ${agentType} creation`, async ({
      makeOrganization,
    }) => {
      const foreignOrganization = await makeOrganization();
      const response = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { authorization },
        payload: {
          name: "Organization boundary probe",
          organizationId: foreignOrganization.id,
          agentType,
          scope: "org",
          teams: [],
        },
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.message).toBe(
        "Cannot create an agent in another organization",
      );
      expect(
        await db
          .select()
          .from(schema.agentsTable)
          .where(eq(schema.agentsTable.name, "Organization boundary probe")),
      ).toHaveLength(0);
    });
  }

  for (const endpoint of ["list", "detail"]) {
    test(`an own-only service account can read its audit ${endpoint} without seeing other actors`, async ({
      makeCustomRole,
      makeOrganization,
    }) => {
      const role = await makeCustomRole(organizationId, {
        role: "automation-audit-reader",
        permission: { agent: ["read", "create", "admin"], auditLog: ["read"] },
      });
      await ServiceAccountModel.update(serviceAccountId, organizationId, {
        role: role.role,
      });
      const ownEvents = [];
      for (const name of ["First audited helper", "Second audited helper"]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/agents",
          headers: { authorization },
          payload: { name, agentType: "agent", scope: "org", teams: [] },
        });
        expect(response.statusCode, response.body).toBe(200);
        const agent = response.json();
        await expect
          .poll(
            async () =>
              (
                await AuditLogModel.findPaginated({
                  organizationId,
                  resourceId: agent.id,
                  limit: 10,
                  offset: 0,
                })
              ).data.length,
          )
          .toBe(1);
        const audit = await AuditLogModel.findPaginated({
          organizationId,
          resourceId: agent.id,
          limit: 10,
          offset: 0,
        });
        ownEvents.push(audit.data[0]);
      }
      const foreignOrganization = await makeOrganization();
      const otherActor = await ServiceAccountModel.create({
        organizationId,
        name: "Other automation bot",
        role: "admin",
        createdBy: null,
      });
      const otherEvents = [];
      for (const override of [
        {
          actorType: "service_account" as const,
          actorEmail: `${otherActor.id}@service-account.local`,
        },
        {
          actorType: "user" as const,
          actorEmail: `${serviceAccountId}@service-account.local`,
        },
        { organizationId: foreignOrganization.id },
      ]) {
        otherEvents.push(
          await AuditLogModel.create({
            organizationId,
            actorId: null,
            actorType: "service_account",
            actorEmail: `${serviceAccountId}@service-account.local`,
            action: "agent.created",
            outcome: "success",
            occurredAt: new Date(),
            ...override,
          }),
        );
      }
      if (endpoint === "detail") {
        for (const event of ownEvents) {
          const response = await app.inject({
            method: "GET",
            url: `/api/audit-logs/${event.id}`,
            headers: { authorization },
          });
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json().id).toBe(event.id);
        }
        for (const event of otherEvents) {
          const response = await app.inject({
            method: "GET",
            url: `/api/audit-logs/${event.id}`,
            headers: { authorization },
          });
          expect(response.statusCode).toBe(404);
        }
        return;
      }
      const first = await app.inject({
        method: "GET",
        url: `/api/audit-logs?limit=1&actorId=service-account:${otherActor.id}`,
        headers: { authorization },
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(
        first.json().data.map((event: { id: string }) => event.id),
      ).toEqual([ownEvents[1].id]);
      expect(first.json().pagination.hasNext).toBe(true);
      const second = await app.inject({
        method: "GET",
        url: `/api/audit-logs?limit=1&cursor=${encodeURIComponent(first.json().pagination.nextCursor)}`,
        headers: { authorization },
      });
      expect(second.statusCode, second.body).toBe(200);
      expect(
        second.json().data.map((event: { id: string }) => event.id),
      ).toEqual([ownEvents[0].id]);
      expect(second.json().pagination.hasNext).toBe(false);
      const wrongType = await app.inject({
        method: "GET",
        url: "/api/audit-logs?actorType=user",
        headers: { authorization },
      });
      expect(wrongType.statusCode).toBe(200);
      expect(wrongType.json().data).toEqual([]);
    });
  }

  test("rejects personal scope rather than creating an ownerless personal agent", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { authorization },
      payload: {
        name: "Personal automation",
        agentType: "agent",
        scope: "personal",
        teams: [],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      "Service accounts cannot create personal agents. Use org or team scope.",
    );
    const agents = await db
      .select()
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.name, "Personal automation"));
    expect(agents).toHaveLength(0);
  });

  test("preserves role restrictions for a service account without org-admin permission", async () => {
    await ServiceAccountModel.update(serviceAccountId, organizationId, {
      role: "member",
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { authorization },
      payload: {
        name: "Restricted automation",
        agentType: "agent",
        scope: "org",
        teams: [],
      },
    });
    expect(response.statusCode).toBe(403);
  });

  test("creates a team-scoped gateway without a synthetic user foreign key", async ({
    makeUser,
    makeTeam,
  }) => {
    const user = await makeUser();
    const team = await makeTeam(organizationId, user.id);
    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { authorization },
      payload: {
        name: "Shared automation gateway",
        agentType: "mcp_gateway",
        scope: "team",
        teams: [team.id],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      authorId: null,
      scope: "team",
      teams: [expect.objectContaining({ id: team.id })],
    });
  });
});
