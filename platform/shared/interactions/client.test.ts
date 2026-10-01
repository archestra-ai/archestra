import { describe, expect, test } from "vitest";
import {
  ARCHESTRA_CODEX_CONNECTION_ORIGINATOR,
  CLIENT_FILTER_OPTIONS,
  ClientFilterSchema,
  clientFilterToAgentIds,
  clientForExternalAgentIds,
  isCodexOriginator,
  isCodexUserAgent,
  isOpenCodeClientAgentId,
  OPENCODE_CLIENT_ID,
} from "./client";

describe("Codex originator", () => {
  test("recognizes the verifier identity exactly and keeps first-party names", () => {
    expect(isCodexOriginator(ARCHESTRA_CODEX_CONNECTION_ORIGINATOR)).toBe(true);
    expect(isCodexOriginator("archestra_codex_connection")).toBe(true);
    expect(isCodexOriginator(" ARCHESTRA_CODEX_CONNECTION ")).toBe(true);
    expect(isCodexOriginator("codex_cli_rs")).toBe(true);
    expect(isCodexOriginator("codex_exec")).toBe(true);
    expect(isCodexOriginator("codex-tui")).toBe(true);
    expect(isCodexOriginator("codex_vscode")).toBe(true);
    expect(isCodexOriginator("Codex 1.2.3")).toBe(true);
    expect(isCodexUserAgent("archestra_codex_connection/1.0.0")).toBe(true);
  });

  test("rejects other app-server names and strings that merely contain codex", () => {
    for (const originator of [
      "codex",
      "codex_app_server",
      "app-server",
      "archestra_codex",
      "archestra_codex_connection_extra",
      "my_archestra_codex_connection",
      "xarchestra_codex_connection",
      "custom_codex_client",
      "opencode",
      "",
      undefined,
      null,
    ]) {
      expect(isCodexOriginator(originator)).toBe(false);
    }
    expect(isCodexUserAgent("codex_app_server/1.0.0")).toBe(false);
    expect(isCodexOriginator("archestra_codex_connection/1.0.0")).toBe(false);
  });
});

describe("OpenCode client attribution", () => {
  test("orders filters like the connection page", () => {
    expect(CLIENT_FILTER_OPTIONS.map(({ value }) => value)).toEqual([
      "claude-code",
      "claude-desktop",
      "cursor",
      "codex",
      "opencode",
      "copilot-cli",
    ]);
  });

  test("normalizes stored client ids and resolves the UI family", () => {
    expect(isOpenCodeClientAgentId("  OpenCode ")).toBe(true);
    expect(
      clientForExternalAgentIds(["unrelated", " OPENCODE "]),
    ).toMatchObject({
      filter: "opencode",
      label: "OpenCode",
      icon: "/icons/opencode.png",
    });
  });

  test("exposes a filter that expands to the persisted attribution id", () => {
    expect(ClientFilterSchema.parse("opencode")).toBe("opencode");
    expect(clientFilterToAgentIds("opencode")).toEqual([OPENCODE_CLIENT_ID]);
    expect(CLIENT_FILTER_OPTIONS).toContainEqual(
      expect.objectContaining({
        value: "opencode",
        label: "OpenCode",
        icon: "/icons/opencode.png",
      }),
    );
  });
});
