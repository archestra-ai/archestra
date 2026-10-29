// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these files build bash/PowerShell source as JS strings, so `${VAR}` is shell
// parameter expansion for the emitted script, not a JS template placeholder

/**
 * Bash proof that a named member is gone from a client's JSON config, for the
 * engine's `disconnect_verify()`.
 *
 * The removal itself is delegated to the vendor CLI, whose exit status cannot
 * answer "is it gone?" — a remove of an already-absent entry may exit 0 or 1
 * depending on the CLI — and a missing binary makes the removal a silent
 * no-op. Reading the config back is the only honest check, and it is also
 * what catches the missing-binary case. Prints the manual command and returns
 * 1 when the entry survived.
 *
 * The check needs python3 for a real JSON parse (a plain grep of a JSON file
 * false-positives on names that appear in unrelated values); without python3
 * it returns 0, keeping the previous assume-success behaviour rather than
 * failing disconnects on machines that cannot verify. An unreadable or
 * corrupt config also passes: presence is unprovable there, and the failure
 * path must only fire on proof.
 */
export function jsonMemberGoneVerify(params: {
  /** Shell expression for the config path, e.g. `"$HOME/.copilot/mcp-config.json"`. */
  configPath: string;
  /** Top-level object holding the entries; empty string = the document root. */
  member: string;
  /** Shell variable carrying the entry name, e.g. `$MCP_SERVER_NAME`. */
  nameVar: string;
  /** Command the user can run by hand when verification fails. */
  manualCommand: string;
}): string {
  const { configPath, member, nameVar, manualCommand } = params;
  return `      command -v python3 >/dev/null 2>&1 || return 0
      arch_cfg=${configPath}
      [ -f "$arch_cfg" ] || return 0
      if python3 -c '
import json, sys
try:
    with open(sys.argv[1]) as f:
        cfg = json.load(f)
except Exception:
    sys.exit(0)
parent = cfg.get(sys.argv[3]) if sys.argv[3] else cfg
sys.exit(1 if isinstance(parent, dict) and sys.argv[2] in parent else 0)
' "$arch_cfg" "${nameVar}" "${member}"; then return 0; fi
      line_reset
      printf '%s  %s is still registered in %s — run \`${manualCommand} %s\` yourself.%s\\n' "$C_WARN" "${nameVar}" "$arch_cfg" "${nameVar}" "$C_RESET"
      return 1`;
}

/**
 * PowerShell twin of {@link jsonMemberGoneVerify}, for the engine's
 * `Test-ArchDisconnected`. ConvertFrom-Json is built in, so there is no
 * python3-style dependency; the unreadable-config case still passes for the
 * same reason.
 */
export function windowsJsonMemberGoneVerify(params: {
  /** PowerShell expression for the config path. */
  configPath: string;
  /** Top-level object holding the entries; empty string = the document root. */
  member: string;
  /** PowerShell variable carrying the entry name, e.g. `$McpServerName`. */
  nameVar: string;
  /** Command the user can run by hand when verification fails. */
  manualCommand: string;
}): string {
  const { configPath, member, nameVar, manualCommand } = params;
  const parent = member ? `$archParsed.${member}` : "$archParsed";
  return `    $archCfg = ${configPath}
    if (Test-Path $archCfg) {
      $archParsed = $null
      try { $archParsed = Get-Content -Path $archCfg -Raw | ConvertFrom-Json } catch { }
      $archParent = if ($archParsed) { ${parent} } else { $null }
      if ($archParent -and $archParent.PSObject.Properties[${nameVar}]) {
        $Script:ArchDisconnectReason = ${nameVar} + ' is still registered in ' + $archCfg + ' — run \`${manualCommand} ' + ${nameVar} + '\` yourself.'
        return $false
      }
    }`;
}
