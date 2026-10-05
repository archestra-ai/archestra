import { vi } from "vitest";
import { betterAuth } from "@/auth";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("MCP alerting beta gate", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    config.mcpServer.alertingEnabled = false;
    vi.spyOn(betterAuth.api, "getSession").mockImplementation(
      async () => ({ user: { id: user.id } }) as never,
    );
    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId, { role: "admin" });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    const [{ default: serverRoutes }, { default: catalogRoutes }] =
      await Promise.all([
        import("./mcp-server"),
        import("./internal-mcp-catalog"),
      ]);
    await app.register(serverRoutes);
    await app.register(catalogRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("hides dismissal APIs and dismissal data while disabled", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const server = await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    const body = {
      issueFingerprint: "v1:failed-to-start:test",
      reason: "Deferred",
    };

    const [serverDismiss, catalogDismiss] = await Promise.all([
      app.inject({
        method: "PUT",
        url: `/api/mcp_server/${server.id}/alert-mutes/failed-to-start`,
        payload: body,
      }),
      app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${catalog.id}/alert-mutes/failed-to-start`,
        payload: body,
      }),
    ]);
    expect(serverDismiss.statusCode).toBe(404);
    expect(catalogDismiss.statusCode).toBe(404);

    const [servers, catalogItems] = await Promise.all([
      app.inject({ method: "GET", url: "/api/mcp_server" }),
      app.inject({ method: "GET", url: "/api/internal_mcp_catalog" }),
    ]);
    expect(
      servers.json().find((row: { id: string }) => row.id === server.id)
        ?.alertMutes,
    ).toEqual([]);
    expect(
      catalogItems.json().find((row: { id: string }) => row.id === catalog.id)
        ?.alertMutes,
    ).toEqual([]);
  });
});
