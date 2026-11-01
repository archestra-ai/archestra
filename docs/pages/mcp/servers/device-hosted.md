---
title: Device MCP Servers
description: Connect a personal MCP server on your own device to agents and gateways
order: 5
lastUpdated: 2026-11-01
---

A device MCP server lets an agent in Archestra use software running on your laptop. The registry holds the approved launch configuration; each person connects their own device to it.

This source CLI concept is opt-in and does not install a signed desktop app or background service. macOS and Windows use the same connector source; actual Windows execution remains pending validation. The deterministic test server verifies connectivity, not MATLAB installation, licensing, or MATLAB behavior.

## Enable Device Connections

Device connections stay unavailable until your organization enables them.

1. Stop existing personal runtime sessions so new sessions can use scoped credentials.
2. Open **Settings → MCP** with [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update).
3. Turn on **Device MCP servers** and click **Save**.
4. Add a registry entry with **User device** hosting and reviewed launch commands for both operating systems.

Turning the setting off revokes device connections and blocks pairing, device polling, and tool calls. Enabling it again requires fresh pairing. Existing registry entries remain available for review.

## Connect Your Device

Pairing gives your own agent requests a route to your selected device, without opening an inbound port on the laptop.

1. Open the device server in **MCP Registry**.
2. Under **Your device connection**, enter **Device name** and click **Prepare device setup**.
3. Review **Review launch configuration**. On your device, open the `platform` directory in a source checkout with its dependencies installed and choose **Copy with real token** for your operating system and run the copied command.
4. Approve the launch configuration in the connector prompt. Keep the connector running until the page shows **Online**.

The one-time code expires after ten minutes. The connector keeps its credential in memory for up to 24 hours; restarting it requires pairing again. To replace a selected device, check **Replace my selected device and disconnect its existing connector** before preparing another setup.

### Run Without a Source Checkout

Build the connector once, then copy its bundled JavaScript file to a device with Node.js 22 or later.

1. In the source checkout's `platform` directory, build the bundle:

   ```bash
   pnpm --dir backend device-mcp:build
   ```

2. Copy `backend/dist/device-mcp-client.mjs` to the device.
3. Use the URL and one-time code from the copied setup command:

   ```bash
   node device-mcp-client.mjs --url https://deployment.example --code PAIRING_CODE
   ```

The same command runs in macOS Terminal and Windows PowerShell. The bundle is unsigned and runs in the foreground; it does not install a service.

## Use Its Tools

Assign device server tools to agents and MCP gateways through the same tool assignment controls as other registry entries.

- A signed-in person's tool call uses that person's selected device for the registry entry.
- A missing or unavailable personal device produces a setup or reconnect error. Another person's device is never a fallback.
- Scheduled runs cannot use device, built-in, skill or delegated-agent tools while this preview is enabled. They can use assigned external MCP tools. Team, organization and service-account credentials cannot borrow a device connection.
- Interactive runtime credentials are bound to the persisted task and agent. An external client holding your personal gateway token acts as you, including automated clients; pair only while you intend to grant that account access to your device.

The connector launches only the reviewed configuration you approve. A tool call cannot supply a replacement executable or browse an arbitrary filesystem through the connector itself; individual MCP tools retain the access granted by their launch configuration.

## Reconnect or Update

An offline device cannot serve tool calls, and failed calls are not saved for later execution. Calls time out after 30 seconds; an interrupted operation may already have changed the local application. Check that application before retrying.

| What You See | What to Do |
| --- | --- |
| **Finish setup** | Run the displayed connector command before its code expires. |
| **Offline** | Wake the laptop and restore its network connection. A running connector retries after a disconnect. If it exited or the machine restarted, prepare setup again. |
| **Configuration changed** | Prepare setup again and approve the changed launch configuration. Configuration changes do not silently run new commands on your device. |
| **Revoked** | Prepare another setup if you want to connect again. |

Click **Revoke connection** to block new requests to the paired device. Revocation cannot undo an operation already delivered to the MCP server. Closing the connector also stops its supervised MCP process. Startup at login and automatic software installation are outside this concept.
