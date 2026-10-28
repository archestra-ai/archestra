---
title: Slack
description: Give each Archestra agent its own Slack bot
order: 3
lastUpdated: 2026-10-28
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Each agent gets its own Slack bot, and people @mention it by name: `@archestra_marketing` and `@archestra_coding` can work in the same channel, even the same thread. The answer streams in as the agent writes it, and a **Stop** button ends it.

<span id="prerequisites"></span><span id="setup"></span><span id="agent-bots"></span>

## Connect Slack

You paste one token pair from Slack once, and Archestra creates a Slack app for every agent you add. You need a Slack workspace where you can install apps.

1. Go to **Settings → Messaging Channels → Slack** and click **Connect Slack**.
2. On [api.slack.com/apps](https://api.slack.com/apps), click **Generate Token** under **Your App Configuration Tokens**, and paste both tokens. Archestra renews them itself. Each person who adds bots pastes their own.
3. Click **Add Slack bot**, pick the agent, and keep or change its Slack name.
4. Approve the install in Slack. In Socket Mode, also paste the app-level token Slack shows; Slack has no API to create it.
5. Add your team as collaborators on the app's Slack page. Slack makes only the person whose token created an app its collaborator, and has no API to add others.
6. Edit the bot to add it to channels. It joins public channels itself; for a private one, type `/invite @archestra_marketing` there.

What to know:

- **Name and icon:** the bot uses the agent's icon and keeps it in sync. Renaming the agent renames the bot, unless you picked its Slack name yourself. Slack app icons must be images, so an emoji icon keeps Slack's default.
- **Reinstall:** when Slack needs new permissions, the bot's row says so and links to its Slack page.
- **An app connected before:** it is listed for conversion. Pick the agent it should answer as; it keeps its name, channels, and DMs.

Connection mode and the token live under **Advanced**:

| | Socket Mode (Default) | Webhook Mode |
| --- | --- | --- |
| **Connects** | Archestra connects to Slack | Slack calls your public URL |
| **Needs a public URL** | No | Yes |
| **Use it for** | Local setups, firewalls, VPNs | Production with a stable URL |

With an HTTPS address, installing a new bot is one click: Slack sends you back to Archestra with the bot connected.

## Network Access

If Archestra can reach the internet freely, there is nothing to set up. If your firewall lets Archestra connect only to approved addresses, allow these two, on port 443 (HTTPS):

- `slack.com`
- `*.slack.com`

You need both entries. The wildcard entry, written with `*`, covers addresses such as `files.slack.com`, but many firewalls do not let it cover `slack.com` itself. Without `slack.com`, Archestra cannot use Slack's API, which it needs to check your tokens and to read and post messages, so connecting Slack fails or never finishes.

The `api.slack.com` links in the setup steps open in your own browser. The Archestra server never connects to that address, so you do not need to allow it.

### Exact Addresses

Use this list when your firewall does not accept wildcards. Socket Mode does not work reliably this way: Slack hands Archestra its connection address each time it connects, the address can change, and Slack publishes no full list. Use Webhook Mode instead, which needs Slack to reach Archestra from the internet (see [Incoming Connections](#incoming-connections)).

Archestra connects to these Slack addresses, all on port 443:

| Address | Connection mode | What it is for |
| --- | --- | --- |
| `slack.com` | Both | Slack's API: checking your tokens, creating bots, and reading and posting messages |
| `files.slack.com` and `files-origin.slack.com` | Both | Reading files people post, and uploading files the agent sends. Slack can forward a download from the first address to the second, so allow both. |
| `hooks.slack.com` | Socket Mode | Answering a slash command when the reply is slow, or the connection to Slack is briefly down |
| Socket Mode connection addresses, such as `wss-primary.slack.com` and `wss-backup.slack.com` | Socket Mode | The connection Archestra keeps open so Slack can send it new messages |

What to know:

- **Blocked file addresses:** the bot still answers, but the agent is told it could not read the files people post, and files it sends do not arrive.
- **HTTPS inspection:** a firewall that decrypts HTTPS traffic, often called TLS inspection or SSL decryption, can break the Socket Mode connection. That connection uses WebSockets, which stay open for a long time, so the firewall must support WebSockets or skip inspection for `*.slack.com`.

### Incoming Connections

What Slack needs to reach depends on the connection mode under **Advanced**:

- **Socket Mode:** nothing. Archestra opens the connection to Slack, so you do not open any port to traffic from the internet.
- **Webhook Mode:** Slack sends each new message to your Archestra address over HTTPS, so that address must be reachable from the internet. To keep the Archestra web app off the internet, set [`ARCHESTRA_CHATOPS_WEBHOOK_BASE_URL`](/docs/admin/deployment/configuration#ARCHESTRA_CHATOPS_WEBHOOK_BASE_URL) to a public address for Slack to use. Archestra still connects to `slack.com` and the file addresses to post replies and read files.

<span id="usage"></span><span id="first-message"></span><span id="default-agent"></span><span id="replying-within-a-thread"></span><span id="answering-every-message"></span>

## When a Bot Answers

- In a channel, a bot answers when you mention it.
- In a thread, one mention is enough. It then answers every message in that thread.
- In a direct message, it answers every message.
- Mentioning one bot does not wake another in the same thread.

One bot per channel can reply to all messages, with no mention needed. Turning it on for a bot takes it from the bot that had it. Other bots in the channel still wait for their mention.

The first reply in a channel thread includes a reminder of how to mute it.

- **Mute:** reply `mute` or react `:mute:` or `:shushing_face:` to any message in the thread. This cancels the current answer and stops later auto-replies until you mention the bot again. Removing the reaction keeps the thread muted.
- **Stop:** press it while the bot is working to cancel only the current answer. The bot can still answer later messages in that thread.

<span id="streaming"></span>

## Watch the Answer Arrive

The answer appears as the agent writes it, so a long one never leaves the thread silent. Each tool call shows as a step that turns done or failed. The bot already carries the agent's name, so answers have no signature line.

- **Steps:** the tool calls of one answer are grouped in a single list.
- **Streaming:** in direct messages and threads where you mentioned the bot. Elsewhere the full answer posts at once, because the agent may decide to stay quiet.
- **Suggested prompts:** the agent's first four suggested prompts wait at the top of the bot's direct messages.

<span id="channel-instructions"></span>

## Channel Instructions

Tell the agents how to behave in one channel. Edit the agent's bot, open the channel's **Settings**, and write them as you would talk to the agent. Every bot in the channel follows them. For example: "Every message here is a task. Create it at once, and do not ask first."

They come first, before the agent's own instructions. They add to what the agent does, and never remove an ability.

Bots also read the channel's description from Slack, to know what the channel is about. Anyone in the channel can edit it, so it is context, not instructions.

<span id="autoprovisioning-slack-users"></span><span id="attachments"></span><span id="commands"></span><span id="switching-agents-inline"></span>

## What to Know

- **New people:** someone who messages a bot without an Archestra account gets one. It has the organization's default role for new users, set in **Settings → Auth**. Find these accounts in **Settings → Users**.
- **Welcome message:** the bot DMs a new person a sign-up link, or a sign-in link when you use [SSO](/docs/admin/identity/sso). To turn it off, set [`ARCHESTRA_CHATOPS_SIGNUP_WELCOME_ENABLED=false`](/docs/admin/deployment/configuration#ARCHESTRA_CHATOPS_SIGNUP_WELCOME_ENABLED).
- **Files:** the agent reads images, PDFs, and text files such as CSV, JSON, and Markdown. Files posted earlier in the same thread count too. With a [code sandbox](/docs/agents#code-sandbox), it can open other files, such as ZIP archives.
- **File limits:** 20 files per message, 10 MB per file, 25 MB in total. Archestra skips larger files and tells the agent which files it did not get.
- **Agent experience:** connecting moves your existing Slack apps to Slack's agent experience, which the **Stop** button and DM prompts need. Slack cannot switch an app back.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| **The bot does not answer** | Invite it to the channel. In webhook mode, make sure Slack can reach your URL. In socket mode, look for "Socket mode connected" in the backend logs. |
| **"Needs reinstall"** | Open the app's Slack page from the bot's row, click **Reinstall to Workspace**, then **Check again**. |
| **Slack shows a server error after approving the install** | The install often went through anyway. Open the app's **OAuth & Permissions** page; if a bot token is there, paste it in **Finish setup**. |
| **"Request verification failed"** | Webhook mode only. Check the signing secret on the app's **Basic Information** page, and your server's clock. |
| **Socket mode disconnects** | Check that the app-level token has the `connections:write` scope, and that Archestra can reach [Slack's addresses](#network-access). It connects again on its own. |
| **"Could not verify your identity"** | The app needs the `users:read` and `users:read.email` scopes. Reinstall it from its Slack page. |
