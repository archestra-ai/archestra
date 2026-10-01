import { ARCHESTRA_CODEX_CONNECTION_ORIGINATOR } from "@archestra/shared/interactions/client";

/** Uses .NET anonymous pipes instead of Node's Windows piped-spawn transport. */
export const CODEX_CONNECTION_VERIFICATION_WINDOWS = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$CodexPath,
  [Parameter(Mandatory=$true)][string]$OptionsBase64
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Off
$utf8 = New-Object System.Text.UTF8Encoding($false)
$payloadPattern = '(?i)["'']?\b(messages|input|output|content|arguments|request_body|response_body|body|payload|text)["'']?\s*[:=]\s*[\[{"'']'
$state = @{ Phase = 'initialize'; Id = 0; Thread = $null; Turn = $null; Reply = $false; Completed = $false; TurnError = ''; Stderr = ''; StderrTooLarge = $false; Events = (New-Object 'System.Collections.Generic.List[object]'); Clock = [Diagnostics.Stopwatch]::StartNew() }

function Safe-Detail($Value) {
  $text = [string]$Value
  if ($text.Length -gt 8192) { return '[oversized diagnostic omitted]' }
  $text = $text -replace '(\x1b\[|\x9b)[0-?]*[ -/]*[@-~]', '' -replace '[\x00-\x08\x0b-\x1f\x7f-\x9f]', ''
  if ($text -match $payloadPattern) { return '[diagnostic payload omitted]' }
  $lines = foreach ($line in ($text -split '\r?\n')) {
    $line -replace '(?i)\bBearer\s+[^\s,"''}]+', 'Bearer [redacted]' -replace '\b(sk-|arch_[a-z_]*|archestra_)[A-Za-z0-9_-]{12,}', '[redacted]' -replace '\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b', '[redacted]' -replace '(?i)(["'']?\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password)["'']?\s*[:=]\s*)[^\r\n,}]+', '$1[redacted]' -replace '(?i)(https?://)[^\s/@]+:[^\s/@]+@', '$1[redacted]@' -replace '(?i)(https?://[^\s?]+)\?[^\s]+', '$1?[redacted]'
  }
  $clean = ($lines -join [Environment]::NewLine).Trim()
  if ($clean.Length -gt 2048) { $clean = $clean.Substring($clean.Length - 2048) }
  return $clean
}

function Native-Argument([string]$Value) {
  return '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Drain-Stderr {
  for ($i = 0; $i -lt 64 -and $null -ne $state.ErrRead -and $state.ErrRead.IsCompleted; $i++) {
    $count = $state.ErrRead.GetAwaiter().GetResult()
    if ($count -eq 0) { $state.ErrRead = $null; break }
    $chunk = -join $state.ErrBuffer[0..($count - 1)]
    if (-not $state.StderrTooLarge) {
      $state.Stderr += $chunk
      if ($state.Stderr.Length -gt 8192) { $state.StderrTooLarge = $true; $state.Stderr = '' }
    }
    $state.ErrRead = $state.Process.StandardError.ReadAsync($state.ErrBuffer, 0, $state.ErrBuffer.Length)
  }
}

function Stderr-Detail {
  if ($state.StderrTooLarge) { return '[oversized diagnostic omitted]' }
  return (Safe-Detail $state.Stderr)
}

function Read-Frame {
  while ($true) {
    Drain-Stderr
    if ($state.Clock.ElapsedMilliseconds -gt 120000) { throw ('Codex verification timed out during ' + $state.Phase + ': ' + (Stderr-Detail)) }
    if ($null -eq $state.OutRead) { $state.OutRead = $state.Process.StandardOutput.ReadLineAsync() }
    if (-not $state.OutRead.Wait(50)) { continue }
    $line = $state.OutRead.GetAwaiter().GetResult()
    $state.OutRead = $null
    if ($null -eq $line) {
      [void]$state.Process.WaitForExit(1000)
      if ($null -ne $state.ErrRead) { [void]$state.ErrRead.Wait(50) }
      Drain-Stderr
      $code = 'unknown'
      if ($state.Process.HasExited) { $code = [string]$state.Process.ExitCode }
      $detail = Stderr-Detail
      if (-not $detail) { $detail = 'no stderr diagnostic' }
      throw ('Codex app-server stopped during ' + $state.Phase + ' (exit ' + $code + '): ' + $detail)
    }
    if ($line.Length -gt 8388608) { throw 'Codex app-server returned an oversized protocol message.' }
    try { $message = $line | ConvertFrom-Json } catch { throw 'Codex app-server returned an invalid protocol message.' }
    if ($null -eq $message -or $message -is [string] -or $message -is [array]) { throw 'Codex app-server returned an invalid protocol message.' }
    return $message
  }
}

function Send-Frame($Message) {
  $state.Writer.WriteLine(($Message | ConvertTo-Json -Depth 64 -Compress))
}

function Apply-Event($Event) {
  if ($Event.Thread -cne $state.Thread -or $Event.Turn -cne $state.Turn) { return }
  if ($Event.Method -eq 'item/started' -and $Event.Type -notin @('userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction')) {
    throw 'The inference-only verification attempted a tool; the connection is not verified.'
  }
  if ($Event.Method -eq 'item/completed' -and $Event.HasReply) { $state.Reply = $true }
  if ($Event.Method -eq 'error' -and $Event.Error) { $state.TurnError = $Event.Error }
  if ($Event.Method -eq 'turn/completed') {
    if ($Event.Status -eq 'completed' -and -not $Event.Error -and $state.Reply) { $state.Completed = $true; return }
    $detail = $Event.Error
    if (-not $detail) { $detail = $state.TurnError }
    if (-not $detail) { $detail = 'no completed assistant reply' }
    throw ('Codex proxy inference failed (' + $Event.Status + '): ' + $detail)
  }
}

function Observe-Frame($Message) {
  if ($null -ne $Message.id -and $Message.method) {
    Send-Frame @{ id = $Message.id; error = @{ code = -32601; message = 'Connection verification cannot answer user approval requests.' } }
    throw 'Codex verification needs a native approval; no approval was accepted automatically.'
  }
  if ($state.Phase -ne 'turn/start' -or $Message.method -cnotin @('item/started', 'item/completed', 'turn/completed', 'error') -or $Message.params.threadId -cne $state.Thread) { return }
  $p = $Message.params
  $turn = $p.turnId
  if (-not $turn) { $turn = $p.turn.id }
  $detail = $p.turn.error.message
  if (-not $detail) { $detail = $p.error.message }
  $event = @{ Method = $Message.method; Thread = $p.threadId; Turn = $turn; Type = $p.item.type; HasReply = ($p.item.type -eq 'agentMessage' -and $p.item.text -is [string] -and $p.item.text.Trim().Length -gt 0); Status = $p.turn.status; Error = (Safe-Detail $detail) }
  if ($state.Turn) { Apply-Event $event }
  elseif ($state.Events.Count -lt 128) { $state.Events.Add($event) }
  else { throw 'Codex sent too many lifecycle events before starting the verification turn.' }
}

function Invoke-Rpc([string]$Method, $Params) {
  $state.Phase = $Method
  $state.Id++
  $id = $state.Id
  Send-Frame @{ id = $id; method = $Method; params = $Params }
  while ($true) {
    $message = Read-Frame
    if ($null -ne $message.id -and -not $message.method -and $message.id -eq $id) {
      if ($message.error) { throw ('Codex ' + $Method + ' failed (RPC ' + $message.error.code + '): ' + (Safe-Detail $message.error.message)) }
      return $message.result
    }
    Observe-Frame $message
  }
}

$processStarted = $false
$failure = $null
$result = $null
try {
  $options = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($OptionsBase64)) | ConvertFrom-Json
  if (-not ($options.server -or $options.provider)) { throw 'Invalid Codex verification options.' }
  foreach ($name in @('server', 'provider')) {
    $value = $options.$name
    if ($null -ne $value -and ($value -isnot [string] -or -not $value -or $value.Length -gt 512)) { throw 'Invalid Codex verification options.' }
  }
  $executable = $CodexPath
  $nativeArgs = @('app-server')
  if ($CodexPath -match '\.cmd$') {
    $entry = Join-Path (Split-Path -Parent $CodexPath) 'node_modules/@openai/codex/bin/codex.js'
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'Could not locate the native Codex CLI behind the npm shim.' }
    $executable = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $nativeArgs = @($entry, 'app-server')
  } elseif ($CodexPath -match '\.ps1$') { throw 'Could not locate the native Codex CLI.' }
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $executable
  $start.Arguments = ($nativeArgs | ForEach-Object { Native-Argument $_ }) -join ' '
  $start.UseShellExecute = $false
  # Codex's env override wins over clientInfo.name. Set only the verifier child.
  $start.EnvironmentVariables['CODEX_INTERNAL_ORIGINATOR_OVERRIDE'] = '${ARCHESTRA_CODEX_CONNECTION_ORIGINATOR}'
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardOutputEncoding = $utf8
  $start.StandardErrorEncoding = $utf8
  $start.WorkingDirectory = (Get-Location).ProviderPath
  $state.Process = New-Object Diagnostics.Process
  $state.Process.StartInfo = $start
  try {
    $processStarted = $state.Process.Start()
    if (-not $processStarted) { throw 'Process.Start returned false' }
  } catch { throw ('Codex verifier launch failed (native transport; executable ' + (Safe-Detail $executable) + '): ' + (Safe-Detail $_.Exception.Message)) }
  $state.Writer = New-Object IO.StreamWriter($state.Process.StandardInput.BaseStream, $utf8, 1024, $true)
  $state.Writer.AutoFlush = $true
  $state.ErrBuffer = New-Object char[] 1024
  $state.ErrRead = $state.Process.StandardError.ReadAsync($state.ErrBuffer, 0, $state.ErrBuffer.Length)
  $null = Invoke-Rpc 'initialize' @{ clientInfo = @{ name = '${ARCHESTRA_CODEX_CONNECTION_ORIGINATOR}'; version = '1.0.0' } }
  Send-Frame @{ method = 'initialized' }
  $config = Invoke-Rpc 'config/read' @{ includeLayers = $false; cwd = $start.WorkingDirectory }
  if ($options.provider -and $config.config.model_provider -cne $options.provider) { throw 'The configured Codex provider is not the selected LLM proxy.' }
  # Inherit model, approval policy and sandbox. No per-thread overrides.
  $thread = Invoke-Rpc 'thread/start' @{ cwd = $start.WorkingDirectory; ephemeral = $true }
  $state.Thread = $thread.thread.id
  if (-not $state.Thread) { throw 'Codex did not start a verification thread.' }
  if ($options.provider -and $thread.modelProvider -cne $options.provider) { throw 'The verification thread did not select the configured LLM proxy.' }
  $result = @{ gateway = 'not-selected'; proxy = 'not-selected' }
  if ($options.server) {
    $server = $null
    $cursor = $null
    $cursors = New-Object 'System.Collections.Generic.HashSet[string]'
    do {
      if ($cursor -and -not $cursors.Add([string]$cursor)) { throw 'Codex returned a repeated MCP inventory cursor.' }
      $params = @{ threadId = $state.Thread; detail = 'toolsAndAuthOnly' }
      if ($cursor) { $params.cursor = $cursor }
      $page = Invoke-Rpc 'mcpServerStatus/list' $params
      $server = $page.data | Where-Object { $_.name -ceq $options.server } | Select-Object -First 1
      $cursor = $page.nextCursor
    } while (-not $server -and $cursor)
    if (-not $server) { throw 'Codex did not discover the selected MCP gateway.' }
    $probe = $null
    foreach ($name in @('archestra__whoami', 'archestra__get_guardrails_policy', 'archestra__list_skills')) {
      $probe = $server.tools.PSObject.Properties.Value | Where-Object { $_.name -ceq $name -and -not $_.inputSchema.required } | Select-Object -First 1
      if ($probe) { break }
    }
    if (-not $probe) { throw 'The selected gateway has no supported read-only verification tool.' }
    $call = Invoke-Rpc 'mcpServer/tool/call' @{ threadId = $state.Thread; server = $options.server; tool = $probe.name; arguments = @{} }
    if (-not $call -or $call.isError -or -not ($call.content.Count -gt 0 -or $null -ne $call.structuredContent)) { throw 'The native gateway verification call did not succeed.' }
    $result.gateway = 'verified'
  }
  if ($options.provider) {
    $turn = Invoke-Rpc 'turn/start' @{ threadId = $state.Thread; input = @(@{ type = 'text'; text = 'Connection check only: reply with OK. Do not use any tools, shell commands, subagents, files, or network tools.'; text_elements = @() }) }
    $state.Turn = $turn.turn.id
    if (-not $state.Turn) { throw 'Codex did not identify the verification turn.' }
    foreach ($event in $state.Events) { Apply-Event $event }
    $state.Events.Clear()
    while (-not $state.Completed) { Observe-Frame (Read-Frame) }
    $result.proxy = 'verified'
  }
} catch { $failure = Safe-Detail $_.Exception.Message }
finally {
  if ($processStarted) {
    try {
      if ($state.Writer) { $state.Writer.Dispose() }
      $state.Process.StandardInput.Close()
      if (-not $state.Process.WaitForExit(1000)) {
        $treeKill = $state.Process.GetType().GetMethod('Kill', [type[]]@([bool]))
        if ($treeKill) { $state.Process.Kill($true) }
        elseif ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
          # .NET Framework lacks Kill(true). Terminate only our owned tree,
          # including the native executable behind an npm launcher.
          $null = & (Join-Path ([Environment]::GetFolderPath('System')) 'taskkill.exe') /PID ([string]$state.Process.Id) /T /F 2>$null
        } else { $state.Process.Kill() }
        [void]$state.Process.WaitForExit(1000)
      }
      if (-not $state.Process.HasExited) { throw 'The verifier-owned app-server process did not stop.' }
    } catch { if (-not $failure) { $failure = 'Could not stop the verifier-owned Codex process.' } }
  }
  if ($state.Process) { $state.Process.Dispose() }
}
if ($failure) { [Console]::Error.WriteLine($failure); exit 1 }
[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
exit 0
`;
