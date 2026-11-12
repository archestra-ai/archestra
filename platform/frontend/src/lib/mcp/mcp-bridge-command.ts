/**
 * The command that sets up the MCP bridge on a device. It downloads the
 * `archestra` program for this system and CPU, then runs `archestra bridge
 * start`, which copies the program to the home folder and, at the first
 * start on a device, turns on auto-start.
 *
 * `baseUrl` is the connection base URL, the one the MCP gateway and the LLM
 * proxy use. The MCP bridge takes the deployment address: that URL without
 * its `/v1`.
 *
 * - macOS and Linux share one command: `uname` runs on the user's computer.
 *   The download URL is in double quotes on purpose: zsh (with the URL paste
 *   helper that oh-my-zsh turns on) puts a backslash before `(` in a pasted
 *   URL that is not quoted, which breaks `$(uname ...)`.
 * - Windows gets a PowerShell command. `PROCESSOR_ARCHITECTURE` (`AMD64`,
 *   `ARM64`) names the CPU. It works in Windows PowerShell 5.1, which has no
 *   `&&`: `if ($?)` runs the program only after a good download. The download
 *   goes to the current folder, not to `%USERPROFILE%\.archestra\bin`: Windows
 *   cannot overwrite the program of a running MCP bridge, and `bridge start`
 *   stops it before it copies itself there. No progress bar: it makes the
 *   download of PowerShell 5.1 many times slower.
 * - Each line is short, so the command reads well where it wraps in a dialog.
 * - `setupCode`, from the setup dialog that shows the command: the program
 *   sends it with its sign-in, and the dialog approves that sign-in in place,
 *   so no approval page opens. It goes on a line of its own, so the code is
 *   never broken in the middle.
 */
export function bridgeCommand(
  baseUrl: string,
  windows: boolean,
  setupCode?: string,
): string {
  const origin = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const download = `${origin}/api/archestra-cli`;
  const start = `bridge start --url ${origin}`;
  if (windows) {
    return (
      `$ProgressPreference = 'SilentlyContinue'; \`\n` +
      `  $arch = $env:PROCESSOR_ARCHITECTURE; \`\n` +
      `  irm "${download}/windows-$arch" \`\n` +
      `    -OutFile archestra.exe; \`\n` +
      `  if ($?) { .\\archestra.exe ${start}${setupCode ? ` \`\n    --setup-code ${setupCode}` : ""} }`
    );
  }
  return (
    `curl -fsSL -o archestra \\\n` +
    `  "${download}/$(uname -s)-$(uname -m)" \\\n` +
    `  && chmod +x archestra \\\n` +
    `  && ./archestra ${start}${setupCode ? ` \\\n    --setup-code ${setupCode}` : ""}`
  );
}

/**
 * Removes the `archestra` program from the device: it stops the MCP bridge,
 * takes it out of the start at login, asks Archestra to remove the device,
 * and deletes its files. `archestra bridge start` puts the program on the
 * PATH on every system, so the bare name works in any new terminal or
 * PowerShell window.
 */
export const UNINSTALL_COMMAND = "archestra uninstall";

/**
 * Gets the `archestra` program that the deployment serves now, and starts
 * the MCP bridge again with it.
 */
const UPDATE_COMMAND = "archestra update";

/**
 * How the user gets the program that the deployment serves onto a device,
 * in three parts, so a page can show the command as code.
 *
 * Only the MCP bridge on Windows updates by itself, and only where the
 * deployment left auto-update on. Everywhere else the user runs the command.
 */
export function programUpdateInstruction(device: {
  platform: string;
  programAutoUpdate: boolean;
}): { before: string; command: string; after: string } {
  const updatesByItself =
    device.programAutoUpdate && device.platform === "windows";
  return {
    before: updatesByItself
      ? "The device updates by itself when no tool call is running. To update now, run "
      : "Run ",
    command: UPDATE_COMMAND,
    after: " in a terminal on that device.",
  };
}
