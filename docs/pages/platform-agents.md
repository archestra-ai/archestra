---
title: Agents
category: Archestra Platform
subcategory: Concepts
order: 1
description: Agent invocation methods including A2A, incoming email, and ChatOps
lastUpdated: 2026-01-17
---

Agents in Archestra are invoked through Prompts. While the primary method is via the [Chat](/docs/platform-chat) interface or [API](/docs/platform-api-reference), agents can also be triggered through alternative channels like A2A (Agent-to-Agent), incoming email, and ChatOps integrations.

## A2A (Agent-to-Agent)

A2A is a JSON-RPC 2.0 gateway that allows external systems to invoke agents programmatically. Each Prompt exposes two endpoints:

- **Agent Card Discovery**: `GET /v1/a2a/:promptId/.well-known/agent.json`
- **Message Execution**: `POST /v1/a2a/:promptId`

### Authentication

All A2A requests require Bearer token authentication. Generate tokens via the Profile's API key settings or use team tokens for organization-wide access.

### Agent Card

The discovery endpoint returns an AgentCard describing the agent's capabilities:

```json
{
  "name": "My Agent",
  "description": "Agent description from prompt",
  "version": "1.0.0",
  "capabilities": {
    "streaming": false,
    "pushNotifications": false
  },
  "defaultInputModes": ["text"],
  "defaultOutputModes": ["text"],
  "skills": [{ "id": "default", "name": "Default Skill" }]
}
```

### Sending Messages

Send JSON-RPC 2.0 requests to execute the agent:

```bash
curl -X POST "https://api.example.com/v1/a2a/<promptId>" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "message/send",
    "params": {
      "message": {
        "parts": [{ "kind": "text", "text": "Hello agent!" }]
      }
    }
  }'
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "messageId": "msg-...",
    "role": "agent",
    "parts": [{ "kind": "text", "text": "Agent response..." }]
  }
}
```

### Delegation Chain

A2A supports nested agent-to-agent calls. When one agent invokes another, the delegation chain tracks the call path for observability. This enables multi-step agent workflows where agents can use other agents as tools.

### Configuration

A2A uses the same LLM configuration as Chat. See [Deployment - Environment Variables](/docs/platform-deployment#environment-variables) for the full list of `ARCHESTRA_CHAT_*` variables.

## Incoming Email

Incoming Email allows external users to invoke agents by sending emails to auto-generated addresses. Each Prompt gets a unique email address using plus-addressing (e.g., `mailbox+agent-<promptId>@domain.com`).

When an email arrives:

1. Microsoft Graph sends a webhook notification to Archestra
2. Archestra extracts the Prompt ID from the recipient address
3. The email body becomes the agent's input message
4. The agent executes and generates a response
5. Optionally, the agent's response is sent back as an email reply

### Conversation History

When processing emails that are part of a thread (replies), Archestra automatically fetches the conversation history and provides it to the agent. This allows the agent to understand the full context of the conversation and respond appropriately to follow-up messages.

### Email Reply

When email replies are enabled, the agent's response is automatically sent back to the original sender. The reply:

- Maintains the email conversation thread
- Uses the original message's "Re:" subject prefix
- Displays the agent's name as the sender

### Prerequisites

- Microsoft 365 mailbox (Exchange Online)
- Azure AD application with `Mail.Read` application permission
- Publicly accessible webhook URL

### Azure AD Application Setup

1. Create an App Registration in [Azure Portal](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Add the following **application** permissions (not delegated) under Microsoft Graph:
   - `Mail.Read` - Required for receiving emails
   - `Mail.Send` - Required for sending reply emails (optional)
3. Grant admin consent for the permissions
4. Create a client secret and note the value

### Configuration

Set these environment variables (see [Deployment](/docs/platform-deployment#incoming-email-configuration) for details):

```bash
ARCHESTRA_AGENTS_INCOMING_EMAIL_PROVIDER=outlook
ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_TENANT_ID=<tenant-id>
ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_CLIENT_ID=<client-id>
ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_CLIENT_SECRET=<client-secret>
ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_MAILBOX_ADDRESS=agents@yourcompany.com
```

### Webhook Setup

**Option 1: Automatic** - Set `ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_WEBHOOK_URL` and the subscription is created on server startup.

**Option 2: Manual** - Navigate to Settings > Incoming Email and enter your webhook URL.

Microsoft Graph subscriptions expire after 3 days. Archestra automatically renews subscriptions before expiration.

### Email Address Format

Agent email addresses follow the pattern:

```
<mailbox-local>+agent-<promptId>@<domain>
```

For example, if your mailbox is `agents@company.com` and your Prompt ID is `abc12345-6789-...`, emails sent to:

```
agents+agent-abc123456789...@company.com
```

will invoke that specific agent.

## ChatOps: Microsoft Teams

Archestra can connect directly to Microsoft Teams channels without requiring a separate bot server. When users mention the bot in a channel, messages are routed to your configured agent, and responses appear directly in Teams.

### Prerequisites

- Azure subscription with permissions to create Azure Bot resources
- Teams tenant where you can install custom apps
- Archestra deployment with external webhook access

### Setup Overview

1. Create Azure Bot in Azure Portal
2. Configure Archestra with bot credentials
3. Enable Teams integration on your agent
4. Install the Teams app and mention the bot in a channel
5. Select which agent handles the channel (via Adaptive Card)

### Create Azure Bot

1. Go to [portal.azure.com](https://portal.azure.com) > **Create a resource** > **Azure Bot**
2. Fill in bot handle, subscription, resource group
3. Under **Microsoft App ID**, select **Create new Microsoft App ID**
4. After creation, go to **Settings** > **Configuration**
5. Copy the **Microsoft App ID**
6. Click **Manage Password** > **New client secret** > copy the secret value
7. Set **Messaging endpoint** to `https://your-archestra-domain/api/webhooks/chatops/ms-teams`
8. Go to **Channels** > add **Microsoft Teams**

#### Graph API Permissions (Optional - for thread history)

To include thread history in agent context:

1. In Azure Portal, go to **App registrations** > find your bot's app
2. Go to **API permissions** > **Add a permission** > **Microsoft Graph** > **Application permissions**
3. Add `ChannelMessage.Read.All`
4. Click **Grant admin consent**

### Configuration

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

### Enable Agent for Teams

1. In Archestra, go to **Chat** and open the **Agent Library**
2. Edit the agent you want to use with Teams
3. Under **ChatOps Integrations**, check **Microsoft Teams**
4. Save

Only agents with Microsoft Teams enabled will appear in the channel selection dropdown.

### Teams App Manifest

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

### Install in Teams

1. In Teams: **Apps** > **Manage your apps** > **Upload an app**
2. Select your manifest zip
3. Add the app to a team/channel

### Usage

#### First Message

When you first mention the bot in a channel with no binding:

```
@Archestra what's the status of service X?
```

The bot responds with an Adaptive Card dropdown to select which agent handles this channel. After selection, the bot processes your message and all future messages in that channel.

#### Commands

| Command | Description |
|---------|-------------|
| `@Archestra /select-agent` | Change which agent handles this channel |
| `@Archestra /status` | Show current agent binding |
| `@Archestra /help` | Show available commands |

#### Trigger Patterns

- **mention** (default): Bot only responds when @mentioned
- **all**: Bot responds to all messages in the channel

Configure via the Adaptive Card when selecting an agent.

### Architecture

- Single Azure Bot shared across your deployment
- Channel bindings stored in Archestra database
- Messages validated via Bot Framework JWT verification
- Thread history fetched via Microsoft Graph API (if configured)
- Responses sent via Bot Framework SDK

### Troubleshooting

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

### Alternative: Standalone Bot

For more control or custom logic, you can build your own bot that connects to Archestra via A2A protocol. See [Connect Agent to MS Teams](/docs/platform-example-teams-a2a) for the standalone approach.
