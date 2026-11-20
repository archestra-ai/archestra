import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { enterpriseTier } from "@/enterprise-tier";
import { afterEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";

const AWS_IAM_CONFIG = {
  roleArn: "arn:aws:iam::123456789012:role/archestra-agents",
  region: "us-east-1",
  service: "bedrock-agentcore",
};

const OAUTH_CONFIG = {
  name: "oauth",
  server_url: "https://gateway.example.com/mcp",
  client_id: "client",
  redirect_uris: ["https://archestra.example.com/oauth-callback"],
  scopes: [],
  default_scopes: [],
  supports_resource_metadata: false,
};

describe("POST /api/internal_mcp_catalog validation", () => {
  const ctx = useRouteTestApp(internalMcpCatalogRoutes);
  const coreAtStart = config.enterpriseFeatures.core;

  afterEach(() => {
    config.enterpriseFeatures.core = coreAtStart;
  });

  test.for([
    [
      "a non-http server URL",
      { serverType: "remote", serverUrl: "javascript:alert(1)" },
    ],
    [
      "an out-of-range HTTP port",
      {
        serverType: "local",
        localConfig: { command: "node", httpPort: 99999 },
      },
    ],
    [
      "an HTTP path without a leading slash",
      {
        serverType: "local",
        localConfig: { command: "node", httpPath: "mcp" },
      },
    ],
    [
      "an environment variable key with a space",
      {
        serverType: "local",
        localConfig: {
          command: "node",
          environment: [
            { key: "MY VAR", type: "plain_text", promptOnInstallation: false },
          ],
        },
      },
    ],
    [
      "a name longer than 255 characters",
      {
        name: "n".repeat(256),
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
      },
    ],
    [
      "AWS IAM sign-in on a local server",
      {
        serverType: "local",
        localConfig: { command: "node" },
        awsIamConfig: AWS_IAM_CONFIG,
      },
    ],
    [
      "AWS IAM sign-in alongside OAuth",
      {
        serverType: "remote",
        serverUrl: "https://gateway.example.com/mcp",
        awsIamConfig: AWS_IAM_CONFIG,
        oauthConfig: OAUTH_CONFIG,
      },
    ],
    [
      "an AWS IAM role that is not a role ARN",
      {
        serverType: "remote",
        serverUrl: "https://gateway.example.com/mcp",
        awsIamConfig: { ...AWS_IAM_CONFIG, roleArn: "archestra-agents" },
      },
    ],
  ] as const)("rejects %s", async ([, payload], { makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: { name: "invalid-catalog-item", ...payload },
    });

    expect(response.statusCode).toBe(400);
  });

  test("stores AWS IAM sign-in for a remote server", async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "agentcore-gateway",
        serverType: "remote",
        serverUrl: "https://gateway.example.com/mcp",
        awsIamConfig: AWS_IAM_CONFIG,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().awsIamConfig).toEqual(AWS_IAM_CONFIG);
  });

  test("refuses an update that would leave AWS IAM sign-in beside OAuth", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "oauth-gateway",
        serverType: "remote",
        serverUrl: "https://gateway.example.com/mcp",
        oauthConfig: OAUTH_CONFIG,
      },
    });
    expect(created.statusCode, created.body).toBe(200);

    const update = (payload: Record<string, unknown>) =>
      ctx.app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${created.json().id}`,
        payload,
      });

    expect((await update({ awsIamConfig: AWS_IAM_CONFIG })).statusCode).toBe(
      400,
    );
    const switched = await update({
      awsIamConfig: AWS_IAM_CONFIG,
      oauthConfig: null,
    });
    expect(switched.statusCode, switched.body).toBe(200);
    expect((await update({ oauthConfig: OAUTH_CONFIG })).statusCode).toBe(400);
  });

  test("accepts an http(s) remote server", async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "valid-remote-server",
        serverType: "remote",
        serverUrl: "http://localhost:8080/mcp",
      },
    });

    expect(response.statusCode).toBe(200);
  });

  test("accepts a desktop MCP server, which has no URL and no command", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "matlab",
        description: "Runs on the user's own computer",
        serverType: "desktop_mcp",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: "matlab",
      serverType: "desktop_mcp",
      serverUrl: null,
      localConfig: null,
    });
  });

  test("refuses a name another live root server already uses in the same environment", async ({
    makeMember,
  }) => {
    config.enterpriseFeatures.core = true;
    enterpriseTier.setUserCountForTesting(0);
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const existing = await ctx.app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "Weather",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        initialGrants: [
          {
            subject: { type: "organization", id: "*" },
            actions: ["read", "use"],
          },
        ],
      },
    });
    expect(existing.statusCode, existing.body).toBe(200);

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "Weather",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        initialGrants: [
          {
            subject: { type: "organization", id: "*" },
            actions: ["read", "use"],
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.internal_code).toBe("catalog_name_conflict");
    expect(response.json().error.message).toMatch(/environment/i);
    const rows = await db
      .select({ id: schema.internalMcpCatalogTable.id })
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.name, "Weather"));
    expect(rows).toHaveLength(1);
  });
});
