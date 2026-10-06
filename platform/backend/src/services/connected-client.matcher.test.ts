import { describe, expect, test } from "vitest";
import { isOAuthClientForConnectClient } from "./connected-client";

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
    expect(isOAuthClientForConnectClient("codex", claudeCode)).toBe(false);
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
});
