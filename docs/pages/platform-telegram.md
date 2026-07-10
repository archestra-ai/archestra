---
title: Telegram
category: Agents
order: 6
description: Connect Archestra agents to Telegram chats and groups
lastUpdated: 2026-07-03
---

Archestra connects to Telegram through a bot. Messages sent to the bot — in direct messages or group chats — are routed to the configured agent, and responses appear back in the chat.

Telegram uses long polling: Archestra makes outbound requests to the Telegram API, so no public URL, webhook, or ngrok tunnel is needed. The only credential is a bot token.

## Setup

The integration is off by default and hidden. Set `ARCHESTRA_CHATOPS_TELEGRAM_ENABLED=true` on the deployment to make the Telegram channel available — beta deployments (`ARCHESTRA_BETA=true`) get it automatically.

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and pick a display name and username. BotFather replies with a bot token.
2. Paste the token into the Telegram setup on the Messaging Channels page (or set it via environment variables, see [Deployment](/docs/platform-deployment#telegram)).

Archestra validates the token and starts polling immediately.

## Linking Telegram accounts

Telegram does not expose user email addresses, so unlike Slack and MS Teams, users cannot be matched to their accounts automatically. Each user links their Telegram account once:

1. On the Telegram channels page, the user assigns an agent to their Direct Message row. This creates a personal linking link (`https://t.me/<bot>?start=<code>`).
2. Opening the link and tapping Start ties their Telegram account to their email.

The code is an unguessable one-time value; once used, it cannot link another Telegram account. Whoever opens the link claims the account, so treat it like an invitation link.

Group members must link their own account the same way before the bot answers them — messages from unlinked users get a short reply explaining how to link. Access control is the same as other channels: users can only reach agents their teams have access to, and unknown emails are auto-provisioned as members.

## Usage

### Direct messages

Every message in a DM gets a reply. On first contact the bot asks which agent should handle the conversation (unless an org default agent resolves it automatically).

### Group chats

Add the bot to a group. It replies when addressed:

- `@botname` mention
- a reply to one of its messages
- a `/command`

By default Telegram's privacy mode means the bot only receives these messages anyway. To let an agent observe all group messages (and decide when to chime in), disable Group Privacy for the bot in BotFather, then remove and re-add the bot to the group — Telegram caches the setting.

In supergroups with Topics enabled, each forum topic is a separate conversation for the agent.

### Commands

| Command | Description |
|---------|-------------|
| `/select-agent` | Change which agent handles this chat |
| `/start <code>` | Link your Telegram account (DM only) |
| `/help` | Show available commands |

### Switching agents inline

`AgentName > message` routes a single message to a different agent, same as Slack and MS Teams:

```
Sales > what's our Q4 pipeline?
```

### Tool approvals

When an agent needs approval to run a tool, the bot posts the tool name and arguments with Approve/Decline buttons. Only the user who triggered the request can decide.

## Attachments

Photos and documents sent to the bot are downloaded and passed to the agent, subject to the same size limits as other channels (10 MB per file). Files over the limit are noted to the agent by name so it can tell the user.

## Limitations

- Telegram bots cannot read chat history, so the agent only sees the current message. Replying to one of the bot's messages quotes it as context for follow-ups.
- Telegram allows a single polling consumer per bot token. With multiple backend replicas, one replica receives updates and the others back off; do not reuse the same token in another system.

## Troubleshooting

**Bot not responding in a DM**
- Check the integration is enabled and the token is valid (the status shows "configured")
- Make sure your Telegram account is linked — send `/start` to the bot to check

**Bot not responding in a group**
- Address it explicitly (@mention, reply, or command), or disable Group Privacy in BotFather and re-add the bot to the group

**"This Telegram account isn't linked" reply**
- Assign an agent to your Direct Message row on the Telegram channels page and open the generated linking link

**409 conflict errors in backend logs**
- Another process is polling with the same bot token — stop it or issue a new token via BotFather (`/revoke`)
