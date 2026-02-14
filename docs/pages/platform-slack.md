---
title: Slack
category: Agents
order: 6
description: Connect Archestra agents to Slack channels
lastUpdated: 2026-02-14
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

Archestra can connect directly to Slack channels. When users mention the bot in a channel, messages are routed to your configured agent and responses appear directly in Slack threads.

## Prerequisites

- **Slack workspace** with admin permissions to install apps
- **Archestra deployment** with external webhook access

## Setup

### Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Under **OAuth & Permissions**, add these **Bot Token Scopes**:
   - `app_mentions:read`
   - `channels:history`
   - `channels:read`
   - `chat:write`
   - `groups:history`
   - `groups:read`
   - `im:history`
   - `im:read`
   - `users:read`
   - `users:read.email`
3. Under **Event Subscriptions**, enable events and set **Request URL** to `https://your-archestra-domain/api/webhooks/chatops/slack`
4. Subscribe to these **bot events**:
   - `app_mention`
   - `message.channels`
   - `message.groups`
   - `message.im`
5. Under **Interactivity & Shortcuts**, enable interactivity and set **Request URL** to `https://your-archestra-domain/api/webhooks/chatops/slack/interactive`
6. **Install to Workspace** and copy the **Bot User OAuth Token**

### Configure Archestra

Set these environment variables:

```bash
# Required
ARCHESTRA_CHATOPS_SLACK_ENABLED=true
ARCHESTRA_CHATOPS_SLACK_BOT_TOKEN=xoxb-your-bot-token
ARCHESTRA_CHATOPS_SLACK_SIGNING_SECRET=your-signing-secret
ARCHESTRA_CHATOPS_SLACK_APP_ID=A12345678
```

Finding these values:

- **Bot Token**: OAuth & Permissions page → Bot User OAuth Token
- **Signing Secret**: Basic Information page → App Credentials → Signing Secret
- **App ID**: Basic Information page → App ID

Then enable Agent for Slack:

1. In Archestra, go to **Chat** → open the **Agent Library**
2. **Edit** the agent you want to use with Slack
3. Under **Integrations**, check **Slack**
4. **Save**

Only agents with **Slack enabled** will appear in the channel selection dropdown.

## Usage

### First Message

When you **first mention the bot** in a channel with no binding:

```
@BotName what's the status of service X?
```

The bot responds with a **dropdown** to select which agent handles this channel. After selection, the bot processes your message and **all future messages** in that channel.

### Commands

| Command | Description |
|---------|-------------|
| `@BotName /select-agent` | Change which agent handles this channel by default |
| `@BotName /status` | Show currently set default agent for the channel |
| `@BotName /help` | Show available commands |

### Default Agent

Each Slack channel requires a **default agent** to be bound to it. This agent handles all messages in the channel by default. When you first mention the bot in a channel without a binding, you'll be prompted to select an agent from a dropdown.

Once set, the default agent processes all subsequent messages in that channel until you change it with `/select-agent`.

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

## Troubleshooting

**Bot not responding**
- Verify `ARCHESTRA_CHATOPS_SLACK_ENABLED=true`
- Check webhook URL is accessible externally
- Confirm the bot is added to the channel

**"Request verification failed"**
- Check that the signing secret matches the value on the Basic Information page
- Ensure server clock is synchronized (Slack rejects requests with clock skew)

**Missing channels**
- The bot must be invited to the channel first: `/invite @BotName`

**"Could not verify your identity"**
- Ensure `users:read` and `users:read.email` scopes are configured under OAuth & Permissions. Reinstall the app after updating scopes.
