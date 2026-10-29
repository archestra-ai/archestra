/** Windows equivalent of the data-only refresh, compatible with PowerShell 5.1. */
export const MANAGED_INSTRUCTIONS_REFRESH_WINDOWS = `param([string]$SourcePath, [string]$PromptPath, [string]$CopilotPath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Set-ManagedInstructions([string]$Path, $Text) {
  if (-not $Path) { return }
  if ($null -eq $Text -or -not $Text.Trim()) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return
  }
  if ((Test-Path -LiteralPath $Path) -and [IO.File]::ReadAllText($Path) -ceq $Text) { return }
  $parent = Split-Path -Parent $Path
  $null = New-Item -ItemType Directory -Force -Path $parent
  $temp = Join-Path $parent ('.managed-instructions-' + [IO.Path]::GetRandomFileName())
  try {
    [IO.File]::WriteAllText($temp, $Text, (New-Object System.Text.UTF8Encoding $false))
    Move-Item -LiteralPath $temp -Destination $Path -Force
  } finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
}
try {
  $source = [IO.File]::ReadAllText($SourcePath) | ConvertFrom-Json
  $response = Invoke-WebRequest -Uri $source.url -Method Get -TimeoutSec 2 -UseBasicParsing -Headers @{ Authorization = ('Bearer ' + $source.token); Accept = 'application/json' }
  if ($response.StatusCode -ne 200 -or $response.Content.Length -gt 131072) { return }
  $data = $response.Content | ConvertFrom-Json
  if ($data -is [array] -or -not $data.PSObject.Properties['instructions']) { return }
  $text = $data.instructions
  if ($null -ne $text -and ($text -isnot [string] -or $text.Length -gt 20000)) { return }
  Set-ManagedInstructions $PromptPath $text
  Set-ManagedInstructions $CopilotPath $text
} catch {
  if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -in @(401, 403)) {
    Remove-Item -LiteralPath $PromptPath -Force -ErrorAction SilentlyContinue
    if ($CopilotPath) { Remove-Item -LiteralPath $CopilotPath -Force -ErrorAction SilentlyContinue }
  }
  # A temporary failure preserves the last valid copy and never blocks launch.
}
`;
