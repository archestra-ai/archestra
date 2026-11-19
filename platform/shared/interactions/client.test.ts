import { describe, expect, test } from "vitest";
import { CHATGPT_MARK, COPILOT_CLI_MARK } from "../client-mark";
import { OPENCODE_FAMILY } from "../opencode-family";
import {
  ARCHESTRA_CODEX_CONNECTION_ORIGINATOR,
  CHATGPT_CLIENT_ID,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_DESKTOP_CLIENT_ID,
  CLIENT_FILTER_OPTIONS,
  ClientFilterSchema,
  clientFilterToAgentIds,
  clientForExternalAgentIds,
  isChatGptClientAgentId,
  isChatGptOriginator,
  isChatGptUserAgent,
  isClaudeDesktopClientAgentId,
  isCodexOriginator,
  isCodexUserAgent,
  isCopilotCliClientAgentId,
  isKiloClientAgentId,
  isKiloUserAgent,
  isKimiCodeUserAgent,
  isOpenCodeClientAgentId,
  isOpenCodeUserAgent,
  KILO_CLIENT_ID,
  KIMI_CODE_CLIENT_ID,
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
    expect(isCodexOriginator("codex_work_desktop")).toBe(true);
    expect(isCodexUserAgent("codex_work_desktop/0.162.0")).toBe(true);
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
      "chatgpt",
      "opencode",
      "kilo",
      "pi",
      "kimi-code",
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
      mark: OPENCODE_FAMILY.opencode.mark,
    });
  });

  test("exposes a filter that expands to the persisted attribution id", () => {
    expect(ClientFilterSchema.parse("opencode")).toBe("opencode");
    expect(clientFilterToAgentIds("opencode")).toEqual([OPENCODE_CLIENT_ID]);
    expect(CLIENT_FILTER_OPTIONS).toContainEqual(
      expect.objectContaining({
        value: "opencode",
        label: "OpenCode",
        mark: OPENCODE_FAMILY.opencode.mark,
      }),
    );
  });
});

describe("Pi coding client attribution", () => {
  test("resolves normalized client ids and exposes the exact stored-id filter", () => {
    expect(clientForExternalAgentIds(["unrelated", " PI "])).toMatchObject({
      filter: "pi",
      label: "Pi",
      mark: { viewBox: "0 0 560 560" },
    });
    expect(ClientFilterSchema.parse("pi")).toBe("pi");
    expect(clientFilterToAgentIds("pi")).toEqual(["pi"]);
    expect(CLIENT_FILTER_OPTIONS).toContainEqual(
      expect.objectContaining({
        value: "pi",
        label: "Pi",
        mark: expect.any(Object),
      }),
    );
    expect(
      clientForExternalAgentIds(["inflection", "pi_session", "pi-other"]),
    ).toBeNull();
  });
});

describe("Kilo Code client attribution", () => {
  test("recognizes Kilo's own User-Agent and leaves OpenCode's alone", () => {
    const kilo =
      "kilo/latest/7.8.8/cli ai-sdk/provider-utils/4.0.46 runtime/bun/1.4.2";
    expect(isKiloUserAgent(kilo)).toBe(true);
    expect(isOpenCodeUserAgent(kilo)).toBe(false);
    for (const userAgent of [
      "opencode/1.17.0",
      "kilocode/1.0.0",
      "my-kilo/1.0.0",
      "",
      undefined,
      null,
    ]) {
      expect(isKiloUserAgent(userAgent)).toBe(false);
    }
  });

  test("resolves stored ids and the logs filter to the Kilo Code family", () => {
    expect(isKiloClientAgentId(" KILO ")).toBe(true);
    expect(clientForExternalAgentIds(["kilo"])).toMatchObject({
      filter: "kilo",
      label: "Kilo Code",
      mark: OPENCODE_FAMILY.kilo.mark,
    });
    expect(ClientFilterSchema.parse("kilo")).toBe("kilo");
    expect(clientFilterToAgentIds("kilo")).toEqual([KILO_CLIENT_ID]);
  });
});

describe("Kimi Code client attribution", () => {
  test("recognizes Kimi Code's User-Agent only", () => {
    expect(isKimiCodeUserAgent("kimi-code-cli/2.3.3")).toBe(true);
    expect(isKimiCodeUserAgent("kimi-code-cli/2.3.3 (web)")).toBe(true);
    for (const userAgent of [
      "kimi-cli/1.0",
      "KimiCLI/0.9",
      "OpenAI/JS 6.1.0",
      "",
      null,
      undefined,
    ]) {
      expect(isKimiCodeUserAgent(userAgent)).toBe(false);
    }
  });

  test("files its traffic under the Kimi Code family", () => {
    expect(clientForExternalAgentIds([KIMI_CODE_CLIENT_ID])).toMatchObject({
      filter: "kimi-code",
      label: "Kimi Code",
      provider: "kimi-code",
    });
  });
});

describe("Claude Desktop client attribution", () => {
  test("recognizes the normalized Desktop client id and rejects other Claude ids", () => {
    expect(isClaudeDesktopClientAgentId(CLAUDE_DESKTOP_CLIENT_ID)).toBe(true);
    expect(isClaudeDesktopClientAgentId("  ANTHROPIC_CLAUDE_DESKTOP ")).toBe(
      true,
    );
    expect(isClaudeDesktopClientAgentId(CLAUDE_CODE_CLIENT_ID)).toBe(false);
    expect(isClaudeDesktopClientAgentId("anthropic_claude")).toBe(false);
    expect(isClaudeDesktopClientAgentId(undefined)).toBe(false);
  });
});

describe("isCopilotCliClientAgentId", () => {
  test("recognizes the Copilot CLI id the setup sends, case-insensitively", () => {
    expect(isCopilotCliClientAgentId("github_copilot_cli")).toBe(true);
    expect(isCopilotCliClientAgentId(" GitHub_Copilot_CLI ")).toBe(true);
    expect(isCopilotCliClientAgentId("openai_codex")).toBe(false);
    expect(isCopilotCliClientAgentId("cursor")).toBe(false);
  });

  test("draws the Copilot CLI with its own mark, the one on its Connect tile", () => {
    expect(clientForExternalAgentIds(["github_copilot_cli"])).toMatchObject({
      filter: "copilot-cli",
      mark: COPILOT_CLI_MARK,
    });
    expect(CLIENT_FILTER_OPTIONS).toContainEqual(
      expect.objectContaining({ value: "copilot-cli", mark: COPILOT_CLI_MARK }),
    );
    expect(isCopilotCliClientAgentId(undefined)).toBe(false);
    expect(isCopilotCliClientAgentId(null)).toBe(false);
  });
});

describe("ChatGPT desktop client attribution", () => {
  test("recognizes the desktop app's process and Work-thread originators", () => {
    // The app server names its process "Codex Desktop"; a Work thread names
    // itself codex_work_desktop.
    expect(isChatGptOriginator("Codex Desktop")).toBe(true);
    expect(isChatGptOriginator(" codex desktop ")).toBe(true);
    expect(isChatGptOriginator("codex_work_desktop")).toBe(true);
    expect(isChatGptOriginator("codex_work_web")).toBe(true);
    expect(isChatGptOriginator("chatgpt_cca")).toBe(true);
    // Both stay Codex originators, which the subscription routing keys on.
    expect(isCodexOriginator("Codex Desktop")).toBe(true);
    expect(isCodexOriginator("codex_work_desktop")).toBe(true);
  });

  test("leaves the Codex CLI, the IDE extension and other names alone", () => {
    for (const originator of [
      "codex_cli_rs",
      "codex-tui",
      "codex_exec",
      "codex_vscode",
      "codex_desktop",
      "Codex Desktop Beta",
      "chatgpt",
      "",
      undefined,
      null,
    ]) {
      expect(isChatGptOriginator(originator)).toBe(false);
    }
  });

  test("reads the desktop app from the User-Agent's leading product", () => {
    expect(
      isChatGptUserAgent(
        "Codex Desktop/0.163.0 (Windows 10.0.26200; x86_64) unknown (Codex Desktop; 26.730.61639)",
      ),
    ).toBe(true);
    expect(isChatGptUserAgent("codex_cli_rs/0.163.0 (Linux; x86_64)")).toBe(
      false,
    );
    expect(isChatGptUserAgent(undefined)).toBe(false);
  });

  test("draws ChatGPT with its own mark and filter, apart from Codex", () => {
    expect(isChatGptClientAgentId(" ChatGPT ")).toBe(true);
    expect(isChatGptClientAgentId("openai_codex")).toBe(false);
    expect(clientForExternalAgentIds([CHATGPT_CLIENT_ID])).toMatchObject({
      filter: "chatgpt",
      label: "ChatGPT",
      mark: CHATGPT_MARK,
    });
    expect(clientForExternalAgentIds(["openai_codex"])).toMatchObject({
      filter: "codex",
    });
    expect(ClientFilterSchema.parse("chatgpt")).toBe("chatgpt");
    expect(clientFilterToAgentIds("chatgpt")).toEqual([CHATGPT_CLIENT_ID]);
    expect(CLIENT_FILTER_OPTIONS).toContainEqual(
      expect.objectContaining({ value: "chatgpt", mark: CHATGPT_MARK }),
    );
  });
});
