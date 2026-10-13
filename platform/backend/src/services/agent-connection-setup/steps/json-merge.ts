import { ALL_ARCHESTRA_TOKEN_PREFIXES } from "@archestra/shared";
import { indent, psBareOrIndex, psq, sh } from "./quoting";

/**
 * Key-scoped JSON merge via python3 (no jq dependency). Values arrive through
 * the child process env, never argv. Backs the file up before writing.
 */
export function mergeJsonFileBash(params: {
  file: string;
  env: Record<string, string>;
  python: string;
  fallbackMessage: string;
  fallbackSnippet: string;
}): string {
  const envAssignments = Object.entries(params.env)
    .map(([key, value]) => `export ${key}=${sh(value)}`)
    .join("\n");

  // params.file is an internal constant like $HOME/.claude/settings.json and
  // MUST render double-quoted: $HOME has to expand. sh()'s single quotes kept
  // it literal, so mkdir dropped a junk ./'$HOME' dir in the cwd, the backup
  // cp never matched, and on a machine without the config dir the python merge
  // crashed and aborted the whole script under set -e.
  return `if command -v python3 >/dev/null 2>&1; then
  mkdir -p "$(dirname "${params.file}")"
  # Back up once: a re-run must not overwrite the pristine pre-Archestra copy
  # with our already-modified file. The merge below is itself idempotent.
  if [ -f "${params.file}" ] && [ ! -f "${params.file}.archestra-backup" ]; then
    cp "${params.file}" "${params.file}.archestra-backup"
  fi
${indent(envAssignments, "  ")}
  python3 - <<'ARCHESTRA_PY'
${params.python}
ARCHESTRA_PY
else
  warn ${sh(params.fallbackMessage)}
  cat <<'ARCHESTRA_MANUAL'
${params.fallbackSnippet}
ARCHESTRA_MANUAL
fi`;
}

/**
 * Key-scoped JSON merge using PowerShell's built-in ConvertFrom-Json /
 * ConvertTo-Json (no python dependency). Ensures the file exists, backs it up
 * once, ensures a nested object, then sets each leaf property. Works on
 * Windows PowerShell 5.1 (PSCustomObject + Add-Member, not -AsHashtable).
 */
export function mergeJsonFilePowerShell(params: {
  /** PowerShell expression resolving to the file path (e.g. a Join-Path). */
  pathExpr: string;
  /** Dotted accessor of the nested object to merge into, e.g. "env". */
  nestedKey: string;
  /** Leaf key/value pairs to set under the nested object. */
  values: Record<string, string>;
  removeManagedTokenKeys?: string[];
}): string {
  const removeManagedTokens = params.removeManagedTokenKeys?.length
    ? `foreach ($arch_key in @(${params.removeManagedTokenKeys.map(psq).join(", ")})) {
  $arch_property = $arch_nested.PSObject.Properties[$arch_key]
  if ($arch_property -and ($arch_property.Value -is [string])) {
    foreach ($arch_prefix in @(${ALL_ARCHESTRA_TOKEN_PREFIXES.map(psq).join(", ")})) {
      if ($arch_property.Value.StartsWith($arch_prefix, [StringComparison]::Ordinal)) {
        $arch_nested.PSObject.Properties.Remove($arch_key)
        break
      }
    }
  }
}`
    : "";
  const setLines = Object.entries(params.values)
    .map(
      ([key, value]) =>
        `if ($arch_nested.PSObject.Properties[${psq(key)}]) { $arch_nested.${psBareOrIndex(key)} = ${psq(value)} } else { $arch_nested | Add-Member -NotePropertyName ${psq(key)} -NotePropertyValue ${psq(value)} }`,
    )
    .join("\n");

  return `$arch_path = ${params.pathExpr}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $arch_path) | Out-Null
if ((Test-Path $arch_path) -and -not (Test-Path ($arch_path + '.archestra-backup'))) {
  Copy-Item -Path $arch_path -Destination ($arch_path + '.archestra-backup')
}
$arch_config = [pscustomobject]@{}
if (Test-Path $arch_path) {
  $arch_raw = Get-Content -Raw -Path $arch_path
  if ($arch_raw -and $arch_raw.Trim()) { $arch_config = $arch_raw | ConvertFrom-Json }
}
if (-not $arch_config.PSObject.Properties[${psq(params.nestedKey)}]) { $arch_config | Add-Member -NotePropertyName ${psq(params.nestedKey)} -NotePropertyValue ([pscustomobject]@{}) }
$arch_nested = $arch_config.${psBareOrIndex(params.nestedKey)}
${removeManagedTokens}
${setLines}
$arch_config | ConvertTo-Json -Depth 32 | Set-Content -Path $arch_path -Encoding utf8
Write-Host ('Updated ' + $arch_path)`;
}
