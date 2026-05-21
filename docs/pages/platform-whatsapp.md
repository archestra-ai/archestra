---
title: WhatsApp
category: Agents
order: 6
description: Connect Archestra agents to WhatsApp via a personal account QR scan
lastUpdated: 2026-05-21
---

Archestra can connect to WhatsApp using a personal account — no WhatsApp Business API or paid plan required. Once linked, incoming 1-on-1 DMs from mapped phone numbers are routed to your configured agent and responses are sent back as WhatsApp messages.

## Prerequisites

- A personal WhatsApp account and the phone it is registered on
- Archestra running with access to persistent storage (session files are saved to disk)

## Setup

Navigate to **Agent Triggers** → **WhatsApp** and follow the two steps:

### Step 1 — Link your WhatsApp account

Click **Enable WhatsApp**. A QR code appears. On your phone, open WhatsApp → Settings → Linked Devices → Link a Device, then scan the QR code. The UI updates to show "WhatsApp connected" once the link is established.

The session is saved to disk so Archestra reconnects automatically on restart without requiring a new QR scan.

### Step 2 — Map phone numbers to users

WhatsApp does not share sender emails. You must manually map each sender's phone number (digits only, no `+` or spaces, e.g. `14155550100`) to their Archestra account email. Only mapped numbers receive agent responses — messages from unmapped numbers are silently dropped.

Add mappings in the **Map phone numbers to users** section. Existing mappings are listed and can be removed individually.

## Agent assignment

Once connected, the **Channels** section appears. Create a DM binding and assign an agent to it. That agent handles all incoming messages from mapped senders.

## Account management

| Action | Effect |
|---|---|
| **Disconnect** | Stops the active connection but keeps session files. Clicking Enable reconnects the same account without a new QR scan. |
| **Switch Account** | Deletes session files and disconnects. The next Enable shows a fresh QR so a different account can be linked. |

If WhatsApp invalidates the session remotely (e.g. the linked device is removed from another phone), Archestra detects this, clears the stale session automatically, and generates a new QR on the next Enable.

## Limitations

- Only 1-on-1 DMs are supported. Group chat messages are ignored.
- Phone→email mappings must be maintained manually. There is no automatic lookup.
- A single WhatsApp account can be linked at a time.
