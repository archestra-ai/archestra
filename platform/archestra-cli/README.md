# archestra

The program a user runs on their own computer to connect it to Archestra. Today it has one component, the MCP bridge.

The MCP bridge is the tunnel client. It lets agents in Archestra use MCP servers that only work on that computer, such as the ones that control a desktop application.

The computer opens every connection: the client polls Archestra for MCP messages and posts the answers. Archestra never connects to the computer. The wire protocol is the one of the OpenAI `tunnel-client` (its `docs/protocol.md`), with no `shard_token`.

## Commands

```bash
archestra bridge start --url https://archestra.example.com
archestra bridge stop
archestra bridge status
archestra bridge enable-auto-start
archestra bridge disable-auto-start
archestra update
archestra uninstall
```

The commands of a component are `archestra <component> <action>`. `update` and `uninstall` are commands of the program: there is no update or uninstall of the MCP bridge alone.

| Command | What it does | What it leaves alone |
| --- | --- | --- |
| `bridge start` | Starts the MCP bridge in the background. | Auto-start, except at the first start. |
| `bridge stop` | Stops the MCP bridge that runs in the background. | Auto-start, the config file and the device key. |
| `bridge status` | Shows if the MCP bridge runs, if auto-start is on, which Archestra the device is linked to, the version and the log file. | Everything: it only reads. |
| `bridge enable-auto-start` | Turns auto-start on: the MCP bridge starts at each login. | What runs now. |
| `bridge disable-auto-start` | Turns auto-start off. | What runs now. |
| `update` | Gets the program that Archestra serves now, and starts the MCP bridge again with it. | Auto-start, the config file and the device key. |
| `uninstall` | Removes the program with the MCP bridge from the computer. | MCP servers and other programs on the computer. |

- The first `bridge start` asks for approval in the browser, then writes `~/.archestra/mcp-bridge/config.yaml`.
- `bridge start` then copies the program to `~/.archestra/bin/archestra` (`archestra.exe` on Windows) and continues there in the background. The command in the terminal ends. See [Systems](#systems).
- The first start on a computer (no config file yet) also turns auto-start on and puts the `archestra` command on the `PATH` of the user. A later start keeps what `bridge enable-auto-start` and `bridge disable-auto-start` set, and brings an auto-start entry that is there up to date.
- `bridge enable-auto-start` needs a computer that is signed in, and uses the default config file.
- An MCP bridge started with `--foreground` runs in the terminal; stop it there with Ctrl-C.

Options of `bridge start`: `--url <url>`, `--config <path>`, `--no-tray`, `--foreground` (stay in the terminal), `--no-open`, `--background` (the OS sets it). The other commands have no options.

### The `archestra` command on the PATH

The first start puts `~/.archestra/bin` on the `PATH` of the user, so `archestra bridge stop` works in each new terminal. A terminal that is open already does not see the change.

| System | Where |
| --- | --- |
| macOS, Linux | Two lines at the end of the startup file of the shell of the user (`$SHELL`): `~/.zshrc` (in `$ZDOTDIR` when it is set), `~/.bashrc` (`~/.bash_profile` on macOS), or `~/.profile` for another shell. fish gets the file `~/.config/fish/conf.d/archestra.fish`. |
| Windows | The folder in the `Path` value of `HKEY_CURRENT_USER\Environment`, with the type that the value had. No administrator rights. |

- Nothing changes when the folder is on the `PATH` already.
- The first of the two lines is a comment that says who added them. `archestra uninstall` removes the two lines from each of these files, and the folder from the `Path` value.

### Update

The program follows the Archestra that it is connected to. The checksum decides, not the version:

1. With each request the MCP bridge sends its system and CPU (`X-Tunnel-Client-Target`, for example `darwin-arm64`), its version, and the SHA-256 of its file (`X-Tunnel-Client-Sha256`).
2. Each sync answer names the program that Archestra serves for that system and CPU: `program: { version, sha256, auto_update }`.
3. Another SHA-256 than the one of the program that runs is an update. That also holds for an Archestra that went back to an older program.

`archestra update` then does two steps:

1. It downloads the program to `~/.archestra/bin/archestra-update` and checks its SHA-256 against the one of the sync answer. Nothing is touched before that is right.
2. The downloaded program installs itself: it runs as `archestra bridge start`, which copies it over the installed program and starts the MCP bridge again.

| System | Who updates |
| --- | --- |
| Windows | The MCP bridge that the OS runs, by itself, when Archestra allows it (`auto_update`) and no command is in work. `archestra update` does it at once. |
| macOS | The user, with `archestra update`. The program is not signed: each build is a new application to the privacy settings of macOS, so an update takes away the permissions that the MCP servers got. A silent update would do that with no warning. The tray menu and the Device tab show that an update waits. |
| Linux | The user, with `archestra update`. The downloaded program would start inside the systemd unit of the MCP bridge, and systemd would end it together with the MCP bridge that it stops. The Device tab shows that an update waits. |

- An MCP bridge that runs in a terminal (`--foreground`) never updates itself.
- The MCP bridge tries one program one time. The SHA-256 of the last try is in `~/.archestra/mcp-bridge/update-tried`; a program that could not install itself is not tried again at each sync. A download that failed or had another SHA-256 is not a try.

### Uninstall

`archestra uninstall` does these steps in this order:

1. It stops the MCP bridge and removes all that the OS keeps for it. If this fails, nothing more is removed.
2. It asks Archestra to remove the device (`DELETE /v1/tunnels/<tunnel id>` with the device key), so the Device tab does not show the computer any more. If Archestra does not answer, the uninstall goes on and the terminal shows where to remove the device by hand.
3. It deletes `~/.archestra/mcp-bridge`: the config file with the device key, and the log files.
4. It deletes `~/.archestra/bin/archestra`. Windows cannot delete the file of a running program, so a hidden `cmd` deletes it a few seconds after the command ends.
5. It removes `~/.archestra/bin` and `~/.archestra` only when they are empty: other Archestra tools can keep files there.
6. It takes the `archestra` command off the `PATH` of the user.

## Files

| File | Purpose |
| --- | --- |
| `~/.archestra/bin/archestra` | The program that runs in the background. |
| `~/.archestra/mcp-bridge/config.yaml` | The config file of the MCP bridge. |
| `~/.archestra/mcp-bridge/mcp-bridge.log` | The log file. It also gets the stderr lines of the MCP servers. |
| `~/.archestra/mcp-bridge/mcp-bridge.log.1` | The log file before it, put aside when it grew over 5 MB. |
| `~/.archestra/mcp-bridge/mcp-bridge.lock`, `mcp-bridge.pid` | Windows and Linux: the MCP bridge in the background holds the lock while it runs, and writes its process id. |
| `~/Library/LaunchAgents/ai.archestra.mcp-bridge.plist` | The LaunchAgent of the MCP bridge on macOS, when it is in the start at login. |
| `~/.archestra/mcp-bridge/ai.archestra.mcp-bridge.plist` | The same LaunchAgent, when it is not in the start at login: launchd does not read this folder at login. |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `Archestra MCP bridge` | The start at login on Windows. |
| `~/.config/systemd/user/archestra-mcp-bridge.service` | The unit that runs the MCP bridge on Linux with a systemd user session. It is enabled when the MCP bridge is in the start at login. |
| `~/.config/autostart/archestra-mcp-bridge.desktop` | The start at login on Linux with no systemd user session. |

On Windows `~` is `%USERPROFILE%`.

## Config

Archestra has the config of the device: for each desktop MCP server that the user installed, the command or the URL, and on or off. An admin writes the command in the catalog item.

- A sync gets this config and writes it to the config file. The file is a copy: the user does not edit it, and a sync replaces its MCP entries.
- A sync writes the file only when Archestra has other MCP entries than the file. So `synced_at` in the file is the time of the last sync that changed the MCP entries (or of the first sync), not of the last sync.
- The client syncs when it starts, when Archestra says that the config changed, when the user picks "Sync config from Archestra" in the tray menu, and every 5 minutes.
- If a sync fails, the file and the MCP servers stay as they are. If the client starts and cannot reach Archestra, it runs the MCP servers of the file.
- An item with a command is a stdio MCP server that the client starts. An item with a URL is an HTTP MCP server on this computer that the client connects to. An item with none of them, or one that is off, is not started.
- One command serves every system. A program on `PATH` (`matlab-mcp-server`) or a package runner (`npx -y some-mcp-server`, `uvx some-mcp-server`) works on macOS, Windows and Linux. On Windows a name with no extension is looked up with `PATHEXT`, so `npx` is `npx.cmd`.
- A command can have `$USER` and `$HOME` (also `${USER}`, `${HOME}`), and the Windows names `%USERNAME%` and `%USERPROFILE%` for the same two values. On Windows the values come from `USERNAME` and `USERPROFILE`. The client splits the command into arguments, then replaces the variables in each argument. No shell runs: no `~`, no pipes, no other variables.
- The split is shell-like: spaces separate arguments, and quotes keep spaces in one argument. On macOS and Linux a backslash escapes the next character; on Windows it is a part of the path (`C:\Users\$USER\bin\mcp.exe`).
- The client runs the command with no question to the user.

## State, restart and log

- Each MCP server has a state: `no_command`, `starting`, `running`, `failed` (with the error) or `stopped`. The client reports the states to Archestra at the start, after each sync that changed the config file, and at each change.
- Archestra can ask the client to sync, to start one MCP server again, and to give the last 200 stderr lines of a stdio MCP server. These requests come through the poll on the reserved channel `archestra-bridge`.
- Each stderr line of a stdio MCP server also goes to the log of the client, with the name of the MCP server in front.
- A log file over 5 MB is put aside as `mcp-bridge.log.1` (in place of the one before it), and a new log file starts. Windows and Linux: each time the MCP bridge starts in the background. macOS: each time `bridge start` hands over to launchd; launchd opens the log file itself, so a start at login does not put it aside.

## Systems

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Install | `curl` from the Device tab of Personal Settings | PowerShell `irm` from the Device tab of Personal Settings | `curl` from the Device tab of Personal Settings |
| Runs in the background | launchd, as the job `ai.archestra.mcp-bridge` | a process of its own | the systemd user unit `archestra-mcp-bridge.service`; with no systemd user session, a process of its own |
| In the start at login when | the LaunchAgent is in `~/Library/LaunchAgents` | the `Run` key has the value `Archestra MCP bridge` | the unit is enabled (`systemctl --user enable`); with no systemd user session, the XDG autostart entry is there |
| `bridge stop` | `launchctl bootout` | the stop request (below) | `systemctl --user stop`; the stop request for a process of its own |
| `uninstall` | `launchctl bootout`, removes both LaunchAgent files | the stop request, deletes the `Run` value | `systemctl --user disable --now`, removes the unit and the XDG autostart entry; the stop request for a process of its own |
| Tray | menu bar | notification area (`Shell_NotifyIconW`, stock icons) | none: the Device tab shows the state |
| Log file | launchd writes it | the program writes it | the program writes it |

### macOS

launchd runs the MCP bridge also when it is not in the start at login, so the background application is always `archestra`, at the top of the process chain of the MCP servers that it starts. A macOS permission that an MCP server needs, such as Screen Recording or Accessibility, is one the user gives to `archestra` in System Settings. The MCP bridge does not ask macOS for permissions itself.

### Windows

- `bridge start` stops the MCP bridge that runs first: Windows cannot replace a running `.exe`. It then starts the copy with no console (`DETACHED_PROCESS`).
- The MCP bridge in the background holds `mcp-bridge.lock`. `bridge stop` sets the named event `Local\ArchestraMcpBridgeStop`, which the MCP bridge waits for; it stops its MCP servers, removes its icon and ends. One that does not end in 10 seconds is terminated.
- Each stdio MCP server starts with no console window (`CREATE_NO_WINDOW`) and in a job object that ends all its processes when the MCP server stops, is restarted, or the MCP bridge ends in any way. `npx` starts `cmd.exe`, which starts `node`: the job ends all three.
- At login the `Run` value starts a console program: Windows shows a console window for a moment, until the program closes it.
- The config file gets no mode: the profile folder is readable only by the user and the administrators.

### Linux

- No tray icon and no GUI library. `xdg-open` opens the approval page.
- The systemd unit has the `PATH` of the shell that ran `bridge start`, as the LaunchAgent has, so `npx` from a version manager is found. It has no `Restart=`: a signed-out MCP bridge ends and waits for the user, as on macOS.
- With the XDG autostart, the MCP bridge in the background holds `mcp-bridge.lock`; `bridge stop` sends it SIGTERM.

## Tray menu

```
Archestra MCP bridge: connected
Config: synced 2 minutes ago
---------------------------------
peekaboo: running
MATLAB: starting
---------------------------------
Sync config from Archestra
Open Device tab
Quit
```

The second line has the time of the last good sync of this run. It is `Config: sync failed. Last sync 2 minutes ago` after a sync that failed. When the MCP bridge starts and cannot reach Archestra, the time is `synced_at` of the config file. Quit ends the program; the start at login stays.

## Layout

- `src/main.rs` and `src/cli.rs`: the command line, `archestra <command> <component> [options]`. A new component is one more `Command` variant and a module in the library.
- `src/layout.rs`: the files in the home folder.
- `src/bridge/`: the MCP bridge. `start.rs` and `stop.rs` are its two commands.
- The OS-specific code: `src/bridge/autostart/` (`mod.rs` has the two commands and what the systems share, then one file per OS), `src/bridge/tray/` (macOS, Windows), `src/bridge/instance.rs` (the lock and the stop request, Windows and Linux), `src/bridge/process_tree.rs` (Windows job objects), `src/bridge/command_line.rs` (the split and the `PATHEXT` lookup), `src/bridge/open_url.rs`.

## Release

The program has its own version (`version` in `Cargo.toml`) and its own release track, `archestra-cli-v<version>`. It ships inside the platform image, so it is released and approved with Archestra, but its version moves only when the program changes.

```
PR changes the program   →  PR check: the version must be new
merge to main            →  .github/workflows/build-archestra-cli.yml builds the six files and publishes archestra-cli-v<version>
lock PR (opened by CI)   →  release.lock.json pins the version, the URL and the SHA-256 of each file
platform image build     →  a Dockerfile stage downloads the pinned files, checks each SHA-256, and writes manifest.json
```

- **Change the program:** bump `version` in `Cargo.toml` in the same pull request. The check `.github/scripts/archestra-cli-version-check.py` fails when a file that goes into the binary changed and the version is released already. Changes to `*.md`, `tests/**` and `release.lock.json` need no bump. A new compiler in `platform/rust-toolchain.toml` needs none either: the devices get no update for a program that did not change.
- **The lock file** `release.lock.json` decides what each image serves. A maintainer merges the lock PR. With an empty lock (`"version": null`) the image has no program, and the download answers "not found".
- **In the image** the files are in `/app/archestra-cli/` with `manifest.json` (`{ "version": "…" }`). Archestra reads the version from there and computes each SHA-256 from the file that it serves.
- **Not signed yet.** macOS and Windows builds have no code signature; see the Update section for what follows from that.
- **Stable lines:** nothing builds from a `release/X.Y` branch. A fix reaches a stable line as a release from `main` plus a backport of the lock PR.

## Develop

This crate is its own Cargo workspace. Run the commands in this folder.

```bash
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked          # needs python3 for the test MCP servers
cargo build --release --locked
```

The tests run the client against a mock of the Archestra endpoints and two small MCP servers in `tests/fixtures/` that write, read and list files in a temporary folder (`python` on Windows). The tests of the start at login use a temp home folder and recorders in place of `launchctl`, `systemctl`, the registry and the background process: they never touch the real home folder, launchd, systemd or the registry. The Linux and Windows logic is plain Rust with these recorders, so `cargo test` on macOS runs it too; CI runs the tests on macOS, Linux and Windows.

On Windows x86_64, `aws-lc-sys` needs NASM, or `AWS_LC_SYS_PREBUILT_NASM=1` for its prebuilt objects.

Archestra offers the program in its install command from the folder that `ARCHESTRA_CLI_DIR` names (default `/app/archestra-cli`, where the platform image has it).

With Tilt, the resource `archestra-cli-build` does it at `tilt up` and at each change of the program. It runs `platform/dev/build-archestra-cli-dev.sh`: a release build for this computer, put in `target/dev-clients/` with a `manifest.json` that names the version of `Cargo.toml` with `-dev`. Tilt sets `ARCHESTRA_CLI_DIR` to that folder when `.env` does not set it, so the install command of the local Archestra downloads the program of this checkout. Each build has another SHA-256, so a device that is linked to the local Archestra offers an update after it.

Without Tilt, put the release builds in a folder as `archestra-<system>-<cpu>` and set `ARCHESTRA_CLI_DIR` to that folder. A `manifest.json` with `{ "version": "…" }` in the folder gives the version; without it Archestra knows only the checksums:

| System | Files |
| --- | --- |
| macOS | `archestra-darwin-arm64`, `archestra-darwin-x86_64` |
| Linux | `archestra-linux-x86_64`, `archestra-linux-arm64` |
| Windows | `archestra-windows-x86_64.exe`, `archestra-windows-arm64.exe` |
