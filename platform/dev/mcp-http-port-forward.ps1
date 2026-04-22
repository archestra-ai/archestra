$ErrorActionPreference = 'SilentlyContinue'

$global:portForwards = @{}

function Test-PortListening {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  $listener = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().
    GetActiveTcpListeners() |
    Where-Object { $_.Port -eq $Port } |
    Select-Object -First 1

  return [bool]$listener
}

Register-EngineEvent PowerShell.Exiting -Action {
  foreach ($proc in $global:portForwards.Values) {
    try {
      if (-not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force
      }
    } catch {
      # best-effort cleanup
    }
  }
} | Out-Null

Write-Output 'Watching for MCP server NodePort services...'

while ($true) {
  $servicesRaw = kubectl get svc -l app=mcp-server -n default -o jsonpath='{range .items[*]}{.metadata.name}:{.spec.ports[0].nodePort}:{.spec.ports[0].port} {end}' 2>$null

  foreach ($entry in ($servicesRaw -split ' ')) {
    if ([string]::IsNullOrWhiteSpace($entry)) {
      continue
    }

    $parts = $entry -split ':'
    if ($parts.Count -lt 3) {
      continue
    }

    $svcName = $parts[0]
    $nodePort = $parts[1]
    $containerPort = $parts[2]

    if ([string]::IsNullOrWhiteSpace($svcName) -or [string]::IsNullOrWhiteSpace($nodePort) -or $nodePort -eq 'null') {
      continue
    }

    if ($global:portForwards.ContainsKey($svcName)) {
      $existingProc = $global:portForwards[$svcName]
      if ($existingProc.HasExited) {
        $global:portForwards.Remove($svcName)
      }
    }

    if ($global:portForwards.ContainsKey($svcName)) {
      continue
    }

    if (-not (Test-PortListening -Port ([int]$nodePort))) {
      $endpoint = kubectl get endpoints $svcName -n default -o jsonpath='{.subsets[0].addresses[0].ip}' 2>$null
      if (-not [string]::IsNullOrWhiteSpace($endpoint)) {
        Write-Output ('Port-forwarding {0}: localhost:{1} -> {2}' -f $svcName, $nodePort, $containerPort)
        $proc = Start-Process -FilePath kubectl -ArgumentList @('port-forward', "svc/$svcName", "$nodePort`:$containerPort", '-n', 'default') -WindowStyle Hidden -PassThru
        $global:portForwards[$svcName] = $proc
      }
    }
  }

  Start-Sleep -Seconds 5
}
