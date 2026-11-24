/**
 * The scripts that the command of the MCP bridge setup dialog runs. Each one
 * downloads the `archestra` program for this system to a new folder of its
 * own, runs `archestra bridge start` with the address of the deployment and
 * the setup code, and removes the folder. `bridge start` copies the program
 * to `~/.archestra/bin` before it starts the MCP bridge in the background,
 * so the downloaded file is not needed after it.
 *
 * - The new folder is in the home folder: nothing in the current folder can
 *   be in the way (a folder named `archestra`, a folder that is read-only),
 *   and the home folder lets a program run where `/tmp` may not.
 * - The scripts are not saved: `curl ... | sh` and `irm ... | iex` run them
 *   as they come.
 * - The text of a script is copy that ships, so it names the program in
 *   lower case only (`scripts/check-white-label-copy.ts`).
 */

/**
 * For macOS and Linux:
 * `curl -fsSL <address>/api/archestra-cli/install.sh | sh -s -- --url <address> --setup-code <code>`.
 * Its arguments go to `archestra bridge start` as they are; it reads only
 * `--url`, for the download. Everything is in one function that the last
 * line calls: a download of the script that stops halfway runs nothing.
 */
export const INSTALL_SH = `#!/bin/sh
# Sets up the MCP bridge on this device: downloads the archestra program for
# this system and runs "archestra bridge start" with the arguments of this
# script. That copies the program to ~/.archestra/bin and starts the MCP
# bridge in the background.
#
#   curl -fsSL <address>/api/archestra-cli/install.sh \\
#     | sh -s -- --url <address> --setup-code <code>

set -eu

archestra_setup() {
  url=""
  previous=""
  for argument in "$@"; do
    if [ "$previous" = "--url" ]; then
      url="$argument"
    fi
    previous="$argument"
  done
  if [ -z "$url" ]; then
    echo "archestra setup: the command has no --url" >&2
    return 1
  fi

  target="$(uname -s)-$(uname -m)"
  # A new folder of its own, removed at the end: nothing in the current
  # folder can be in the way.
  folder="$(mktemp -d "$HOME/.archestra-setup-XXXXXX")"
  # Also when the terminal closes or Ctrl+C stops the wait for approval.
  trap 'rm -rf "$folder"' EXIT
  trap 'exit 130' HUP INT TERM

  if ! curl -fsSL -o "$folder/archestra" "$url/api/archestra-cli/$target"; then
    echo "archestra setup: cannot download the archestra program for $target from $url" >&2
    return 1
  fi
  chmod +x "$folder/archestra"
  "$folder/archestra" bridge start "$@"
}

archestra_setup "$@"
`;

/**
 * For Windows:
 * `$env:ARCHESTRA_URL = '<address>'; $env:ARCHESTRA_SETUP_CODE = '<code>'; irm <address>/api/archestra-cli/install.ps1 | iex`.
 * `iex` takes no arguments, so the address and the setup code come in
 * environment variables. `irm` downloads the whole script before `iex` runs
 * it. It works in Windows PowerShell 5.1.
 */
export const INSTALL_PS1 = `# Sets up the MCP bridge on this device: downloads the archestra program for
# this system and runs "archestra bridge start". That copies the program to
# %USERPROFILE%\\.archestra\\bin and starts the MCP bridge in the background.
#
#   $env:ARCHESTRA_URL = '<address>'; $env:ARCHESTRA_SETUP_CODE = '<code>'
#   irm <address>/api/archestra-cli/install.ps1 | iex

# A script block, so its variables stay out of the PowerShell session.
& {
  $ErrorActionPreference = 'Stop'
  # The progress bar makes the download of PowerShell 5.1 many times slower.
  $ProgressPreference = 'SilentlyContinue'

  $url = $env:ARCHESTRA_URL
  if (-not $url) { throw 'archestra setup: ARCHESTRA_URL is not set' }
  $target = "windows-$env:PROCESSOR_ARCHITECTURE"
  # A new folder of its own, removed at the end: nothing in the current
  # folder can be in the way.
  $folder = Join-Path $env:USERPROFILE ('.archestra-setup-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $folder | Out-Null
  try {
    $program = Join-Path $folder 'archestra.exe'
    Invoke-RestMethod -Uri "$url/api/archestra-cli/$target" -OutFile $program
    $arguments = @('bridge', 'start', '--url', $url)
    if ($env:ARCHESTRA_SETUP_CODE) {
      $arguments += @('--setup-code', $env:ARCHESTRA_SETUP_CODE)
    }
    & $program @arguments
  } finally {
    Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue
  }
}
`;
