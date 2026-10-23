import type { AgentScriptRenderer } from "../types";
import { psq } from "./quoting";

/** Carry one Node.js installer through either existing shell transport. */
export function nodeScriptRenderers(
  render: (ctx: Parameters<AgentScriptRenderer["sections"]>[0]) => string,
) {
  return {
    bash: {
      sections: (ctx: Parameters<typeof render>[0]) => [
        `node - <<'ARCHESTRA_NODE_SETUP'\n${render(ctx)}\nARCHESTRA_NODE_SETUP`,
      ],
    },
    powerShell: {
      sections: (ctx: Parameters<typeof render>[0]) => [
        `$archNodeScript = ${psq(Buffer.from(render(ctx)).toString("base64"))}
# Windows PowerShell 5.1 strips embedded quotes in native arguments.
# Decode bytes directly: no JavaScript in argv or console-encoding round trip.
$archNodePath = Join-Path ([System.IO.Path]::GetTempPath()) ('archestra-setup-' + [Guid]::NewGuid().ToString('N') + '.cjs')
$archNodeFile = $null
try {
  $archNodeFile = [System.IO.File]::Open($archNodePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  $archNodeBytes = [Convert]::FromBase64String($archNodeScript)
  $archNodeFile.Write($archNodeBytes, 0, $archNodeBytes.Length)
  $archNodeFile.Dispose()
  & node $archNodePath
  if ($LASTEXITCODE -ne 0) { throw ('Connection setup failed (exit ' + $LASTEXITCODE + ')') }
} finally {
  # Only remove the file this attempt created; never a pre-existing path.
  if ($null -ne $archNodeFile) {
    $archNodeFile.Dispose()
    Remove-Item -LiteralPath $archNodePath -Force -ErrorAction Stop
  }
}`,
      ],
    },
  };
}
