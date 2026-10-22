---
title: MS Teams
description: Connect Archestra agents to Microsoft Teams channels
order: 4
lastUpdated: 2026-10-20
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Mention the bot in Microsoft Teams, and an Archestra agent answers in the thread. Each channel, group chat, and direct message has its own agent. People can ask a different agent for one message.

<span id="prerequisites"></span><span id="setup"></span>

## Connect Microsoft Teams

![The Microsoft Teams setup steps in Settings](/docs/automated_screenshots/agents-triggers-and-channels-ms-teams_setup.webp)

You need an Azure subscription where you can create an Azure Bot, and a Teams tenant that allows custom apps.

1. Go to **Settings → Messaging Channels → MS Teams** and click **Setup MS Teams**.
2. Follow the wizard. It creates the Azure Bot and the Teams app, and saves the credentials.
3. Install the app in your team.

What to know:

- Teams must reach Archestra. A local instance can use the wizard's **Configure ngrok** step instead.
- To expose only the webhook, set [`ARCHESTRA_PUBLIC_ENDPOINTS_PORT`](/docs/admin/deployment/configuration#ARCHESTRA_PUBLIC_ENDPOINTS_PORT). The rest of the API can then stay internal.
- To configure Teams with environment variables, see the [Configuration reference](/docs/admin/deployment/configuration#chatops).

<span id="dedicated-webhook-port"></span><span id="usage"></span><span id="first-message"></span><span id="default-agent"></span><span id="direct-messages"></span>

## Pick the Agent for a Channel

1. Mention the bot in the channel: `@Archestra what is the status of service X?`
2. Pick an agent from the card. It answers this message and later ones in the channel.

To change the agent, send `@Archestra /select-agent`, or [add the channel](/docs/agents/triggers-and-channels#assigning-channels) to another agent.

**Direct messages** work the same way, but each person must add the app for themselves first. Teams asks them to click **Add** the first time they open a chat with the bot.

<span id="replying-within-a-thread"></span><span id="answering-every-message"></span>

## When the Bot Answers

Mention the bot to ask an agent in a shared conversation.

- In a channel, the bot answers only when you mention it.
- In a thread, one mention is enough. It then answers every message in that thread.
- In a group chat, mention the bot on each request. Once a conversation has started, ordinary group messages remain in its history without triggering replies.
- In a direct message, it answers every message.
- To answer every message in a channel or group chat, turn on **Answer all messages** in its **Settings**. The installer must approve the app's permissions.

To quiet a thread, send `mute`, or react to a bot reply with 🔇 or 🤫. The bot stops, and cancels any reply in progress. Mention it again to wake it.

<span id="switching-agents-inline"></span>

## Ask Another Agent Once

Put the agent's name and `>` before your message:

```
@Archestra Sales > what is our Q4 pipeline?
```

The channel keeps its agent. Names match without regard to case or spaces. An unknown name goes to the channel's agent, with a notice.

<span id="channel-instructions"></span>

## Channel Instructions

Tell the agent how to behave in one channel. Open the channel's **Settings** and write them as you would talk to the agent. For example: "Every message here is a task. Create it at once, and do not ask first."

They come first, before the agent's own instructions. They add to what the agent does, and never remove an ability.

<span id="commands"></span>

## Commands

| Command | What It Does |
| --- | --- |
| `@Archestra /select-agent` | Changes the agent for this channel |
| `@Archestra /status` | Shows the agent for this channel |
| `@Archestra /help` | Lists the commands |
| `reset` | Starts a new conversation. Direct messages and group chats only. |

<span id="autoprovisioning-ms-teams-users"></span><span id="attachments"></span>

## Read Files in Channels

Share a PDF in a channel, and the agent reads it. Your Microsoft 365 admin grants the bot read access to the teams you pick, and nothing else. Direct messages need no setup.

1. In **Settings → Messaging Channels → MS Teams**, open the setup and go to **Read Files in Channels**.
2. Paste each team's SharePoint site, one per line. Find it on the channel's **Files** tab, under **Open in SharePoint**.
3. Click **Copy request for IT** and send it to your admin.

When it works, the agent answers questions about a PDF shared in that channel.

### What Your Microsoft 365 Admin Does

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), open the bot's app under **App registrations**. On **API permissions**, add **Microsoft Graph → Application permissions → Sites.Selected**, then click **Grant admin consent**.
2. Grant read access to each site, for example with the [CLI for Microsoft 365](https://pnp.github.io/cli-microsoft365/):

```bash
m365 spo site apppermission add \
  --siteUrl https://contoso.sharepoint.com/sites/Engineering \
  --appId <microsoft-app-id> --permission read
```

What to know:

- [`Sites.Selected`](https://learn.microsoft.com/en-us/graph/permissions-selected-overview) alone grants nothing. The bot reads only the sites granted read.
- The grant needs `Sites.FullControl.All` on the admin's own sign-in. The bot never gets it.
- Private and shared channels each have their own site. Group-chat files are not read: Teams keeps them in each sender's OneDrive.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| **"You don't have access to this app"** | Your organization blocks custom apps. Ask your Teams admin to allow them in the [Teams Admin Center](https://admin.teams.microsoft.com/). |
| **The bot does not answer** | Check that [`ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED=true`](/docs/admin/deployment/configuration#ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED), that Teams can reach your URL, and that the app ID and password are correct. |
| **"Could not verify your identity"** | Add the `TeamMember.Read.Group` and `ChatMember.Read.Chat` permissions to the app manifest. Then install the app again. |
| **No history in a channel thread, or Answer all messages does nothing** | Add the `ChannelMessage.Read.Group` and `ChatMessage.Read.Chat` permissions to the manifest. Install the app again, and have the team owner approve them. |
| **Direct messages do not work** | Upload the latest app manifest. Older manifests do not include the `personal` scope. |
| **The agent says it could not read a file from a channel** | Ask your admin to grant read access to that team's site, as in [Read Files in Channels](#read-files-in-channels). A private or shared channel needs its own site. In a group chat, send the file in a direct message instead. |

## What to Know

- **Memory:** in a channel, the agent reads the thread. In a direct message or group chat, Archestra keeps the history. See [Conversation History](/docs/agents/triggers-and-channels#conversation-history).
- **New people:** someone who messages the bot without an Archestra account gets one. It has the organization's default role for new users, set in **Settings → Auth**. Find these accounts in **Settings → Users**.
- **Welcome message:** the bot DMs a new person a sign-up link, or a sign-in link when you use [SSO](/docs/admin/identity/sso). To turn it off, set [`ARCHESTRA_CHATOPS_SIGNUP_WELCOME_ENABLED=false`](/docs/admin/deployment/configuration#ARCHESTRA_CHATOPS_SIGNUP_WELCOME_ENABLED).
- **Files:** the agent reads images, PDFs, and text files such as CSV, JSON, and Markdown. With a [code sandbox](/docs/agents#code-sandbox), it can open other files too, such as ZIP archives. Files in channels need [read access to the team's site](#read-files-in-channels).
- **File limits:** 20 files per message, 10 MB per file, 25 MB in total. When a file is too large or cannot be read, the agent says so.
