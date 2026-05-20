---
title: WhatsApp
category: Agents
order: 6
description: Connect Archestra agents to WhatsApp through the Cloud API
lastUpdated: 2026-05-20
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

Archestra can receive WhatsApp Cloud API messages, route them to a configured agent, and send the agent response back through WhatsApp.

## Prerequisites

- **Meta Business portfolio** with a WhatsApp Business Account
- **WhatsApp Cloud API phone number** with access to the Messages webhook
- **System User access token** that can send messages for the phone number
- **Archestra deployment** with external webhook access
- **Phone-to-email mappings** for every WhatsApp sender allowed to use agents

## Setup

Open **Agent Triggers** -> **WhatsApp** -> **Setup WhatsApp**.

In Meta, configure the callback URL shown in the setup wizard:

```
https://your-archestra-host/api/webhooks/chatops/whatsapp
```

Use the same verify token in Meta and in Archestra. Subscribe the app to the `messages` webhook field, then save the Cloud API credentials in Archestra.

## User Identity

WhatsApp webhook payloads identify senders by phone number, not email. Archestra only processes a WhatsApp message after the sender phone is explicitly mapped to an Archestra user email.

Add one mapping per line:

```
+15551234567=user@example.com
```

Phone matching ignores punctuation and spaces, so `+1 (555) 123-4567` and `15551234567` match the same sender.

## Usage

After setup, send a WhatsApp message to the connected business phone number. If no default agent is assigned yet, Archestra creates an unassigned WhatsApp direct-message binding. Assign an agent from **Agent Triggers** -> **WhatsApp**.

Once assigned, new messages from that phone number are routed to the selected agent.

## Environment Variables

You can seed the WhatsApp configuration on first startup:

```bash
ARCHESTRA_CHATOPS_WHATSAPP_ENABLED=true
ARCHESTRA_CHATOPS_WHATSAPP_ACCESS_TOKEN=...
ARCHESTRA_CHATOPS_WHATSAPP_APP_SECRET=...
ARCHESTRA_CHATOPS_WHATSAPP_BUSINESS_ACCOUNT_ID=...
ARCHESTRA_CHATOPS_WHATSAPP_GRAPH_API_VERSION=v21.0
ARCHESTRA_CHATOPS_WHATSAPP_PHONE_NUMBER_ID=...
ARCHESTRA_CHATOPS_WHATSAPP_VERIFY_TOKEN=...
ARCHESTRA_CHATOPS_WHATSAPP_PHONE_USER_MAPPINGS='[{"phoneNumber":"+15551234567","email":"user@example.com"}]'
```

Existing database configuration is not overwritten by environment variables.

## Troubleshooting

**Webhook verification fails**
- Confirm Meta and Archestra use the same verify token
- Confirm the callback URL is publicly reachable

**Request signature is rejected**
- Confirm the App Secret matches the Meta app sending the webhook
- Confirm any proxy forwards the original request body unchanged

**Message is received but the bot refuses to answer**
- Add a phone-to-email mapping for the sender
- Confirm the mapped Archestra user has access to the assigned agent

**No agent responds**
- Assign a default agent to the WhatsApp binding in **Agent Triggers** -> **WhatsApp**
