import { ADMIN_ROLE_NAME } from "@archestra/shared";
import EnvironmentModel from "@/models/environment";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("/api/apps/:appId/tools", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          organizationId: string;
          user: User;
        }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: appRoutes } = await import("./app.routes");
    await app.register(appRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("assigns a tool, lists it, then unassigns it", async ({
    makeApp,
    makeTool,
    makeInternalMcpCatalog,
  }) => {
    const created = await makeApp({ organizationId, scope: "org" });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "srv",
      serverUrl: "https://example.com/mcp/",
    });
    const tool = await makeTool({
      name: "srv__do_thing",
      parameters: {},
      catalogId: catalog.id,
    });

    const assigned = await app.inject({
      method: "POST",
      url: `/api/apps/${created.id}/tools/${tool.id}`,
      // Late-bound resolution avoids needing a concrete MCP server install.
      payload: { credentialResolutionMode: "dynamic" },
    });
    expect(assigned.statusCode).toBe(200);

    const tools = await app.inject({
      method: "GET",
      url: `/api/apps/${created.id}/tools`,
    });
    expect(tools.json().map((t: { id: string }) => t.id)).toContain(tool.id);

    const unassigned = await app.inject({
      method: "DELETE",
      url: `/api/apps/${created.id}/tools/${tool.id}`,
    });
    expect(unassigned.statusCode).toBe(200);
  });

  test("assigning a tool from another organization returns 404", async ({
    makeApp,
    makeTool,
    makeInternalMcpCatalog,
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const created = await makeApp({ organizationId, scope: "org" });
    const foreignCatalog = await makeInternalMcpCatalog({
      organizationId: otherOrg.id,
      name: "foreign-srv",
      serverUrl: "https://example.com/mcp/",
    });
    const foreignTool = await makeTool({
      name: "foreign__do_thing",
      parameters: {},
      catalogId: foreignCatalog.id,
    });

    const assigned = await app.inject({
      method: "POST",
      url: `/api/apps/${created.id}/tools/${foreignTool.id}`,
      payload: { credentialResolutionMode: "dynamic" },
    });
    expect(assigned.statusCode).toBe(404);
  });

  test("unassigning a tool that was never assigned returns 404", async ({
    makeApp,
    makeTool,
    makeInternalMcpCatalog,
  }) => {
    const created = await makeApp({ organizationId, scope: "org" });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "srv",
      serverUrl: "https://example.com/mcp/",
    });
    const tool = await makeTool({
      name: "srv__do_thing",
      parameters: {},
      catalogId: catalog.id,
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/apps/${created.id}/tools/${tool.id}`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("a plain member cannot assign a tool to an org-scoped app (403)", async ({
    makeApp,
    makeTool,
    makeInternalMcpCatalog,
    makeUser,
    makeMember,
  }) => {
    const created = await makeApp({ organizationId, scope: "org" });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "srv",
      serverUrl: "https://example.com/mcp/",
    });
    const tool = await makeTool({
      name: "srv__do_thing",
      parameters: {},
      catalogId: catalog.id,
    });
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    user = member;

    const response = await app.inject({
      method: "POST",
      url: `/api/apps/${created.id}/tools/${tool.id}`,
      payload: { credentialResolutionMode: "dynamic" },
    });
    expect(response.statusCode).toBe(403);
  });

  test("assigning a tool outside the app's environment returns 400", async ({
    makeApp,
    makeTool,
    makeInternalMcpCatalog,
  }) => {
    const prod = await EnvironmentModel.create({
      organizationId,
      name: "production",
    });
    const dev = await EnvironmentModel.create({
      organizationId,
      name: "development",
    });
    const created = await makeApp({
      organizationId,
      scope: "org",
      environmentId: prod.id,
    });
    const devCatalog = await makeInternalMcpCatalog({
      organizationId,
      name: "dev-srv",
      serverUrl: "https://example.com/mcp/",
      environmentId: dev.id,
    });
    const devTool = await makeTool({
      name: "dev__do_thing",
      parameters: {},
      catalogId: devCatalog.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/apps/${created.id}/tools/${devTool.id}`,
      payload: { credentialResolutionMode: "dynamic" },
    });
    expect(response.statusCode).toBe(400);
  });

  test("assigning a tool in the app's environment succeeds", async ({
    makeApp,
    makeTool,
    makeInternalMcpCatalog,
  }) => {
    const prod = await EnvironmentModel.create({
      organizationId,
      name: "production",
    });
    const created = await makeApp({
      organizationId,
      scope: "org",
      environmentId: prod.id,
    });
    const prodCatalog = await makeInternalMcpCatalog({
      organizationId,
      name: "prod-srv",
      serverUrl: "https://example.com/mcp/",
      environmentId: prod.id,
    });
    const prodTool = await makeTool({
      name: "prod__do_thing",
      parameters: {},
      catalogId: prodCatalog.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/apps/${created.id}/tools/${prodTool.id}`,
      payload: { credentialResolutionMode: "dynamic" },
    });
    expect(response.statusCode).toBe(200);
  });
});
