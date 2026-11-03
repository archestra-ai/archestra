import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import OrganizationModel from "@/models/organization";
import { deviceMcpService } from "@/services/device-mcp";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import localDeviceRoutes from "../local-device/local-device.routes";
import deviceMcpRoutes from "./device-mcp.routes";

const configuration = {
  protocolVersion: 1 as const,
  version: "1",
  platforms: {
    darwin: { command: "node", args: ["fixture.cjs"] },
    win32: { command: "node.exe", args: ["fixture.cjs"] },
  },
  tools: [{ name: "echo", inputSchema: { type: "object" as const } }],
};
describe("managed personal MCP installations", () => {
  const ctx = useRouteTestApp(async (app) => {
    await app.register(localDeviceRoutes);
    await app.register(deviceMcpRoutes);
  });
  beforeEach(async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    await OrganizationModel.patch(ctx.organizationId, {
      deviceMcpEnabled: true,
    });
  });
  const post = (
    url: string,
    payload: Record<string, unknown>,
    token?: string,
  ) =>
    ctx.app.inject({
      method: "POST",
      url,
      payload,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
  async function computer() {
    const pending = await post("/api/local-devices/enroll", {
      name: "Work computer",
    });
    const credential = await post("/api/local-devices/redeem", {
      code: pending.json().code,
      platform: "darwin",
      arch: "arm64",
      appVersion: "1.0.0",
    });
    expect(credential.statusCode, credential.body).toBe(200);
    return credential.json<{ deviceId: string; token: string }>();
  }
  async function install(catalogId: string, localDeviceId: string) {
    const review = await ctx.app.inject({
      method: "GET",
      url: `/api/device-mcp/review?catalogId=${catalogId}`,
    });
    expect(review.statusCode, review.body).toBe(200);
    const result = await post("/api/device-mcp/install", {
      catalogId,
      localDeviceId,
      configDigest: review.json().configDigest,
    });
    expect(result.statusCode, result.body).toBe(200);
    return result.json<{ id: string }>();
  }
  test("issues only the selected computer's approved manifest and blocks its worker credential after device revocation", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      serverType: "device",
      deviceConfig: configuration,
    });
    const first = await computer();
    const second = await computer();
    const installation = await install(catalog.id, first.deviceId);
    const manifest = await post("/api/local-devices/mcp-sync", {}, first.token);
    expect(manifest.statusCode, manifest.body).toBe(200);
    expect(manifest.json().installations).toHaveLength(1);
    expect(manifest.json().installations[0].id).toBe(installation.id);
    expect(
      (await post("/api/local-devices/mcp-sync", {}, second.token)).json()
        .installations,
    ).toEqual([]);
    const wrong = await post(
      "/api/local-devices/mcp-open",
      {
        id: installation.id,
        configDigest: manifest.json().installations[0].configDigest,
      },
      second.token,
    );
    expect(wrong.statusCode).toBe(404);
    const worker = await post(
      "/api/local-devices/mcp-open",
      {
        id: installation.id,
        configDigest: manifest.json().installations[0].configDigest,
      },
      first.token,
    );
    expect(worker.statusCode, worker.body).toBe(200);
    await ctx.app.inject({
      method: "DELETE",
      url: `/api/local-devices/${first.deviceId}`,
    });
    const session = await post(
      "/api/device-mcp/session",
      { protocolVersion: 1, configDigest: worker.json().configDigest },
      worker.json().token,
    );
    expect(session.statusCode).toBe(409);
  });
  test("another user cannot bind an installation to this person's computer", async ({
    makeInternalMcpCatalog,
    makeUser,
    makeMember,
  }) => {
    const other = await makeUser();
    await makeMember(other.id, ctx.organizationId);
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      authorId: other.id,
      serverType: "device",
      deviceConfig: configuration,
    });
    const target = await computer();
    const review = await deviceMcpService.review({
      catalogId: catalog.id,
      organizationId: ctx.organizationId,
      userId: other.id,
    });
    await expect(
      deviceMcpService.installManaged({
        organizationId: ctx.organizationId,
        userId: other.id,
        catalogId: catalog.id,
        localDeviceId: target.deviceId,
        configDigest: review.configDigest,
        replaceExisting: false,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  test("configuration changes stop delivery until the human reviews a fresh digest", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      serverType: "device",
      deviceConfig: configuration,
    });
    const target = await computer();
    await install(catalog.id, target.deviceId);
    await InternalMcpCatalogModel.update(catalog.id, {
      deviceConfig: { ...configuration, version: "2" },
    });
    const manifest = await post(
      "/api/local-devices/mcp-sync",
      {},
      target.token,
    );
    expect(manifest.statusCode, manifest.body).toBe(200);
    expect(manifest.json().installations).toEqual([]);
  });
});
