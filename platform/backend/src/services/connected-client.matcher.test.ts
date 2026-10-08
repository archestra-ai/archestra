import { describe, expect, test } from "vitest";
import { isOAuthClientForConnectClient } from "./connected-client-oauth";

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

  test("clients without a verified OAuth identity never match", () => {
    expect(isOAuthClientForConnectClient("cursor", claudeCode)).toBe(false);
    expect(isOAuthClientForConnectClient("claude-desktop", claudeCode)).toBe(
      false,
    );
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
    // A DCR client that merely calls itself Codex is not trusted.
    expect(
      isOAuthClientForConnectClient("codex", { ...codex, clientId: "dcr-1" }),
    ).toBe(false);
    expect(
      isOAuthClientForConnectClient("codex", {
        ...codex,
        clientId: "https://chatgpt.com.evil.test/oauth/codex/client.json",
      }),
    ).toBe(false);
  });
});
