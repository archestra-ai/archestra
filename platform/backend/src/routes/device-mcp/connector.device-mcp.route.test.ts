import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config from "@/config";
import OrganizationModel from "@/models/organization";
import { connectorIdentity } from "@/services/device-mcp-connectors";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import deviceMcpRoutes from "./device-mcp.routes";

describe("device connector delivery", () => {
  const ctx = useRouteTestApp(deviceMcpRoutes);
  let directory: string;
  const previousDirectory = config.deviceMcp.connectorDirectory;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "device-connector-route-"));
    config.deviceMcp.connectorDirectory = directory;
    const bytes = Buffer.from("synthetic connector archive");
    const identity = connectorIdentity("Archestra", {
      platform: "darwin",
      arch: "arm64",
    });
    if (!identity) throw new Error("Invalid fixture identity");
    const manifest = {
      version: "1.0.0",
      platform: "darwin",
      arch: "arm64",
      ...identity,
      protocol: "archestra-device",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      signed: true,
      verification: { mac: { developerId: true, notarized: true } },
    };
    await writeFile(join(directory, manifest.filename), bytes);
    await writeFile(
      join(directory, "darwin-arm64.json"),
      JSON.stringify(manifest),
    );
  });
  afterEach(async () => {
    config.deviceMcp.connectorDirectory = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  });

  test("blocks both artifact discovery and download when organization opt-in is off", async () => {
    for (const url of [
      "/api/device-mcp/connectors",
      "/api/device-mcp/connector?platform=darwin&arch=arm64",
    ]) {
      const response = await ctx.app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(403);
    }
  });

  test("resolves the current organization brand and refuses caller-supplied branding", async () => {
    await OrganizationModel.patch(ctx.organizationId, {
      deviceMcpEnabled: true,
      appName: "Équipe 智能",
    });
    const list = () =>
      ctx.app.inject({ method: "GET", url: "/api/device-mcp/connectors" });
    expect((await list()).json()).toEqual([]);
    const identity = connectorIdentity("Équipe 智能", {
      platform: "darwin",
      arch: "arm64",
    });
    if (!identity) throw new Error("Invalid fixture identity");
    const bytes = Buffer.from("synthetic white-label release");
    await writeFile(join(directory, identity.filename), bytes);
    await writeFile(
      join(directory, "darwin-arm64.json"),
      JSON.stringify({
        ...identity,
        version: "1.0.0",
        platform: "darwin",
        arch: "arm64",
        protocol: "archestra-device",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        signed: true,
        verification: { mac: { developerId: true, notarized: true } },
      }),
    );
    expect((await list()).json()).toMatchObject([
      { appName: "Équipe 智能", productName: "Équipe 智能 Desktop" },
    ]);
    const download = await ctx.app.inject({
      method: "GET",
      url: "/api/device-mcp/connector?platform=darwin&arch=arm64",
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain(
      "filename*=UTF-8''%C3%89quipe%20%E6%99%BA%E8%83%BD%20Desktop",
    );
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: "/api/device-mcp/connector?platform=darwin&arch=arm64&appName=Archestra",
        })
      ).statusCode,
    ).toBe(400);
  });

  test("removes formerly offered packages as soon as release verification is missing", async () => {
    await OrganizationModel.patch(ctx.organizationId, {
      deviceMcpEnabled: true,
    });
    const path = join(directory, "darwin-arm64.json");
    const identity = connectorIdentity("Archestra", {
      platform: "darwin",
      arch: "arm64",
    });
    const bytes = Buffer.from("unsigned archive");
    await writeFile(
      path,
      JSON.stringify({
        ...identity,
        version: "1.0.0",
        platform: "darwin",
        arch: "arm64",
        protocol: "archestra-device",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        signed: false,
      }),
    );
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: "/api/device-mcp/connectors",
        })
      ).json(),
    ).toEqual([]);
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: "/api/device-mcp/connector?platform=darwin&arch=arm64",
        })
      ).statusCode,
    ).toBe(404);
  });

  test("delivers only available, verified targets after opt-in", async () => {
    await OrganizationModel.patch(ctx.organizationId, {
      deviceMcpEnabled: true,
    });
    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/device-mcp/connectors",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject([
      {
        platform: "darwin",
        arch: "arm64",
        signed: true,
        appName: "Archestra",
        productName: "Archestra Desktop",
      },
    ]);
    const download = await ctx.app.inject({
      method: "GET",
      url: "/api/device-mcp/connector?platform=darwin&arch=arm64",
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("application/zip");
    expect(download.headers["content-disposition"]).toContain(
      `filename="${connectorIdentity("Archestra", { platform: "darwin", arch: "arm64" })?.filename}"`,
    );
    expect(download.body).toBe("synthetic connector archive");
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: "/api/device-mcp/connector?platform=win32&arch=x64",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: "/api/device-mcp/connector?platform=../outside&arch=x64",
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe("local preview request gate", () => {
  const ctx = useRouteTestApp(deviceMcpRoutes);
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "desktop-local-preview-"));
    config.deviceMcp.connectorDirectory = undefined;
    config.deviceMcp.developmentConnectorDirectory = directory;
    config.deviceMcp.developmentEnabled = true;
    config.frontendBaseUrl = "http://localhost:13500";
    await OrganizationModel.patch(ctx.organizationId, {
      deviceMcpEnabled: true,
    });
    const identity = connectorIdentity("Archestra", {
      platform: "darwin",
      arch: "arm64",
    });
    if (!identity) throw new Error("Expected fixture brand");
    const bytes = Buffer.from("synthetic ad-hoc integrity-attested preview");
    await writeFile(join(directory, identity.filename), bytes);
    await writeFile(
      join(directory, "darwin-arm64.json"),
      JSON.stringify({
        ...identity,
        version: "1.0.0",
        platform: "darwin",
        arch: "arm64",
        protocol: "archestra-device",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        signed: false,
        development: true,
        verification: {
          mac: { adHocIntegrity: true, developerId: false, notarized: false },
        },
      }),
    );
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  test("lists and downloads the explicitly configured local preview without representing Apple trust", async () => {
    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/device-mcp/connectors",
      remoteAddress: "127.0.0.1",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject([
      {
        signed: false,
        development: true,
        verification: {
          mac: { adHocIntegrity: true, developerId: false, notarized: false },
        },
      },
    ]);
    const download = await ctx.app.inject({
      method: "GET",
      url: "/api/device-mcp/connector?platform=darwin&arch=arm64",
      remoteAddress: "127.0.0.1",
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("synthetic ad-hoc integrity-attested preview");
  });
  test("a spoofed Origin or X-Forwarded-For cannot enable preview remotely or in production", async () => {
    for (const production of [false, true]) {
      config.deviceMcp.developmentEnabled = !production;
      const request = {
        method: "GET" as const,
        remoteAddress: production ? "127.0.0.1" : "203.0.113.5",
        headers: {
          origin: "http://localhost:13500",
          "x-forwarded-for": "127.0.0.1",
          host: "localhost:19500",
        },
      };
      expect(
        (
          await ctx.app.inject({
            ...request,
            url: "/api/device-mcp/connectors",
          })
        ).json(),
      ).toEqual([]);
      expect(
        (
          await ctx.app.inject({
            ...request,
            url: "/api/device-mcp/connector?platform=darwin&arch=arm64",
          })
        ).statusCode,
      ).toBe(404);
    }
  });
  test("query parameters cannot select a preview mode or artifact directory", async () => {
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          remoteAddress: "127.0.0.1",
          url: "/api/device-mcp/connector?platform=darwin&arch=arm64&development=true&directory=/tmp",
        })
      ).statusCode,
    ).toBe(400);
  });
});
