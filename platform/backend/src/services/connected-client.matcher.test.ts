import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import db from "@/database";
import {
  connectClientForOAuthClientSql,
  isOAuthClientForConnectClient,
} from "./connected-client-oauth";

describe("isOAuthClientForConnectClient", () => {
  const claudeCode = {
    clientId: "https://claude.ai/oauth/claude-code-client-metadata",
    name: "Claude Code",
    redirectUris: ["http://localhost/callback"],
  };
  const other = {
    clientId: "dcr-client-1",
    name: "Claude Code",
    redirectUris: ["http://localhost/callback"],
  };

  test("matches Claude Code only by its CIMD client_id", () => {
    expect(isOAuthClientForConnectClient("claude-code", claudeCode)).toBe(true);
    // A DCR client that merely calls itself Claude Code is not trusted.
    expect(isOAuthClientForConnectClient("claude-code", other)).toBe(false);
  });

  test("an agent never matches another agent's sign-in", () => {
    expect(isOAuthClientForConnectClient("cursor", claudeCode)).toBe(false);
    expect(isOAuthClientForConnectClient("claude-desktop", claudeCode)).toBe(
      false,
    );
    expect(isOAuthClientForConnectClient("generic", claudeCode)).toBe(false);
  });

  test("matches Amp by its client name and fixed loopback redirect", () => {
    const amp = {
      clientId: "dcr-amp",
      name: "Amp MCP Client (archestra)",
      redirectUris: ["http://localhost:41592/oauth/callback"],
    };
    expect(isOAuthClientForConnectClient("amp", amp)).toBe(true);
    expect(
      isOAuthClientForConnectClient("amp", {
        ...amp,
        redirectUris: ["http://localhost:1234/callback"],
      }),
    ).toBe(false);
    expect(isOAuthClientForConnectClient("amp", { ...amp, name: "Amp" })).toBe(
      false,
    );
  });

  test("matches Droid only by its CIMD client_id", () => {
    const droid = {
      clientId: "https://api.factory.ai/mcp/oauth-client",
      name: "Factory Droid",
      redirectUris: ["http://127.0.0.1/callback"],
    };
    expect(isOAuthClientForConnectClient("droid", droid)).toBe(true);
    expect(
      isOAuthClientForConnectClient("droid", { ...droid, clientId: "dcr-1" }),
    ).toBe(false);
  });

  test("matches Codex by its CIMD client_id, with or without a callback id", () => {
    const codex = {
      clientId: "https://chatgpt.com/oauth/codex/client.json",
      name: "Codex",
      redirectUris: ["http://127.0.0.1:54321/callback"],
    };
    expect(isOAuthClientForConnectClient("codex", codex)).toBe(true);
    expect(
      isOAuthClientForConnectClient("codex", {
        ...codex,
        clientId: "https://chatgpt.com/oauth/codex/a1b2c3/client.json",
      }),
    ).toBe(true);
    expect(
      isOAuthClientForConnectClient("codex", {
        ...codex,
        clientId: "https://chatgpt.com.evil.test/oauth/codex/client.json",
        name: "Other",
      }),
    ).toBe(false);
  });

  test("matches Codex's DCR sign-in by the name it registers", () => {
    const codex = {
      clientId: "dcr-codex",
      name: "Codex",
      redirectUris: ["http://127.0.0.1:61234/callback"],
    };
    expect(isOAuthClientForConnectClient("codex", codex)).toBe(true);
    expect(
      isOAuthClientForConnectClient("codex", { ...codex, name: "Codex Pro" }),
    ).toBe(false);
  });

  test("matches every other installer agent's sign-in", () => {
    const dcr = { clientId: "dcr-1", name: null, redirectUris: [] };
    expect(
      isOAuthClientForConnectClient("cursor", {
        ...dcr,
        name: "Cursor",
        redirectUris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
      }),
    ).toBe(true);
    expect(
      isOAuthClientForConnectClient("opencode", {
        ...dcr,
        name: "OpenCode",
        redirectUris: ["http://127.0.0.1:19876/mcp/oauth/callback"],
      }),
    ).toBe(true);
    expect(
      isOAuthClientForConnectClient("opencode", {
        clientId: "https://opencode.ai/oauth/opencode/client.json",
        name: "opencode",
        redirectUris: ["http://127.0.0.1:51675/callback"],
      }),
    ).toBe(true);
    expect(
      isOAuthClientForConnectClient("copilot-cli", {
        ...dcr,
        clientId: "https://github.com/copilot/cli/client-metadata.json",
      }),
    ).toBe(true);
    expect(
      isOAuthClientForConnectClient("claude-desktop", {
        ...dcr,
        clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
      }),
    ).toBe(true);
  });

  test("matches Claude Desktop's installer sign-in by its DCR name and fixed loopback redirect", () => {
    const desktop = {
      clientId: "dcr-desktop",
      name: "Claude Desktop (2.19675.1)",
      redirectUris: ["http://127.0.0.1:53280/callback"],
    };
    expect(isOAuthClientForConnectClient("claude-desktop", desktop)).toBe(true);
    expect(
      isOAuthClientForConnectClient("claude-desktop", {
        ...desktop,
        redirectUris: ["http://127.0.0.1:60000/callback"],
      }),
    ).toBe(false);
    expect(isOAuthClientForConnectClient("claude-code", desktop)).toBe(false);
  });

  test("the SQL version picks the same agent", async () => {
    const agentOf = async (client: {
      clientId: string;
      name: string | null;
      redirectUris: string[];
    }) => {
      const { rows } = await db.execute<{ id: string | null }>(sql`
        SELECT ${connectClientForOAuthClientSql({
          clientId: sql`${client.clientId}::text`,
          name: sql`${client.name}::text`,
          redirectUris: sql`ARRAY[${sql.join(
            client.redirectUris.map((uri) => sql`${uri}`),
            sql`, `,
          )}]::text[]`,
        })} AS id`);
      return rows[0]?.id ?? null;
    };
    expect(await agentOf(claudeCode)).toBe("claude-code");
    expect(
      await agentOf({
        clientId: "https://chatgpt.com/oauth/codex/a1b2c3/client.json",
        name: "Codex",
        redirectUris: [],
      }),
    ).toBe("codex");
    expect(
      await agentOf({ clientId: "dcr-1", name: "Codex", redirectUris: [] }),
    ).toBe("codex");
    expect(
      await agentOf({
        clientId: "dcr-2",
        name: "Cursor",
        redirectUris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
      }),
    ).toBe("cursor");
    expect(
      await agentOf({
        clientId: "dcr-3",
        name: "Amp MCP Client (archestra)",
        redirectUris: ["http://localhost:41592/oauth/callback"],
      }),
    ).toBe("amp");
    expect(
      await agentOf({
        clientId: "dcr-4",
        name: "Claude Desktop (2.19675.1)",
        redirectUris: ["http://127.0.0.1:53280/callback"],
      }),
    ).toBe("claude-desktop");
    expect(await agentOf(other)).toBeNull();
  });
});
