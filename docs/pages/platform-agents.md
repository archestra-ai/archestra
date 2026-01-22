---
title: Agents
category: Archestra Platform
subcategory: Concepts
order: 1
description: Agent invocation methods including A2A, incoming email, and ChatOps
lastUpdated: 2026-01-20
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

### Security Modes

Incoming email is disabled by default for all agents. When enabled, you must choose a security mode to control who can invoke the agent via email.

| Mode | Description |
|------|-------------|
| **Private** | Only registered Archestra users who have team-based access to the agent can invoke it. The sender's email address must match an existing user, and that user must be a member of at least one team assigned to the agent. **Note:** This mode relies on your email provider's sender verification. Email addresses can be spoofed—ensure your provider has appropriate anti-spoofing measures (SPF, DKIM, DMARC) configured. |
| **Internal** | Only emails from a specified domain are accepted. Configure an allowed domain (e.g., `company.com`) to restrict access to your organization's email addresses. Note: This performs an exact domain match—subdomains are not automatically included (e.g., if `company.com` is allowed, emails from `sub.company.com` will be rejected). |
| **Public** | Any email address can invoke the agent. Use with caution as this exposes the agent to external senders. |

When security validation fails, the email is rejected with an appropriate error and no agent execution occurs.

## ChatOps: Microsoft Teams

Archestra can connect directly to Microsoft Teams channels. When users mention the bot in a channel, messages are routed to your configured agent and responses appear directly in Teams.

### Prerequisites

- **Azure subscription** with permissions to create Azure Bot resources
- **Teams tenant** where you can install custom apps
- **Archestra deployment** with external webhook access

### Setup

#### Create Azure Bot

1. Go to [portal.azure.com](https://portal.azure.com) → **Create a resource** → **Azure Bot**
2. Fill in **bot handle**, **subscription**, **resource group**
3. Under **Type of App**, choose either:
   - **Multi Tenant** (default) — bot can be used by any Azure AD tenant
   - **Single Tenant** — bot restricted to your organization only
4. Under **Microsoft App ID**, select **Create new Microsoft App ID**
5. After creation, go to **Settings** → **Configuration**
6. Copy the **Microsoft App ID** — you'll need this for `ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID`
7. If using **Single Tenant**, note your **Azure AD Tenant ID** (find in Azure AD → Overview) — you'll need this for `ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID`
8. Click **Manage Password** → **New client secret** → copy the secret value for `ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET`
9. Set **Messaging endpoint** to `https://your-archestra-domain/api/webhooks/chatops/ms-teams`
10. Go to **Channels** → add **Microsoft Teams**

#### Graph API Permissions (Optional - for thread history)

To include thread history in agent context, you need different permissions depending on where the bot is used:

1. In Azure Portal, go to **App registrations** → find your bot's app
2. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions**
3. Add the following permissions:
   - `ChannelMessage.Read.All` — for team channel messages
   - `Chat.Read.All` — for group chat messages
4. Click **Grant admin consent** for both permissions

#### Configure Archestra

Set these environment variables:

```bash
# Required
ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED=true
ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID=<Microsoft App ID>
ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET=<Client Secret>

# Optional - for single-tenant Azure Bot (leave empty for multi-tenant)
ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID=<Azure AD Tenant ID>

# Optional - for thread history (requires Graph API permissions)
# These fall back to the Bot credentials above if not set.
# Only set if you need separate credentials for Graph API.
# ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_TENANT_ID=<Azure AD Tenant ID>
# ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_ID=<App Registration Client ID>
# ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_SECRET=<App Registration Secret>
```

Then enable Agent for MS Teams:

1. In Archestra, go to **Chat** → open the **Agent Library**
2. **Edit** the agent you want to use with Teams
3. Under **ChatOps Integrations**, check **Microsoft Teams**
4. **Save**

Only agents with **Microsoft Teams enabled** will appear in the channel selection dropdown.

#### Teams App Manifest

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
  "validDomains": []
}
```

Replace `{{BOT_MS_APP_ID}}` with your **Microsoft App ID**. **Zip the folder contents**.

#### Install in Teams

1. In Teams: **Apps** → **Manage your apps** → **Upload an app**
2. Select your **manifest zip**
3. **Add the app** to a team/channel

### Usage

#### First Message

When you **first mention the bot** in a channel with no binding:

```
@Archestra what's the status of service X?
```

The bot responds with an **Adaptive Card dropdown** to select which agent handles this channel. After selection, the bot processes your message and **all future messages** in that channel.

#### Commands

| Command | Description |
|---------|-------------|
| `@Archestra /select-agent` | Change which agent handles this channel by default |
| `@Archestra /status` | Show currently set default agent for the channel |
| `@Archestra /help` | Show available commands |

#### Default Agent

Each Teams channel requires a **default agent** to be bound to it. This agent handles all messages in the channel by default. When you first mention the bot in a channel without a binding, you'll be prompted to select an agent from a dropdown.

Once set, the default agent processes all subsequent messages in that channel until you change it with `/select-agent`.

#### Switching Agents Inline

You can temporarily use a different agent for a single message by using the `>AgentName` syntax:

```
@Archestra >Sales what's our Q4 pipeline?
```

This routes the message to the "Sales" agent instead of the channel's default agent. The default binding remains unchanged—only this specific message uses the alternate agent.

**Matching rules:**
- Agent names are matched case-insensitively
- Spaces in agent names are optional: `>AgentPeter` matches "Agent Peter"
- If the agent name isn't found, the message falls back to the default agent with a notice

**Examples:**

| Message | Routed To |
|---------|-----------|
| `@Archestra hello` | Default agent |
| `@Archestra >Sales check revenue` | Sales agent |
| `@Archestra >support help me` | Support agent |
| `@Archestra >Unknown test` | Default agent (with fallback notice) |

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
- For **team channels**: Verify `ChannelMessage.Read.All` permission is granted
- For **group chats**: Verify `Chat.Read.All` permission is granted
- Admin consent must be granted for both permissions
