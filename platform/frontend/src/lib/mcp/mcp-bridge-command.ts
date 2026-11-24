/**
 * The command that sets up the MCP bridge on a device. It runs a script of
 * the deployment (`/api/archestra-cli/install.sh` or `install.ps1`), which
 * downloads the `archestra` program for this system to a new folder of its
 * own and runs `archestra bridge start`. That copies the program to the home
 * folder and, at the first start on a device, turns on auto-start. Nothing in
 * the current folder can be in the way.
 *
 * `baseUrl` is the connection base URL, the one the MCP gateway and the LLM
 * proxy use. The MCP bridge takes the deployment address: that URL without
 * its `/v1`.
 *
 * - macOS and Linux share one command: `sh -s --` passes the rest of the
 *   line to the script, which passes it on to `archestra bridge start`.
 * - Windows gets a PowerShell command that works in Windows PowerShell 5.1.
 *   `iex` takes no arguments, so the address and the setup code go in
 *   environment variables. The setup code is always set, also to nothing, so
 *   a code of an earlier run in the same window does not stay.
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
  const scripts = `${origin}/api/archestra-cli`;
  if (windows) {
    return (
      `$env:ARCHESTRA_URL = '${origin}'; \`\n` +
      `  $env:ARCHESTRA_SETUP_CODE = '${setupCode ?? ""}'; \`\n` +
      `  irm ${scripts}/install.ps1 | iex`
    );
  }
  return (
    `curl -fsSL ${scripts}/install.sh \\\n` +
    `  | sh -s -- --url ${origin}${setupCode ? ` \\\n    --setup-code ${setupCode}` : ""}`
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
