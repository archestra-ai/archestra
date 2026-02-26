---
title: Slack
category: Agents
order: 6
description: Connect Archestra agents to Slack channels
lastUpdated: 2026-02-23
---

Archestra can connect directly to Slack channels. When users mention the bot in a channel, messages are routed to your configured agent and responses appear directly in Slack threads.

## Prerequisites

- **Slack workspace** with admin permissions to install apps
- **Archestra deployment** — with external webhook access (webhook mode) or outbound internet access (socket mode)

## Connection Modes

Archestra supports two modes for connecting to Slack:

| | Webhook Mode | Socket Mode |
|---|---|---|
| **How it works** | Slack sends events to your public webhook URLs | Archestra opens an outbound WebSocket to Slack |
| **Requires public URL** | Yes | No |
| **Best for** | Production deployments with stable URLs | Local development, firewalled environments, VPN setups |
| **Credentials needed** | Bot Token + Signing Secret + App ID | Bot Token + App-Level Token + App ID |

Choose the mode in the setup wizard (**Agent Triggers** → **Slack** → **Setup Slack**) or via environment variables.

## Setup

### Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Select your workspace, then choose **JSON** and paste the manifest below
3. Click **Create**
4. Go to **Basic Information** → **Display Information** and upload an app icon ([download Archestra logo](/docs/color.png))
5. Go to **Install App** → **Install to Workspace** and authorize
6. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

#### App Manifest

The manifest pre-configures all required scopes, event subscriptions, slash commands, and interactivity settings. The two modes differ only in the `settings` section — the rest is identical.

Pick the manifest for your chosen connection mode:

<details>
<summary><strong>WebSocket mode</strong></summary>

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
    "assistant_view": {
      "assistant_description": "Your AI-powered Archestra assistant"
    },
    "slash_commands": [
      {
        "command": "/archestra-select-agent",
        "description": "Change which agent handles this channel"
      },
      {
        "command": "/archestra-status",
        "description": "Show current agent for this channel"
      },
      {
        "command": "/archestra-help",
        "description": "Show available commands"
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "assistant:write",
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
      "bot_events": [
        "app_mention",
        "assistant_thread_started",
        "assistant_thread_context_changed",
        "message.channels",
        "message.groups",
        "message.im"
      ]
    },
    "interactivity": {
      "is_enabled": true
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

After creating the app, generate an **App-Level Token**:

1. Go to **Basic Information** → **App-Level Tokens**
2. Click **Generate Token and Scopes**
3. Name it (e.g., "archestra-socket") and add the `connections:write` scope
4. Copy the token (starts with `xapp-`)

</details>

<details>
<summary><strong>Webhook mode</strong></summary>

Replace the URLs with your Archestra domain.

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
    "assistant_view": {
      "assistant_description": "Your AI-powered Archestra assistant"
    },
    "slash_commands": [
      {
        "command": "/archestra-select-agent",
        "description": "Change which agent handles this channel",
        "url": "https://your-archestra-domain/api/webhooks/chatops/slack/slash-command"
      },
      {
        "command": "/archestra-status",
        "description": "Show current agent for this channel",
        "url": "https://your-archestra-domain/api/webhooks/chatops/slack/slash-command"
      },
      {
        "command": "/archestra-help",
        "description": "Show available commands",
        "url": "https://your-archestra-domain/api/webhooks/chatops/slack/slash-command"
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "assistant:write",
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
        "assistant_thread_started",
        "assistant_thread_context_changed",
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

</details>

> The setup wizard in Archestra generates this manifest automatically. Go to **Agent Triggers** → **Slack** → **Setup Slack** to use it.

> If updating from a previous manifest, update it in your Slack app settings and **reinstall the app** to your workspace for changes to take effect.

### Configure Archestra

Set the following environment variables. The common variables apply to both modes — then add the mode-specific ones.

```bash
# Common (both modes)
ARCHESTRA_CHATOPS_SLACK_ENABLED=true
ARCHESTRA_CHATOPS_SLACK_BOT_TOKEN=xoxb-your-bot-token
ARCHESTRA_CHATOPS_SLACK_APP_ID=A12345678

# WebSocket mode (default — add these)
ARCHESTRA_CHATOPS_SLACK_APP_LEVEL_TOKEN=xapp-your-app-level-token

# Webhook mode (add these instead)
ARCHESTRA_CHATOPS_SLACK_CONNECTION_MODE=webhook
ARCHESTRA_CHATOPS_SLACK_SIGNING_SECRET=your-signing-secret
```

Finding these values:

- **Bot Token**: OAuth & Permissions page → Bot User OAuth Token
- **App ID**: Basic Information page → App ID
- **Signing Secret** (webhook only): Basic Information page → App Credentials → Signing Secret
- **App-Level Token** (WebSocket only): Basic Information page → App-Level Tokens

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
