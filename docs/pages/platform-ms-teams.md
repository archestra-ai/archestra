---
title: MS Teams
category: Archestra Platform
order: 8
description: Connect Archestra agents to Microsoft Teams channels
lastUpdated: 2026-02-05
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

Archestra can connect directly to Microsoft Teams channels. When users mention the bot in a channel, messages are routed to your configured agent and responses appear directly in Teams.

## Prerequisites

- **Azure subscription** with permissions to create Azure Bot resources
- **Teams tenant** where you can install custom apps
- **Archestra deployment** with external webhook access

## Setup

### Create Azure Bot

1. Go to [portal.azure.com](https://portal.azure.com) → **Create a resource** → **Azure Bot**
2. Fill in **bot handle**, **subscription**, **resource group**
3. Under **Type of App**, choose either:
   - **Multi Tenant** (default) — bot can be used by any Azure AD tenant
   - **Single Tenant** — bot restricted to your organization only
4. Under **Microsoft App ID**, select **Create new Microsoft App ID** — this automatically creates an App Registration in Azure AD that provides the bot's identity (App ID and Secret). No API permissions need to be added to this App Registration.
5. After creation, go to **Settings** → **Configuration**
6. Copy the **Microsoft App ID** — you'll need this for `ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID`
7. If using **Single Tenant**, note your **Azure AD Tenant ID** (find in Azure AD → Overview) — you'll need this for `ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID`
8. Click **Manage Password** (opens the App Registration) → **New client secret** → copy the secret value for `ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET`
9. Set **Messaging endpoint** to `https://your-archestra-domain/api/webhooks/chatops/ms-teams`
10. Go to **Channels** → add **Microsoft Teams**

### Configure Archestra

Set these environment variables:

```bash
# Required
ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED=true
ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID=<Microsoft App ID>
ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET=<Client Secret>

# Optional - for single-tenant Azure Bot (leave empty for multi-tenant)
ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID=<Azure AD Tenant ID>
```

Then enable Agent for MS Teams:

1. In Archestra, go to **Chat** → open the **Agent Library**
2. **Edit** the agent you want to use with Teams
3. Under **Integrations**, check **Microsoft Teams**
4. **Save**

Only agents with **Microsoft Teams enabled** will appear in the channel selection dropdown.

### Teams App Manifest

Create a folder with **[color.png](/docs/color.png)** (192x192), **[outline.png](/docs/outline.png)** (32x32) and **`manifest.json`**:

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
  "validDomains": [],
  "webApplicationInfo": {
    "id": "{{BOT_MS_APP_ID}}",
    "resource": "https://graph.microsoft.com"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        {
          "name": "ChannelMessage.Read.Group",
          "type": "Application"
        },
        {
          "name": "ChatMessage.Read.Chat",
          "type": "Application"
        }
      ]
    }
  }
}
```

Replace `{{BOT_MS_APP_ID}}` with your **Microsoft App ID**. **Zip the folder contents**.

> **No Azure AD API permissions are required.** User identity is verified automatically via the Bot Framework. Thread history uses **RSC (Resource-Specific Consent)** permissions declared in the manifest above — these are **scoped to where the bot is installed** and require only **team owner consent** (no tenant admin).
>
> **Alternative:** If you cannot use RSC (e.g., older Teams clients), you can use Azure AD application permissions for thread history instead. In Azure Portal, go to **App registrations** → find your bot's app → **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions** and add: `ChannelMessage.Read.All`, `Chat.Read.All`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`. Grant admin consent for all permissions. Configure the `ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_*` env vars (can point to the same App Registration the bot uses). This approach requires **tenant admin consent**, grants **tenant-wide access**, and the `authorization` section in the manifest is redundant.

### Install in Teams

1. In Teams: **Apps** → **Manage your apps** → **Upload an app**
2. Select your **manifest zip**
3. **Add the app** to a team/channel

## Usage

### First Message

When you **first mention the bot** in a channel with no binding:

```
@Archestra what's the status of service X?
```

The bot responds with an **Adaptive Card dropdown** to select which agent handles this channel. After selection, the bot processes your message and **all future messages** in that channel.

### Commands

| Command | Description |
|---------|-------------|
| `@Archestra /select-agent` | Change which agent handles this channel by default |
| `@Archestra /status` | Show currently set default agent for the channel |
| `@Archestra /help` | Show available commands |

### Default Agent

Each Teams channel requires a **default agent** to be bound to it. This agent handles all messages in the channel by default. When you first mention the bot in a channel without a binding, you'll be prompted to select an agent from a dropdown.

Once set, the default agent processes all subsequent messages in that channel until you change it with `/select-agent`.

### Switching Agents Inline

You can temporarily use a different agent for a single message by using the `AgentName >` syntax:

```
@Archestra Sales > what's our Q4 pipeline?
```

This routes the message to the "Sales" agent instead of the channel's default agent. The default binding remains unchanged—only this specific message uses the alternate agent.

**Matching rules:**
- Agent names are matched case-insensitively
- Spaces in agent names are optional: `AgentPeter >` matches "Agent Peter"
- If the agent name isn't found, the message falls back to the default agent with a notice

**Examples:**

| Message | Routed To |
|---------|-----------|
| `@Archestra hello` | Default agent |
| `@Archestra Sales > check revenue` | Sales agent |
| `@Archestra support > help me` | Support agent |
| `@Archestra Unknown > test` | Default agent (with fallback notice) |

## Troubleshooting

**"You don't have access to this app"**
- Your org may have disabled custom app uploads
- Ask IT to enable sideloading in [Teams Admin Center](https://admin.teams.microsoft.com/)

**Bot not responding**
- Verify `ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED=true`
- Check webhook URL is accessible externally
- Verify App ID and Password are correct

**No thread history**
- Ensure `authorization.permissions.resourceSpecific` with `ChannelMessage.Read.Group` and `ChatMessage.Read.Chat` is in your Teams app manifest. Reinstall the app after updating the manifest. The team owner must consent to the permissions when adding the app.
