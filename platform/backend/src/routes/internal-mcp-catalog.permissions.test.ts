import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
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

vi.mock("@/auth");

const mockHasPermission = hasPermission as Mock;

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000099";

describe("internal MCP catalog built-in protection & ownership gates", () => {
  let app: FastifyInstance;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeMember, makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
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
        request as typeof request & { user: User; organizationId: string }
      ).user = user;
      (
        request as typeof request & { user: User; organizationId: string }
      ).organizationId = organization.id;
    });
    await app.register(internalMcpCatalogRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("PUT rejects a built-in catalog item with 403", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${ARCHESTRA_MCP_CATALOG_ID}`,
      payload: { description: "should not be editable" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toBe(
      "Built-in catalog items cannot be modified",
    );
  });

  test("DELETE rejects a built-in catalog item with 403", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${ARCHESTRA_MCP_CATALOG_ID}`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toBe(
      "Built-in catalog items cannot be deleted",
    );
  });

  test("DELETE returns 404 for an unknown catalog id", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${UNKNOWN_ID}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe("Catalog item not found");
  });

  test("GET returns 404 for an unknown catalog id", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${UNKNOWN_ID}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe("Catalog item not found");
  });

  test("GET tools returns 404 for an unknown non-builtin catalog id", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${UNKNOWN_ID}/tools`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe("Catalog item not found");
  });

  test("DELETE lets a non-admin author remove their own personal item", async ({
    makeUser,
    makeMember,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    const personal = await InternalMcpCatalogModel.create(
      {
        name: "members-personal-server",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "personal",
      },
      { organizationId, authorId: member.id },
    );
    user = member;
    mockHasPermission.mockResolvedValue({ success: false, error: null });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${personal.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    await expect(
      InternalMcpCatalogModel.findById(personal.id),
    ).resolves.toBeNull();
  });

  test("DELETE forbids a non-admin from removing an org-scoped item (403)", async ({
    makeUser,
    makeMember,
  }) => {
    const orgItem = await InternalMcpCatalogModel.create(
      {
        name: "org-shared-server",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      },
      { organizationId, authorId: user.id },
    );

    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    user = member;
    mockHasPermission.mockResolvedValue({ success: false, error: null });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${orgItem.id}`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toBe(
      "You can only delete your own personal catalog items",
    );
    await expect(
      InternalMcpCatalogModel.findById(orgItem.id),
    ).resolves.not.toBeNull();
  });

  test("DELETE forbids an admin of a write-level team, though they may edit (403)", async ({
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const author = await makeUser();
    const teamAdmin = await makeUser();
    await makeMember(teamAdmin.id, organizationId, { role: "member" });
    const team = await makeTeam(organizationId, author.id);
    await makeTeamMember(team.id, teamAdmin.id, { role: "admin" });

    const teamItem = await InternalMcpCatalogModel.create(
      {
        name: "team-write-server",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "team",
        teams: [{ id: team.id, level: "write" }],
      },
      { organizationId, authorId: author.id },
    );

    user = teamAdmin;
    mockHasPermission.mockResolvedValue({ success: false, error: null });

    // The same actor holds write — an edit at the item's scope succeeds.
    const edit = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${teamItem.id}`,
      payload: {
        name: "team-write-server",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        description: "edited by the team admin",
      },
    });
    expect(edit.statusCode).toBe(200);

    // …but write does not confer deletion, which cascades to installs/secrets.
    const del = await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${teamItem.id}`,
    });
    expect(del.statusCode).toBe(403);
    expect(del.json().error.message).toBe(
      "You can only delete your own personal catalog items",
    );
    await expect(
      InternalMcpCatalogModel.findById(teamItem.id),
    ).resolves.not.toBeNull();
  });

  test("DELETE by-name forbids a non-admin from removing an org-scoped item (403)", async ({
    makeUser,
    makeMember,
  }) => {
    await InternalMcpCatalogModel.create(
      {
        name: "org-shared-by-name",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      },
      { organizationId, authorId: user.id },
    );

    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    user = member;
    mockHasPermission.mockResolvedValue({ success: false, error: null });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/internal_mcp_catalog/by-name/org-shared-by-name",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toBe(
      "You can only delete your own personal catalog items",
    );
  });
});
