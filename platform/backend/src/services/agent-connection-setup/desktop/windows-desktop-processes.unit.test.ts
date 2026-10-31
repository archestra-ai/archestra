import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  WINDOWS_DESKTOP_CLOSE,
  WINDOWS_DESKTOP_PROCESSES,
} from "./windows-desktop-processes";

const exec = promisify(execFile);
const powershellAvailable =
  spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

if (process.env.CI === "true" && !powershellAvailable) {
  throw new Error("CI requires a working PowerShell runtime for these tests");
}

describe.skipIf(!powershellAvailable)(
  "Windows Desktop processes (requires pwsh)",
  () => {
    test("waits only for Desktop, not for Claude Code CLI sessions", async () => {
      // Windows process names cannot tell Desktop from the Claude Code CLI:
      // both run as claude.exe. Stub the cmdlets with what Windows returns.
      const script = `
$env:LOCALAPPDATA = 'C:\\Users\\u\\AppData\\Local'
function Get-AppxPackage { [pscustomobject]@{ Name = 'Claude'; PublisherId = 'pzs8sxrjxfjjc' } }
function Get-Process {
  @('C:\\Program Files\\WindowsApps\\Claude_4.4212.0.0_x64__pzs8sxrjxfjjc\\app\\claude.exe',
    'C:\\Program Files\\WindowsApps\\Claude_4.29.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe',
    'C:\\Users\\u\\AppData\\Local\\AnthropicClaude\\app-1.0.0\\claude.exe',
    'C:\\Users\\u\\.local\\bin\\claude.exe',
    'C:\\Users\\u\\AppData\\Local\\Claude-3p\\claude-code\\2.1.309\\abc\\claude.exe',
    'C:\\Program Files\\WindowsApps\\Claude_4.4212.0.0_x64__otherpublisher\\app\\claude.exe',
    $null) | ForEach-Object -Begin { $id = 0 } -Process { $id++; [pscustomobject]@{ Id = $id; Path = $_ } }
}
${WINDOWS_DESKTOP_PROCESSES}
(Get-DesktopProcess).Id -join ','
`;
      const { stdout } = await exec("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ]);
      expect(stdout.trim()).toBe("1,2,3");
    });

    test.each([
      // Tray icon off: closing the window quits Desktop.
      { quitsOn: "window", expected: "window" },
      // Tray icon on: the window hides, the end-session message quits it.
      { quitsOn: "session", expected: "window,session" },
      { quitsOn: "stop", expected: "window,session,stop" },
      { quitsOn: "never", expected: "window,session,stop,throws" },
    ])("Close-Desktop escalates until Desktop quits on $quitsOn", async ({
      quitsOn,
      expected,
    }) => {
      const script = `
${WINDOWS_DESKTOP_CLOSE}
$script:steps = @()
$script:running = $true
function Get-DesktopProcess {
  if ($script:running) { [pscustomobject]@{ Id = 1 } | Add-Member -MemberType ScriptMethod -Name CloseMainWindow -Value { $script:steps += 'window'; if ('${quitsOn}' -eq 'window') { $script:running = $false }; $true } -PassThru }
}
function Wait-Process { param([Parameter(ValueFromPipeline)]$InputObject, $Timeout) }
function Stop-DesktopSession { $script:steps += 'session'; if ('${quitsOn}' -eq 'session') { $script:running = $false } }
function Stop-Process { param([Parameter(ValueFromPipeline)]$InputObject, [switch]$Force) process { $script:steps += 'stop'; if ('${quitsOn}' -eq 'stop') { $script:running = $false } } }
try { Close-Desktop } catch { $script:steps += 'throws' }
$script:steps -join ','
`;
      const { stdout } = await exec("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ]);
      expect(stdout.trim()).toBe(expected);
    });
  },
);
