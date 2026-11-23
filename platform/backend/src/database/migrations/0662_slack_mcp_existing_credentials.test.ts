import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { expect, test } from "@/test";

const migration = readFileSync(
  new URL("./0662_slack_mcp_existing_credentials.sql", import.meta.url),
  "utf8",
);

test("backfills only existing authorization-code OAuth entries for the official Slack MCP endpoint", async ({
  makeInternalMcpCatalog,
}) => {
  for (const [serverUrl, flag, grantType, expected] of [
    ["https://mcp.slack.com/mcp", undefined, undefined, true],
    ["HTTPS://MCP.SLACK.COM:443/mcp/?x=1", undefined, undefined, true],
    ["https://mcp.slack.com/mcp", false, undefined, false],
    ["https://mcp.slack.com/mcp", undefined, "client_credentials", undefined],
    ["https://mcp.slack.com/mcp/other", undefined, undefined, undefined],
    ["https://mcp.slack.com/MCP", undefined, undefined, undefined],
    ["https://mcp.slack.com:8443/mcp", undefined, undefined, undefined],
    ["https://mcp.slack.com.example.com/mcp", undefined, undefined, undefined],
  ] as const) {
    const oauthConfig = {
      name: "Existing OAuth entry",
      server_url: serverUrl,
      grant_type: grantType,
      client_id: "test-client-id",
      redirect_uris: ["https://archestra.example.com/oauth-callback"],
      scopes: ["read"],
      default_scopes: [],
      supports_resource_metadata: true,
      requires_client_credentials: flag,
    };
    const catalog = await makeInternalMcpCatalog({
      serverType: "remote",
      serverUrl,
      oauthConfig,
    });
    await db.execute(sql.raw(migration));
    const [row] = await db
      .select({ oauthConfig: schema.internalMcpCatalogTable.oauthConfig })
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    expect(row?.oauthConfig, serverUrl).toEqual({
      ...oauthConfig,
      requires_client_credentials: expected,
    });
  }
});
