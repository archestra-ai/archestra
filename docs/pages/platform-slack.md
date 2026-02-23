---
title: Slack
category: Agents
order: 6
description: Connect Archestra agents to Slack channels
lastUpdated: 2026-02-20
---

Archestra can connect directly to Slack channels. When users mention the bot in a channel, messages are routed to your configured agent and responses appear directly in Slack threads.

## Prerequisites

- **Slack workspace** with admin permissions to install apps
- **Archestra deployment** with external webhook access

## Setup

### Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Select your workspace, then choose **JSON** and paste the manifest below
3. Click **Create**
4. Go to **Basic Information** → **Display Information** and upload an app icon ([download Archestra logo](/docs/color.png))
5. Go to **Install App** → **Install to Workspace** and authorize
6. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

#### App Manifest

The manifest pre-configures all required scopes, event subscriptions, and interactivity settings. Replace the two URLs with your Archestra domain.

```json
{
  "display_information": {
    "name": "Archestra",
    "description": "Archestra AI Agent"
  },
  "features": {
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "Archestra",
      "always_online": true
    },
    "slash_commands": [
      {
        "command": "/archestra-select-agent",
        "description": "Change which agent handles this channel",
        "usage_hint": "/archestra-select-agent",
        "url": "https://your-archestra-domain/api/webhooks/chatops/slack/slash-command"
      },
      {
        "command": "/archestra-status",
        "description": "Show current agent for this channel",
        "usage_hint": "/archestra-status",
        "url": "https://your-archestra-domain/api/webhooks/chatops/slack/slash-command"
      },
      {
        "command": "/archestra-help",
        "description": "Show available commands",
        "usage_hint": "/archestra-help",
        "url": "https://your-archestra-domain/api/webhooks/chatops/slack/slash-command"
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "commands",
        "app_mentions:read",
        "channels:history",
        "channels:read",
        "chat:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "users:read",
        "users:read.email"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://your-archestra-domain/api/webhooks/chatops/slack",
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im"
      ]
    },
    "interactivity": {
      "is_enabled": true,
      "request_url": "https://your-archestra-domain/api/webhooks/chatops/slack/interactive"
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

> The setup wizard in Archestra generates this manifest with your webhook URLs pre-filled. Go to **Agent Triggers** → **Slack** → **Setup Slack** to use it.

> If updating from a previous manifest (before slash commands), update the manifest in your Slack app settings and **reinstall the app** to your workspace for the new slash commands to take effect.

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

## Usage

### First Message

When you **first mention the bot** in a channel:

```
@BotName what's the status of service X?
```

The bot responds with a list of options to choose which agent will handle messages in this channel. After selection, the bot processes your message and **all future messages** in that channel.

### Commands

Archestra uses native Slack slash commands — type them directly in the message box without mentioning the bot.

| Command | Description |
|---------|-------------|
| `/archestra-select-agent` | Change which agent handles this channel by default |
| `/archestra-status` | Show currently set default agent for the channel |
| `/archestra-help` | Show available commands |

### Default Agent

Each Slack channel requires a **default agent** to be bound to it. This agent handles all messages in the channel by default. When you first mention the bot in a channel without a binding, you'll be prompted to select an agent from a dropdown.

Once set, the default agent processes all subsequent messages in that channel until you change it with `/archestra-select-agent`.

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

DMs work the same as channels. In the **Agent Triggers** → **Slack** page, click **Start DM** in the channels section to open a Slack DM with the bot. On your first message, the bot shows an agent selection card — pick an agent and the DM is bound. Use `/archestra-select-agent` to change it later.

> The Slack app manifest already includes `im:history` and `message.im` scopes/events required for DMs.

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
