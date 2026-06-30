import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { type Mock, vi } from "vitest";
import { hasPermission } from "@/auth";
import { InternalMcpCatalogModel, OrganizationModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";

// hasPermission is mocked success so any incidental check passes; the catalog
// scope gate uses getPermissionsForUserContext (the REAL member role), so this
// verifies the handler restricts a member to their own personal items even with
// the route-level `mcpRegistry:update` grant.
vi.mock("@/auth", () => ({ hasPermission: vi.fn() }));
const mockHasPermission = hasPermission as Mock;

describe("member catalog update is limited to own personal items", () => {
  let app: FastifyInstance;
  let organizationId: string;
  let member: User;

  beforeEach(async ({ makeMember, makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    const organization = await makeOrganization();
    organizationId = organization.id;
    member = await makeUser();
    await makeMember(member.id, organization.id, { role: "member" });

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
      return reply.status(err.statusCode ?? 500).send({
        error: { message: err.message },
      });
    });
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { user: User; organizationId: string }
      ).user = member;
      (
        request as typeof request & { user: User; organizationId: string }
      ).organizationId = organization.id;
    });
    await app.register(internalMcpCatalogRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  function makeRemoteCatalog(scope: "personal" | "org", authorId: string) {
    return InternalMcpCatalogModel.create(
      {
        name: `cat-${crypto.randomUUID().slice(0, 8)}`,
        serverType: "remote",
        serverUrl: "https://example.com/mcp/",
        scope,
      },
      { organizationId, authorId },
    );
  }

  test("member can update their OWN personal catalog item", async () => {
    const catalog = await makeRemoteCatalog("personal", member.id);
    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { description: "updated by owner" },
    });
    expect(response.statusCode).toBe(200);
  });

  test("member CANNOT update an org-scoped catalog item", async () => {
    const catalog = await makeRemoteCatalog("org", member.id);
    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { description: "should be blocked" },
    });
    expect(response.statusCode).toBe(403);
  });

  test("member CANNOT update another user's personal catalog item", async ({
    makeUser,
  }) => {
    const other = await makeUser();
    const catalog = await makeRemoteCatalog("personal", other.id);
    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { description: "should be blocked" },
    });
    // Another user's personal item isn't even visible to the member, so the
    // scoped lookup 404s before the modify check — still blocked, just unseen.
    expect(response.statusCode).toBe(404);
  });

  test("a member swapping their own image to an untrusted one holds it for approval", async () => {
    await OrganizationModel.patch(organizationId, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: `local-${crypto.randomUUID().slice(0, 8)}`,
        serverType: "local",
        scope: "personal",
        localConfig: { dockerImage: "ghcr.io/acme/ok:1" },
      },
      { organizationId, authorId: member.id },
    );

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { localConfig: { dockerImage: "ghcr.io/evil/x:1" } },
    });

    expect(response.statusCode).toBe(200);
    const after = await InternalMcpCatalogModel.findById(catalog.id);
    expect(after?.catalogItemApprovalStatus).toBe("pending");
  });
});
