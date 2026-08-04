import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { InternalMcpCatalogModel } from "@/models";
import { afterEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";

/**
 * Pinning a catalog item's "default credential"
 * (`dynamicConnectionMcpServerId`) decides which connection agents
 * authenticate as at call time. Personal connections are always resolved from
 * the caller and cannot be pinned by any role, including predefined Admin.
 *
 * These use REAL permission resolution (no `@/auth` mock) so the role → action
 * mapping is exercised end to end while the invariant remains role-independent.
 */
describe("PUT /api/internal_mcp_catalog/:id credential pin", () => {
  let app: FastifyInstance;

  async function buildApp(user: User, organizationId: string) {
    const instance = Fastify().withTypeProvider<ZodTypeProvider>();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    instance.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError) {
        return reply
          .status(error.statusCode)
          .send({ error: { message: error.message, type: error.type } });
      }
      const err = error as Error & { statusCode?: number };
      return reply
        .status(err.statusCode ?? 500)
        .send({ error: { message: err.message } });
    });
    instance.addHook("onRequest", async (request) => {
      const r = request as typeof request & {
        user: User;
        organizationId: string;
      };
      r.user = user;
      r.organizationId = organizationId;
    });
    await instance.register(internalMcpCatalogRoutes);
    return instance;
  }

  afterEach(async () => {
    await app?.close();
  });

  test("a member cannot pin another user's personal connection", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    const colleague = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });
    await makeMember(colleague.id, org.id, { role: "member" });

    // Authored by the member, so catalog-modify authorization passes and the
    // credential gate is what the request actually hits.
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: member.id,
      scope: "personal",
    });
    const theirConnection = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: colleague.id,
      serverType: "remote",
    });

    app = await buildApp(member, org.id);
    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { dynamicConnectionMcpServerId: theirConnection.id },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("Personal connections");

    const unchanged = await InternalMcpCatalogModel.findById(catalog.id, {
      userId: member.id,
      isAdmin: true,
      organizationId: org.id,
    });
    expect(unchanged?.dynamicConnectionMcpServerId).toBeNull();
  });

  test("a member cannot pin their own personal connection", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });

    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: member.id,
      scope: "personal",
    });
    const myConnection = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: member.id,
      serverType: "remote",
    });

    app = await buildApp(member, org.id);
    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { dynamicConnectionMcpServerId: myConnection.id },
    });

    expect(response.statusCode).toBe(400);
  });

  test("a predefined Admin cannot pin another user's connection", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    const colleague = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    await makeMember(colleague.id, org.id, { role: "member" });

    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: admin.id,
      scope: "personal",
    });
    const theirConnection = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: colleague.id,
      serverType: "remote",
    });

    app = await buildApp(admin, org.id);
    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { dynamicConnectionMcpServerId: theirConnection.id },
    });

    expect(response.statusCode).toBe(400);
  });

  test("a member can pin an organization service account", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: member.id,
      scope: "personal",
    });
    const serviceAccount = await makeMcpServer({
      catalogId: catalog.id,
      scope: "org",
      ownerId: member.id,
      serverType: "remote",
    });

    app = await buildApp(member, org.id);
    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { dynamicConnectionMcpServerId: serviceAccount.id },
    });

    expect(response.statusCode).toBe(200);
  });
});
