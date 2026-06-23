import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { type Mock, vi } from "vitest";
import { hasPermission } from "@/auth";
import { InternalMcpCatalogModel } from "@/models";
import { reinstallMultitenantCatalog } from "@/services/mcp-reinstall";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

vi.mock("@/services/mcp-reinstall", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/services/mcp-reinstall")>();
  return {
    ...original,
    reinstallMultitenantCatalog: vi.fn(),
  };
});

const mockHasPermission = hasPermission as Mock;
const mockReinstallMultitenantCatalog = reinstallMultitenantCatalog as Mock;

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

describe("POST /api/internal_mcp_catalog/:id/reinstall", () => {
  let app: FastifyInstance;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeMember, makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    mockReinstallMultitenantCatalog.mockResolvedValue(undefined);

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

  async function makeMultitenantLocalCatalog(
    overrides: { catalogReinstallRequired?: boolean } = {},
  ) {
    return InternalMcpCatalogModel.create(
      {
        name: "multitenant-local-server",
        serverType: "local",
        scope: "org",
        multitenant: true,
        catalogReinstallRequired: overrides.catalogReinstallRequired ?? true,
        localConfig: { dockerImage: "registry.example.com/mcp:latest" },
      },
      { organizationId, authorId: user.id },
    );
  }

  test("reinstalls a multi-tenant local catalog with a pending reinstall", async () => {
    const catalog = await makeMultitenantLocalCatalog();

    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${catalog.id}/reinstall`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(mockReinstallMultitenantCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ id: catalog.id }),
    );
  });

  test("returns 404 when the catalog does not exist", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${UNKNOWN_ID}/reinstall`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe("Catalog item not found");
    expect(mockReinstallMultitenantCatalog).not.toHaveBeenCalled();
  });

  test("rejects catalogs that are not multi-tenant local with 400", async () => {
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "remote-server",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      },
      { organizationId, authorId: user.id },
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${catalog.id}/reinstall`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      "Catalog reinstall is only supported for multi-tenant local catalogs",
    );
    expect(mockReinstallMultitenantCatalog).not.toHaveBeenCalled();
  });

  test("returns 409 when there is no pending reinstall", async () => {
    const catalog = await makeMultitenantLocalCatalog({
      catalogReinstallRequired: false,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${catalog.id}/reinstall`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toBe(
      "Catalog has no pending reinstall",
    );
    expect(mockReinstallMultitenantCatalog).not.toHaveBeenCalled();
  });

  test("rejects non-editors of a shared catalog with 403", async ({
    makeUser,
    makeMember,
  }) => {
    const catalog = await makeMultitenantLocalCatalog();

    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    user = member;
    mockHasPermission.mockResolvedValue({ success: false, error: null });

    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${catalog.id}/reinstall`,
    });

    expect(response.statusCode).toBe(403);
    expect(mockReinstallMultitenantCatalog).not.toHaveBeenCalled();
  });
});
