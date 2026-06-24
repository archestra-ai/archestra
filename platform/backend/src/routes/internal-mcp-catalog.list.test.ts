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

describe("GET /api/internal_mcp_catalog", () => {
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

  test("an admin sees another member's personal catalog item", async ({
    makeUser,
    makeMember,
  }) => {
    const author = await makeUser();
    await makeMember(author.id, organizationId, { role: "member" });
    const personal = await InternalMcpCatalogModel.create(
      {
        name: "authors-personal-server",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "personal",
      },
      { organizationId, authorId: author.id },
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/internal_mcp_catalog",
    });

    expect(response.statusCode).toBe(200);
    const ids = response.json().map((item: { id: string }) => item.id);
    expect(ids).toContain(personal.id);
  });

  test("a non-admin does not see another member's personal catalog item", async ({
    makeUser,
    makeMember,
  }) => {
    const author = await makeUser();
    await makeMember(author.id, organizationId, { role: "member" });
    const personal = await InternalMcpCatalogModel.create(
      {
        name: "hidden-personal-server",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "personal",
      },
      { organizationId, authorId: author.id },
    );

    // Act as a different non-admin member: hasPermission resolves the admin
    // probe to false, so findAll is scoped to the caller's accessible items.
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    user = member;
    mockHasPermission.mockResolvedValue({ success: false, error: null });

    const response = await app.inject({
      method: "GET",
      url: "/api/internal_mcp_catalog",
    });

    expect(response.statusCode).toBe(200);
    const ids = response.json().map((item: { id: string }) => item.id);
    expect(ids).not.toContain(personal.id);
  });
});
