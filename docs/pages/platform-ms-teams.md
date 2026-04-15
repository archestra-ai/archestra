---
title: MS Teams
category: Agents
subcategory: Agent Triggers
order: 5
description: Connect Archestra agents to Microsoft Teams channels
lastUpdated: 2026-02-20
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

The setup wizard in Archestra guides you through the entire MS Teams configuration. Navigate to **Agent Triggers** → **MS Teams** → **Setup MS Teams** and follow the step-by-step instructions.

![MS Teams Setup Wizard](/docs/setup-msteams.webp)

The wizard will walk you through creating an Azure Bot, configuring the Teams app manifest, and installing it to your workspace. All required credentials are collected and saved automatically.

See [Deployment — Environment Variables](/docs/platform-deployment#environment-variables) for the full list of environment variables if you prefer manual configuration.

## Usage

### First Message

When you **first mention the bot** in a channel:

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

Each Teams channel requires a **default agent** to be assigned to it. This agent handles all messages in the channel by default. When you first mention the bot in a channel without a binding, you'll be prompted to select an agent from a dropdown.

You can manage the default agent for each channel from the **Agent Triggers** → **MS Teams** page in Archestra.

![MS Teams Agent Selection](/docs/select-agent-msteams.webp)

Once set, the default agent processes all subsequent messages in that channel. You can also use the `/select-agent` command directly in Teams to change the default agent.

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

### Direct Messages

A DM with the bot behaves just like another channel — each user can choose which agent handles their DMs. On your first message, the bot shows an agent selection card. Use `/select-agent` to change it later.

> **Note:** Installing the bot for a team does not automatically enable direct messages for all team members. Each user must install the Archestra app personally before they can DM the bot. When a user opens a chat with the bot for the first time, Teams prompts them to click **Add** to complete the personal installation. This is a Microsoft Teams platform requirement.

> If you update from a previous manifest without the `"personal"` scope, re-upload the updated manifest to enable DMs.

## Autoprovisioning MS Teams Users

When a user interacts with the bot but hasn't signed up in Archestra yet, they are automatically provisioned with the **Member** role and no teams assigned. The user receives a unique invitation link via Teams DM that they can use to complete sign-up and become a full Archestra user. Until they do, they cannot log in to the Archestra web app.

Admins can view autoprovisioned users on the **Settings → Members** page — from there they can copy the invitation link or delete the user.

![Autoprovisioned MS Teams Users](/docs/autoprovisioned-users-msteams.webp)

## Attachments

Messages sent to the bot can include file attachments (images, PDFs, documents, etc.). Attachments are automatically downloaded and passed to the agent for processing. Image attachments are included inline in the agent's context; non-image attachments are noted but not processed as inline content.

Adaptive Cards and other Teams-specific card types are not treated as file attachments.

**Limits:**
- Max 20 attachments per message
- Max 10 MB per individual file
- Max 25 MB total across all attachments in a single message

Files exceeding these limits are silently skipped.

## Troubleshooting

**"You don't have access to this app"**
- Your org may have disabled custom app uploads
- Ask IT to enable sideloading in [Teams Admin Center](https://admin.teams.microsoft.com/)

**Bot not responding**
- Verify `ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED=true`
- Check webhook URL is accessible externally
- Verify App ID and Password are correct

**"Could not verify your identity"**
- Ensure `TeamMember.Read.Group` and `ChatMember.Read.Chat` RSC permissions are in your manifest. These are required for the bot to resolve user emails. Reinstall the app after updating the manifest.

**No thread history**
- Ensure `ChannelMessage.Read.Group` and `ChatMessage.Read.Chat` RSC permissions are in your manifest. Reinstall the app after updating the manifest. The team owner must consent to the permissions when adding the app.
