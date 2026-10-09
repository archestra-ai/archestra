import type { ConnectionSetupClientId } from "@/types";
import { claudeCodeSetup } from "./agents/claude-code";
import { renderClaudeDesktopSetupScript } from "./agents/claude-desktop";
import { codexSetup } from "./agents/codex";
import { copilotCliSetup } from "./agents/copilot-cli";
import { cursorSetup } from "./agents/cursor";
import { opencodeSetup } from "./agents/opencode";
import { buildEnding } from "./steps/ending";
import {
  bashFooter,
  bashHeader,
  powerShellFooter,
  powerShellHeader,
  sanitizeAppName,
} from "./steps/script-frame";
import type { SetupScriptContext, ShellAgentSetup } from "./types";

export { buildSetupCommand, proxyBaseUrlToOrigin } from "./setup-command";
export type { SetupScriptContext } from "./types";

/**
 * Pure renderers for the /connection one-command setup scripts. Everything in
 * this module is deterministic string building — no DB, no I/O — so the route
 * can render inside its claim transaction and tests can assert exact output.
 *
 * Script contract (see plan):
 * - idempotent re-runs (remove-then-add for CLI registrations, key-scoped
 *   JSON/TOML merges with backups for config files);
 * - secrets are passed via shell variables / env / stdin, never as argv of
 *   external commands;
 * - `curl | bash` cannot export env into the parent shell, so env-based
 *   config (Copilot, Codex login) is either performed inside the script or
 *   emitted as ready-to-paste export lines;
 * - every script ends with next steps + revocation guidance.
 *
 * Windows gets the same contract in PowerShell (`irm <url> | iex`): secrets
 * travel via PowerShell variables / request bodies / stdin, output is
 * colorized unless NO_COLOR is set, and the scripts target Windows PowerShell
 * 5.1 (the OS default) as well as PowerShell 7+: no `-AsHashtable`, ternary,
 * or null-coalescing. A native command's non-zero exit is not promoted to a
 * terminating error ($PSNativeCommandUseErrorActionPreference), but that
 * setting does not cover stderr: under $ErrorActionPreference='Stop' Windows
 * PowerShell 5.1 turns any native-command stderr line into a terminating error
 * that 2>$null does not suppress, so the idempotent MCP remove-then-add —
 * whose remove writes "No MCP server named …" to stderr when the server is not
 * yet registered — wraps the remove in try/catch to stay idempotent.
 *
 * See README.md in this folder for the overall flow and how to add an agent.
 */

/** Agents whose setup is a rendered bash/PowerShell script. */
const SHELL_AGENTS: Record<
  Exclude<ConnectionSetupClientId, "claude-desktop">,
  ShellAgentSetup
> = {
  "claude-code": claudeCodeSetup,
  codex: codexSetup,
  "copilot-cli": copilotCliSetup,
  cursor: cursorSetup,
  opencode: opencodeSetup,
};

export function renderSetupScript(rawCtx: SetupScriptContext): string {
  if (rawCtx.clientId === "claude-desktop") {
    return renderClaudeDesktopSetupScript(rawCtx);
  }
  // appName is white-label, admin-controlled text that lands in script comments
  // and bare echo strings. Collapse control characters (newlines, NUL, …) to
  // spaces so it can never break out of a comment line and execute.
  const ctx: SetupScriptContext = {
    ...rawCtx,
    appName: sanitizeAppName(rawCtx.appName),
  };
  const agent = SHELL_AGENTS[rawCtx.clientId];
  const ending = buildEnding(ctx, agent.label, agent.ending(ctx));

  // Windows targets PowerShell; macOS/Linux share bash.
  const sections =
    ctx.platform === "windows"
      ? [
          powerShellHeader(ctx, agent),
          ...agent.powerShell.sections(ctx),
          powerShellFooter(ending),
        ]
      : [
          bashHeader(ctx, agent),
          ...agent.bash.sections(ctx),
          bashFooter(ending),
        ];
  return `${sections.join("\n\n")}\n`;
}
