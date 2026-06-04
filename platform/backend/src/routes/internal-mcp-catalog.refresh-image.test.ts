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

describe("POST /api/internal_mcp_catalog/:id/refresh-image", () => {
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

  test("restarts pods without a pending catalog reinstall", async () => {
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "restartable-pods",
        serverType: "local",
        scope: "org",
        multitenant: true,
        catalogReinstallRequired: false,
        localConfig: {
          dockerImage: "registry.example.com/mcp:latest",
        },
      },
      { organizationId, authorId: user.id },
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${catalog.id}/refresh-image`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(mockReinstallMultitenantCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: catalog.id,
        catalogReinstallRequired: false,
      }),
    );
  });

  test("restarts pods for local catalogs that use the default image", async () => {
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "default-image",
        serverType: "local",
        scope: "org",
        multitenant: true,
        localConfig: {
          command: "node",
          arguments: ["server.js"],
        },
      },
      { organizationId, authorId: user.id },
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${catalog.id}/refresh-image`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(mockReinstallMultitenantCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: catalog.id,
      }),
    );
  });

  test("rejects non-local catalogs", async () => {
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "remote-server",
        serverType: "remote",
        scope: "org",
        serverUrl: "https://example.com/mcp",
      },
      { organizationId, authorId: user.id },
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${catalog.id}/refresh-image`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      "Pod restart is only supported for local catalogs",
    );
    expect(mockReinstallMultitenantCatalog).not.toHaveBeenCalled();
  });
});
