import {
  buildStartupGuardContext,
  buildStartupGuardInstallSection,
  buildStartupGuardUnshadowSection,
  type StartupGuardClient,
} from "../guard/startup-guard";
import {
  buildWindowsStartupGuardInstallSection,
  buildWindowsStartupGuardUnshadowSection,
} from "../guard/startup-guard.windows";
import { CODEX_SETUP_PREFLIGHT } from "../payloads/codex-setup-preflight";
import type { SetupScriptContext } from "../types";
import { psq, sh } from "./quoting";

/**
 * Wrap a CLI client's setup steps with the same startup-guard lifecycle. The
 * old guard is unshadowed before any client command runs and the refreshed
 * guard is installed only after setup succeeds.
 */
export function withStartupGuardBash(
  ctx: SetupScriptContext,
  client: StartupGuardClient,
  sections: string[],
): string[] {
  return ctx.mcp || ctx.proxy || ctx.skills
    ? [
        ...(client.clientId === "codex" ? [codexPreflightBash(ctx)] : []),
        buildStartupGuardUnshadowSection(client),
        ...sections,
        buildStartupGuardInstallSection(buildStartupGuardContext(ctx), client),
        ...(client.clientId === "codex"
          ? ["archestra_codex_setup_complete=1"]
          : []),
      ]
    : sections;
}

/**
 * PowerShell counterpart of {@link withStartupGuardBash}. A failing step
 * restores the wrapper function the current session had loaded before rethrowing.
 */
export function withStartupGuardPowerShell(
  ctx: SetupScriptContext,
  client: StartupGuardClient,
  sections: string[],
): string[] {
  return ctx.mcp || ctx.proxy || ctx.skills
    ? [
        ...(client.clientId === "codex" ? [codexPreflightPowerShell(ctx)] : []),
        `$archPreviousStartupWrapper = Get-Item Function:${client.binary} -ErrorAction SilentlyContinue
try {`,
        buildWindowsStartupGuardUnshadowSection(client),
        ...sections,
        buildWindowsStartupGuardInstallSection(
          buildStartupGuardContext(ctx),
          client,
        ),
        `} catch {
  ${client.clientId === "codex" ? `Write-Warning ('Setup is incomplete. Before making further edits, restore this attempt with: node "' + (Join-Path $archCodexRecovery 'recover.cjs') + '". Then start a new installer run. OAuth grants and downloaded plugins may remain; review the connection on the Connect page.')` : ""}
  if ($null -ne $archPreviousStartupWrapper) {
    Set-Item Function:${client.binary} -Value $archPreviousStartupWrapper.ScriptBlock
  }
  throw
} finally {
  Remove-Variable archPreviousStartupWrapper -ErrorAction SilentlyContinue
}`,
      ]
    : sections;
}

/** Shared lifecycle: run Node preflight before unshadowing or changing client state. */
function codexPreflightBash(ctx: SetupScriptContext): string {
  return `say 'Checking Codex compatibility before changing client configuration'
archestra_codex_recovery=$(node -e ${sh(CODEX_SETUP_PREFLIGHT)} -- "$(command -v codex)" ${sh(ctx.proxy ? "proxy" : "no-proxy")})
archestra_codex_setup_complete=0
archestra_codex_setup_exit() {
  local status=$?
  if [ "$archestra_codex_setup_complete" != 1 ]; then
    printf '%s\\n' 'Setup is incomplete. Before making further edits, restore this attempt with:' >&2
    printf '  node %q\\n' "$archestra_codex_recovery/recover.cjs" >&2
    printf '%s\\n' 'Then start a new installer run. OAuth grants and downloaded plugins may remain; review the connection on the Connect page.' >&2
  fi
  if [ -t 1 ]; then stty sane </dev/tty 2>/dev/null || true; fi
  return "$status"
}
trap archestra_codex_setup_exit EXIT`;
}

function codexPreflightPowerShell(ctx: SetupScriptContext): string {
  return `Say 'Checking Codex compatibility before changing client configuration'
$archCodexExe = Get-Command -Name codex -CommandType Application -ErrorAction Stop | Select-Object -First 1
$archCodexPreflight = @'
${CODEX_SETUP_PREFLIGHT}
'@
# Use stdin so Windows does not have to quote the embedded JavaScript.
$archCodexRecovery = $archCodexPreflight | & node - $archCodexExe.Source ${psq(ctx.proxy ? "proxy" : "no-proxy")}
if ($LASTEXITCODE -ne 0) { throw 'Codex preflight failed. No client configuration was changed. Start a new installer run after fixing the error above.' }`;
}
