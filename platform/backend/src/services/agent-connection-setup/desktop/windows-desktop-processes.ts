/**
 * PowerShell function `Get-DesktopProcess`: Claude Desktop's own processes,
 * matched by install location. The process name alone also matches Claude
 * Code CLI sessions, which setup must not wait for.
 */
export const WINDOWS_DESKTOP_PROCESSES = String.raw`function Get-DesktopProcess {
  $squirrel = $env:LOCALAPPDATA.TrimEnd('\') + '\AnthropicClaude\'
  $packages = @(Get-AppxPackage | Where-Object { $_.Name -in @('Claude', 'AnthropicPBC.Claude') } | ForEach-Object { '*\WindowsApps\' + $_.Name + '_*__' + $_.PublisherId + '\*' })
  @(Get-Process Claude -ErrorAction SilentlyContinue | Where-Object {
    $path = $_.Path
    $path -and ($path.StartsWith($squirrel, [StringComparison]::OrdinalIgnoreCase) -or @($packages | Where-Object { $path -like $_ }).Count -gt 0)
  })
}`;

/**
 * PowerShell function `Close-Desktop`, for the setup helper's restart; needs
 * `Get-DesktopProcess`. Closing the window quits Desktop only when its tray
 * icon is off; otherwise Desktop hides in the tray. Restart Manager then sends
 * it the end-session message Windows uses to close apps before an update, and
 * Desktop quits. A Desktop that still runs is ended. Throws if it survives.
 */
export const WINDOWS_DESKTOP_CLOSE = `function Wait-DesktopExit([int]$Seconds) {
  $p = Get-DesktopProcess
  if ($p) { $p | Wait-Process -Timeout $Seconds -ErrorAction SilentlyContinue }
  @(Get-DesktopProcess).Count -eq 0
}
function Stop-DesktopSession {
  $source = 'using System; using System.Runtime.InteropServices; using System.Text;
public static class DesktopRestartManager {
  [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint session, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint session, uint files, string[] fileNames, uint count, RM_UNIQUE_PROCESS[] processes, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmShutdown(uint session, uint flags, IntPtr callback);
  public static int Shutdown(int id, long started) {
    uint session;
    int rc = RmStartSession(out session, 0, new StringBuilder(64));
    if (rc != 0) return rc;
    try {
      var process = new RM_UNIQUE_PROCESS();
      process.dwProcessId = id;
      process.ProcessStartTime.dwLowDateTime = (int)(started & 0xFFFFFFFF);
      process.ProcessStartTime.dwHighDateTime = (int)(started >> 32);
      rc = RmRegisterResources(session, 0, null, 1, new[] { process }, 0, null);
      return rc != 0 ? rc : RmShutdown(session, 0, IntPtr.Zero);
    } finally { RmEndSession(session); }
  }
}'
  if (-not ('DesktopRestartManager' -as [type])) { Add-Type -TypeDefinition $source }
  # Only the main process owns Desktop's windows; its children exit with it.
  $desktop = @(Get-DesktopProcess)
  $ids = @($desktop | ForEach-Object { $_.Id })
  $parents = @{}
  Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" | ForEach-Object { $parents[[int]$_.ProcessId] = [int]$_.ParentProcessId }
  $desktop | Where-Object { $ids -notcontains $parents[[int]$_.Id] } | ForEach-Object {
    [void][DesktopRestartManager]::Shutdown($_.Id, $_.StartTime.ToFileTime())
  }
}
function Close-Desktop {
  Get-DesktopProcess | ForEach-Object { [void]$_.CloseMainWindow() }
  if (Wait-DesktopExit 5) { return }
  try { Stop-DesktopSession } catch {}
  if (Wait-DesktopExit 15) { return }
  Get-DesktopProcess | Stop-Process -Force -ErrorAction SilentlyContinue
  if (-not (Wait-DesktopExit 10)) { throw 'Claude Desktop is still running' }
}`;

/**
 * Windows Claude Desktop hides in the system tray when its window closes,
 * unless the tray icon is turned off. Exit in the tray menu runs Desktop's
 * normal quit, so terminal setup asks for it instead of ending the process.
 */
export const WINDOWS_DESKTOP_TRAY_EXIT =
  "Right-click the Claude icon in the system tray and choose Exit. If you do not see the icon, select the arrow (^) next to the clock.";
