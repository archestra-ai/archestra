---
title: "ChatOps: Microsoft Teams"
category: "Integrations"
order: 10
description: "Connect Microsoft Teams channels directly to Archestra agents"
lastUpdated: "2025-01-16"
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document covers the integrated MS Teams ChatOps feature where Archestra handles the bot directly.
For the standalone bot approach using A2A, see platform-example-teams-a2a.md
-->

Archestra can connect directly to Microsoft Teams channels without requiring a separate bot server. When users mention the bot in a channel, messages are routed to your configured agent, and responses appear directly in Teams.

## Prerequisites

- Azure subscription with permissions to create Azure Bot resources
- Teams tenant where you can install custom apps
- Archestra deployment with external webhook access

## Setup Overview

1. Create Azure Bot in Azure Portal
2. Configure Archestra with bot credentials
3. Enable Teams integration on your agent
4. Install the Teams app and mention the bot in a channel
5. Select which agent handles the channel (via Adaptive Card)

## Create Azure Bot

1. Go to [portal.azure.com](https://portal.azure.com) > **Create a resource** > **Azure Bot**
2. Fill in bot handle, subscription, resource group
3. Under **Microsoft App ID**, select **Create new Microsoft App ID**
4. After creation, go to **Settings** > **Configuration**
5. Copy the **Microsoft App ID**
6. Click **Manage Password** > **New client secret** > copy the secret value
7. Set **Messaging endpoint** to `https://your-archestra-domain/api/webhooks/chatops/ms-teams`
8. Go to **Channels** > add **Microsoft Teams**

### Graph API Permissions (Optional - for thread history)

To include thread history in agent context:

1. In Azure Portal, go to **App registrations** > find your bot's app
2. Go to **API permissions** > **Add a permission** > **Microsoft Graph** > **Application permissions**
3. Add `ChannelMessage.Read.All`
4. Click **Grant admin consent**

## Configure Archestra

Set these environment variables:

```bash
# Required
ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED=true
ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID=<Microsoft App ID>
ARCHESTRA_CHATOPS_MS_TEAMS_APP_PASSWORD=<Client Secret>

# Optional - for thread history (requires Graph API permissions)
ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_TENANT_ID=<Azure AD Tenant ID>
ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_ID=<App Registration Client ID>
ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_SECRET=<App Registration Secret>
```

## Enable Agent for Teams

1. In Archestra, go to **Profiles** (Agents)
2. Edit the agent you want to use with Teams
3. Under **ChatOps Integrations**, check **Microsoft Teams**
4. Save

Only agents with Microsoft Teams enabled will appear in the channel selection dropdown.

## Teams App Manifest

Create a folder with [color.png](/docs/color.png) (192x192), [outline.png](/docs/outline.png) (32x32) and `manifest.json`:

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
  "manifestVersion": "1.16",
  "version": "1.0.0",
  "id": "{{BOT_MS_APP_ID}}",
  "packageName": "com.archestra.bot",
  "developer": {
    "name": "Your Company",
    "websiteUrl": "https://archestra.ai",
    "privacyUrl": "https://archestra.ai/privacy",
    "termsOfUseUrl": "https://archestra.ai/terms"
  },
  "name": { "short": "Archestra", "full": "Archestra Bot" },
  "description": { "short": "Ask Archestra", "full": "Chat with Archestra agents" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#FFFFFF",
  "bots": [
    {
      "botId": "{{BOT_MS_APP_ID}}",
      "scopes": ["team", "groupchat"],
      "supportsFiles": false,
      "isNotificationOnly": false,
      "commandLists": [
        {
          "scopes": ["team", "groupchat"],
          "commands": [
            { "title": "select-agent", "description": "Change which agent handles this channel" },
            { "title": "status", "description": "Show current agent for this channel" },
            { "title": "help", "description": "Show available commands" }
          ]
        }
      ]
    }
  ],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": []
}
```

Replace `{{BOT_MS_APP_ID}}` with your Microsoft App ID. Zip the folder contents.

## Install in Teams

1. In Teams: **Apps** > **Manage your apps** > **Upload an app**
2. Select your manifest zip
3. Add the app to a team/channel

## Usage

### First Message

When you first mention the bot in a channel with no binding:

```
@Archestra what's the status of service X?
```

The bot responds with an Adaptive Card dropdown to select which agent handles this channel. After selection, the bot processes your message and all future messages in that channel.

### Commands

| Command | Description |
|---------|-------------|
| `@Archestra /select-agent` | Change which agent handles this channel |
| `@Archestra /status` | Show current agent binding |
| `@Archestra /help` | Show available commands |

### Trigger Patterns

- **mention** (default): Bot only responds when @mentioned
- **all**: Bot responds to all messages in the channel

Configure via the Adaptive Card when selecting an agent.

## Architecture

- Single Azure Bot shared across your deployment
- Channel bindings stored in Archestra database
- Messages validated via Bot Framework JWT verification
- Thread history fetched via Microsoft Graph API (if configured)
- Responses sent via Bot Framework SDK

## Troubleshooting

**"You don't have access to this app"**
- Your org may have disabled custom app uploads
- Ask IT to enable sideloading in [Teams Admin Center](https://admin.teams.microsoft.com/)

**Bot not responding**
- Verify `ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED=true`
- Check webhook URL is accessible externally
- Verify App ID and Password are correct

**No thread history**
- Ensure Graph API credentials are configured
- Verify `ChannelMessage.Read.All` permission is granted
- Admin consent must be granted for the permission

## Alternative: Standalone Bot

For more control or custom logic, you can build your own bot that connects to Archestra via A2A protocol. See [Connect Agent to MS Teams](/docs/platform-example-teams-a2a) for the standalone approach.
