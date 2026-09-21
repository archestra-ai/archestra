---
title: Slack
category: Agents
order: 7
description: Connect Archestra agents to Slack channels
lastUpdated: 2026-09-21
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra can connect directly to Slack channels. When users mention the bot in a channel, messages are routed to your configured agent and responses appear directly in Slack threads.

## Prerequisites

- **Slack workspace** with admin permissions to install apps
- **Archestra deployment** — with external webhook access (webhook mode) or outbound internet access (socket mode)

## Connection Modes

Archestra supports two modes for connecting to Slack:

| | Socket Mode (default) | Webhook Mode |
|---|---|---|
| **How it works** | Archestra opens an outbound WebSocket to Slack | Slack sends events to your public webhook URLs |
| **Requires public URL** | No | Yes |
| **Best for** | Local development, firewalled environments, VPN setups | Production deployments with stable URLs |
| **Credentials needed** | Bot Token + App-Level Token + App ID | Bot Token + Signing Secret + App ID |

Choose the mode in the setup wizard (**Settings** → **Messaging Channels** → **Slack** → **Setup Slack**) or via environment variables.

## Setup

The setup wizard in Archestra guides you through the entire Slack configuration. Navigate to **Settings** → **Messaging Channels** → **Slack** → **Setup Slack** and follow the step-by-step instructions.

![Slack Setup Wizard](/docs/setup-slack.webp)

The wizard will walk you through creating a Slack app, installing it to your workspace, and configuring the connection mode. All required credentials are collected and saved automatically.

See [Deployment — Environment Variables](/docs/platform-deployment#environment-variables) for the full list of environment variables if you prefer manual configuration.

## Usage

### First Message

When you **first mention the bot** in a channel:

```
@BotName what's the status of service X?
```

The bot responds with a list of options to choose which agent will handle messages in this channel. After selection, the bot processes your message and **all future messages** in that channel.

### Replying within a thread

In channels the bot stays silent until it is @mentioned. Once mentioned in a thread, it keeps replying to every message in that thread without further mentions. Starting a new thread needs a fresh mention. Direct messages always get a reply, no mention required.

To stop the bot replying in a thread, send `mute` (you can address it by name with no @mention, e.g. `Archestra mute`), or react to any message in the thread with the mute (🔇) or shushing-face (🤫) emoji — the bot's reply or someone else's, whichever is in front of you. It goes quiet until the thread is @mentioned again. Muting also cancels any reply the bot is already working on, so a late answer never lands after you ask for quiet. As a reminder, the bot adds a short hint about this to its first reply in each thread.

### Answering Every Message

By default the bot answers only when @mentioned in a channel. You can make one channel answer every message. Open the assigned agent, select the **Messaging Channels** tab, then select **Settings** on that channel. Turn on **Answer all messages**. Other channels stay mentions-only.

Mute still works per thread: send `mute` in a thread to silence it until you @mention the bot there again. Direct messages already answer every message, so the toggle does not apply to them.

### Channel Instructions

Each channel can carry its own instructions for the agent. Set them from **Settings → Messaging Channels**, or open the agent and select **Settings** on that channel in its **Messaging Channels** tab. Archestra sends these instructions with every message in that channel. Channel instructions take priority over the agent's system prompt.

Channel instructions add to what the agent does. They never take an ability away. Anything they don't mention, the agent handles as usual.

Write them as you would talk to the agent. "Every message in this channel is a task — create it immediately, don't ask for confirmation" is a typical one. Clearing the box removes them.

![The channel instructions editor open on a Slack channel](/docs/automated_screenshots/platform-slack_channel-instructions.webp)

### Commands

Archestra uses native Slack slash commands — type them directly in the message box without mentioning the bot.
The command prefix is generated from the Slack app name in the setup wizard. The default app name uses:

| Command | Description |
|---------|-------------|
| `/archestra-select-agent` | Change which agent handles this channel by default |
| `/archestra-status` | Show currently set default agent for the channel |
| `/archestra-help` | Show available commands |

### Default Agent

Each Slack channel requires a **default agent** to be assigned to it. This agent handles all messages in the channel by default. When you first mention the bot in a channel without a binding, you'll be prompted to select an agent from a dropdown.

To change default assignments, open an agent, select the **Messaging Channels** tab, then select **Add channel**. The picker names the agent that answers a channel before you claim it.

![Slack Agent Selection](/docs/select-agent-slack.webp)

Once set, the default agent processes all subsequent messages in that channel. You can also use the `/archestra-select-agent` command directly in Slack to change the default agent.

### Switching Agents Inline

You can temporarily use a different agent for a single message by using the `AgentName >` syntax:

```
@BotName Sales > what's our Q4 pipeline?
```

This routes the message to the "Sales" agent instead of the channel's default agent. The default binding remains unchanged—only this specific message uses the alternate agent.

**Matching rules:**
- Agent names are matched case-insensitively
- Spaces in agent names are optional: `AgentPeter >` matches "Agent Peter"
- If the agent name isn't found, the message falls back to the default agent with a notice

**Examples:**

| Message | Routed To |
|---------|-----------|
| `@BotName hello` | Default agent |
| `@BotName Sales > check revenue` | Sales agent |
| `@BotName support > help me` | Support agent |
| `@BotName Unknown > test` | Default agent (with fallback notice) |

### Direct Messages

A DM with the bot behaves just like another channel — each user can choose which agent handles their DMs. On your first message, the bot shows an agent selection card. Use `/archestra-select-agent` to change it later.

> The Slack app manifest already includes `im:history` and `message.im` scopes/events required for DMs.

## Autoprovisioning Slack Users

When a user interacts with the bot but hasn't signed up in Archestra yet, they are automatically provisioned with the **Member** role and no teams assigned. The user receives a unique invitation link via Slack DM that they can use to complete sign-up and become a full Archestra user. Until they do, they cannot log in to the Archestra web app.

Admins can view autoprovisioned users on the **Settings → Users** page — from there they can copy the invitation link or delete the user.

![Autoprovisioned Slack Users](/docs/autoprovisioned-users-slack.webp)

## Attachments

Messages sent to the bot can include file attachments (images, PDFs, documents, etc.). Attachments are automatically downloaded and passed to the agent for processing. Files the selected model can read — images, PDFs, and text documents such as CSV, TSV, JSON, XML, YAML, TOML, and Markdown — are included inline in the agent's context. When the agent has a code sandbox, other file types (for example a SQLite database or a ZIP archive) are placed into the sandbox so the agent can open them with its tools. Anything that still cannot be provided is noted by name so the agent can tell the user. A message that contains only a file (no text) is processed too.

### Files In Threads

Agents can return original attachments or generated files in the current channel thread. Enable **Post Thread File** in the agent's tools. Slack stores the uploaded file; no public file host is needed.

For example, attach a product photo and ask the agent to crop it for a draft. Generated documents and spreadsheets use the same upload flow. Creating or editing files requires a code sandbox. Returning an unchanged attachment does not.

References to original attachments and generated files last only for the current agent execution. Later messages fetch attachments again from Slack or regenerate outputs. Slack sandbox uploads and exports bypass persistent file storage. Persistent file-writing tools are unavailable in Slack executions. Uploads remain subject to tool policies and the agent's network restrictions. Policies requiring approval block file delivery in this version.

Temporary application buffers are released when execution ends, with a one-hour expiry as a fallback. An upload already in progress may finish after that point. Dagger runtime copies follow its cache eviction policy and may outlive the execution. Slack keeps delivered files under its own retention policy. Structured inline file bodies are omitted from Slack interaction logs. Text extracted from files and ordinary tool output still follow the configured log retention.

Delivery supports channel threads, including private channels the bot can access. Direct-message delivery and sending to other channels are not supported. This does not provide a public media URL for services such as Buffer.

See the [tool reference](/docs/platform-archestra-mcp-server#chatops) for supported formats and delivery controls.

**Incoming Attachment Limits:**
- Max 20 attachments per message
- Max 10 MiB per non-image file
- Max 20 MiB per image
- Max 25 MiB total across all attachments in a single message

Outgoing files can be up to 20 MiB each.

The agent receives a notice when an attachment cannot be provided. Large images may use smaller model previews while retaining their original bytes for the current execution.

## Troubleshooting

**Bot not responding**
- Webhook mode: check webhook URL is accessible externally
- Socket mode: check backend logs for "Socket mode connected" message
- Confirm the bot is added to the channel

**"Request verification failed" (webhook mode)**
- Check that the signing secret matches the value on the Basic Information page
- Ensure server clock is synchronized (Slack rejects requests with clock skew)

**Socket mode disconnects**
- Verify the App-Level Token is valid and has the `connections:write` scope
- Check that the Archestra backend has outbound internet access
- The socket mode client auto-reconnects — check backend logs for reconnection attempts

**Missing channels**
- The bot must be invited to the channel first: `/invite @BotName`

**"Could not verify your identity"**
- Ensure `users:read` and `users:read.email` scopes are configured under OAuth & Permissions. Reinstall the app after updating scopes.

**"Slack is configured for Socket Mode" error on webhooks**
- This means Slack is configured to use socket mode but events are arriving via webhooks. Check that your Slack app has `socket_mode_enabled: true` in its settings, or switch Archestra to webhook mode.
