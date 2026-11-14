---
title: Archestra CLI
description: The archestra program on your device, with the commands that start, stop, update, and remove the MCP bridge
order: 6
alpha: true
lastUpdated: 2026-11-13
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

`archestra` is the program that links your device to Archestra. It runs the MCP bridge, which starts [desktop MCP servers](/docs/mcp/servers/desktop) on your device for your agents. The setup gives you a command for macOS and Linux, and one for Windows.

## Install

You do not download it by hand: Archestra gives you a command made for your account. See [Link Your Device](/docs/mcp/servers/desktop#link-your-device).

The first start on a device does three things:

- It links the device to your account, after you approve it in Archestra.
- It puts the `archestra` command on your `PATH`. Open a new terminal to use it.
- It turns auto-start on, so the MCP bridge starts each time you log in.

## Commands

Every command acts on your own device. Add `--help` to any of them for details.

| Command | What it does |
| --- | --- |
| `archestra bridge start` | Starts the MCP bridge in the background. |
| `archestra bridge stop` | Stops the MCP bridge. With auto-start on, it starts again at the next login. |
| `archestra bridge status` | Shows if the MCP bridge runs, the state of each MCP server, the version, and where the log file is. |
| `archestra bridge enable-auto-start` | Starts the MCP bridge at each login. It does not start it now. |
| `archestra bridge disable-auto-start` | Stops starting the MCP bridge at each login. It does not stop it now. |
| `archestra update` | Gets the version that your Archestra offers, and starts the MCP bridge again with it. |
| `archestra uninstall` | Removes the program and the MCP bridge from your device. |

`archestra bridge start` takes these options:

| Option | What it does |
| --- | --- |
| `--url <url>` | The address of your Archestra. Needed for the first start only. |
| `--config <path>` | Another config file than `~/.archestra/mcp-bridge/config.yaml`. |
| `--foreground` | Runs the MCP bridge in this terminal. Stop it with Ctrl-C. |
| `--no-open` | Prints the approval link, and does not open the browser. |

## Update

The program follows the Archestra it is linked to. When your Archestra offers another version, **Personal Settings → Device** and `archestra bridge status` say so.

- **macOS and Linux:** run `archestra update`.
- **Windows:** the MCP bridge updates by itself when no tool call is running. To update at once, run `archestra update`.

## Uninstall

`archestra uninstall` stops the MCP bridge, unlinks the device from your account, deletes the program and its files, and takes `archestra` off your `PATH`. Your MCP servers and other programs stay.

To unlink a device you no longer have, go to **Personal Settings → Device**, and click **Unlink device** next to it.

## Files

Everything is in `~/.archestra`. On Windows, `~` is `%USERPROFILE%`.

| File | What it holds |
| --- | --- |
| `~/.archestra/bin/archestra` | The program. |
| `~/.archestra/mcp-bridge/config.yaml` | The key of your device and the servers you connected. Archestra rewrites it, so do not edit it. |
| `~/.archestra/mcp-bridge/mcp-bridge.log` | The log of the MCP bridge, with the errors your MCP servers print. |
