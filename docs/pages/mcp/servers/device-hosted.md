---
title: Local Devices
description: Connect your computers automatically through the Connect command
order: 5
lastUpdated: 2026-11-02
---

Run Connect once on each computer to keep it connected to your personal account after login. Manage your computers in **Personal Settings → Devices**.

A registry entry defines the reviewed commands and tools. Each person approves an installation on their own computer; another person's computer is never a fallback.

## Enable Local Devices

Devices appear only when your organization enables them.

1. Open **Settings → MCP** with [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update).
2. Turn on **Local devices** and click **Save**.

When disabled, the Devices tab and Connect mention are hidden. Turning the setting off revokes existing device credentials; turning it on again requires running Connect again.

## Add a Computer

Use the Connect terminal command on the computer you want to add. Node.js 22 or newer must remain installed at the path used during setup.

1. Open **Connect**, select your client, and copy its terminal command.
2. Run the command on your computer.
3. Check the terminal code in the browser and approve the setup, including its background agent.
4. Wait for the installer to report that the background agent connected. The computer appears **Online** in Devices.

The installer checks secure credential storage and the service manager before changing client settings. It reports failure if the background agent cannot check in. Running Connect for another client on the same computer reuses the saved device connection.

There is no separate desktop application or connection-file download. **Add device** opens Connect; edit the computer's name afterward by clicking it in Devices.

## Install a Local MCP Server

A connected computer can run MCP installations without a separate desktop application or another terminal process.

1. Create or open a registry entry with **User device** hosting and reviewed launch commands and tool schemas.
2. Under **Your device installation**, click **Install on my computer**.
3. Select your computer, review the command and tools, and approve execution with your user permissions.
4. Click **Install**. The background agent starts the approved MCP; its status becomes **Online**.

Assign its tools to agents or MCP gateways through the usual tool controls, including automatic tool mode. Execution resolves the requesting person's own installation at call time. Team, organization, and service-account credentials cannot borrow a personal installation; scheduled runs remain unsupported in this preview.

If a tool has no usable personal installation, its error includes a link to the registry. The link opens installation setup for the signed-in person. Connect a computer first if none is available, or wake an offline computer and retry the tool call.

The background agent supervises each approved MCP as a separate process. Changing the registry command or tool schemas stops the old approval; review and install the new configuration before it can run. Removing an installation stops its process; revoking the computer blocks all its installations.

Interrupted tool calls are not queued for later execution or replayed after reconnect. A call may already have reached the local application, so inspect its result before retrying a timed-out operation.

## Reconnect Automatically

The background agent starts when you log in and reconnects after sleep or network loss. Closing the terminal does not stop it.

| Operating System | Startup | Credential Storage |
| --- | --- | --- |
| macOS | User LaunchAgent | Keychain |
| Windows | Scheduled task at user login | Current-user DPAPI |
| Linux | systemd user service | Secret Service through `secret-tool` |

Linux requires an active systemd user session, `secret-tool`, and an unlocked Secret Service store. Setup fails if these are unavailable. macOS and Windows also require access to the signed-in user's credential store.

The computer is unavailable while powered off, asleep, disconnected, or logged out. The agent runs with your user permissions. It does not install a privileged system service or make desktop applications available before login.

Device credentials expire after 90 days. Run Connect again after expiry or revocation.

## Manage Your Devices

Click a computer's name to edit it inline. Press Enter to save or Escape to cancel.

Use its menu to **Revoke access**. Revocation removes the device from your list; the background agent clears its saved credential when it learns access was revoked. Revocation cannot remotely remove installed files or startup configuration from an offline computer.

The installer prints commands for local status and uninstall. The installed `agent.cjs` accepts `status`, `start`, `stop`, and `uninstall` through the Node executable printed during setup. Uninstall removes startup configuration and clears the local credential. It also revokes the connection when reachable; otherwise it asks you to revoke the computer in Devices.

Each device belongs to one person in one organization. Another person's device is never a fallback. Service accounts cannot enroll personal devices.
