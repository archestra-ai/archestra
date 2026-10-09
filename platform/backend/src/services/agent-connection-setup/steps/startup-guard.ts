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
import type { SetupScriptContext } from "../types";

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
        buildStartupGuardUnshadowSection(client),
        ...sections,
        buildStartupGuardInstallSection(buildStartupGuardContext(ctx), client),
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
        `$archPreviousStartupWrapper = Get-Item Function:${client.binary} -ErrorAction SilentlyContinue
try {`,
        buildWindowsStartupGuardUnshadowSection(client),
        ...sections,
        buildWindowsStartupGuardInstallSection(
          buildStartupGuardContext(ctx),
          client,
        ),
        `} catch {
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
