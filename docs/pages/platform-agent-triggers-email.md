---
title: Incoming Email
category: Agents
order: 9
description: Invoke agents by sending emails to auto-generated addresses
lastUpdated: 2026-08-29
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Incoming Email lets users invoke agents by sending mail to agent-specific aliases. Archestra watches a shared mailbox, extracts the target agent from the alias, and turns the email body into the agent's first message.

Use **Settings** → **Messaging Channels** → **Email** to:

- run the setup wizard for the webhook subscription
- reconfigure or renew the Microsoft Graph subscription

Open an individual agent's **Email Invocation** section to enable or edit its email settings and copy its active alias.

When an email arrives:

1. Microsoft Graph sends a webhook notification to Archestra
2. Archestra extracts the agent ID from the recipient alias
3. The email body becomes the agent's input message
4. The agent executes and generates a response
5. Optionally, the agent's response is sent back as an email reply

If the Agent has [Background execution](/docs/platform-agent-background-execution) configured, step 4 starts a durable task in its execution backend. The webhook does not wait for that task. When replies are enabled, Archestra sends the terminal result in the original thread after the task finishes. Pending replies survive control-plane restarts and are retried until delivery is recorded.

In **Private** mode, a sender whose Agent access is verified uses their own identity and per-user credentials. **Internal** and **Public** mail runs as the system actor and can use shared credentials only.

## Conversation History

When processing emails that are part of a thread (replies), Archestra automatically fetches the conversation history and provides it to the agent. This allows the agent to understand the full context of the conversation and respond appropriately to follow-up messages.

## Email Reply

When email replies are enabled, the agent's response is automatically sent back to the original sender. The reply:

- Maintains the email conversation thread
- Uses the original message's "Re:" subject prefix
- Displays the agent's name as the sender

## Prerequisites

- Microsoft 365 mailbox (Exchange Online)
- Azure AD application with `Mail.Read` application permission
- Publicly accessible webhook URL

## Azure AD Application Setup

1. Create an App Registration in [Azure Portal](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Add the following **application** permissions (not delegated) under Microsoft Graph:
   - `Mail.Read` - Required for receiving emails
   - `Mail.Send` - Required for sending reply emails (optional)
3. Grant admin consent for the permissions
4. Create a client secret and note the value

## Configuration

Set these environment variables (see [Deployment](/docs/platform-deployment#incoming-email-configuration) for details):

```bash
ARCHESTRA_AGENTS_INCOMING_EMAIL_PROVIDER=outlook
ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_TENANT_ID=<tenant-id>
ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_CLIENT_ID=<client-id>
ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_CLIENT_SECRET=<client-secret>
ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_MAILBOX_ADDRESS=agents@yourcompany.com
```

## Webhook Setup

Archestra needs a public webhook URL so Microsoft Graph can notify it about new mail.

- **Automatic**: set `ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_WEBHOOK_URL` and Archestra creates the subscription on startup
- **Manual**: open **Settings** → **Messaging Channels** → **Email** and run the setup wizard

Microsoft Graph subscriptions expire after 3 days. Archestra automatically renews them before expiration, and the Email settings page also lets you renew or replace the subscription manually.

## Email Address Format

Agent aliases follow this pattern:

```
<mailbox-local>+agent-<agentId>@<domain>
```

For example, if your mailbox is `agents@company.com` and your agent ID is `abc12345-6789-...`, emails sent to:

```
agents+agent-abc123456789...@company.com
```

will invoke that specific agent. You can copy the exact alias from the enabled agent's **Email Invocation** section.

## Security Modes

Incoming email is disabled by default for all agents. Open an agent, then select **Edit** → **Configuration** to enable it. Choose a security mode to control who can invoke the agent by email.

| Mode | Description |
|------|-------------|
| **Private** | Only registered Archestra users who have team-based access to the agent can invoke it. The sender's email address must match an existing user, and that user must be a member of at least one team assigned to the agent. **Note:** This mode relies on your email provider's sender verification. Email addresses can be spoofed—ensure your provider has appropriate anti-spoofing measures (SPF, DKIM, DMARC) configured. |
| **Internal** | Only emails from a specified domain are accepted. Configure an allowed domain (e.g., `company.com`) to restrict access to your organization's email addresses. Note: This performs an exact domain match—subdomains are not automatically included (e.g., if `company.com` is allowed, emails from `sub.company.com` will be rejected). |
| **Public** | Any email address can invoke the agent. Use with caution as this exposes the agent to external senders. |

When security validation fails, the email is rejected with an appropriate error and no agent execution occurs.

## Attachments

Emails sent to agents can include file attachments (both inline images and attached files). Attachments are automatically extracted and passed to the agent for processing. Files the selected model can read — images, PDFs, and text documents such as CSV, TSV, JSON, XML, YAML, TOML, and Markdown — are included inline in the agent's context. When the agent has a [code sandbox](./platform-code-sandbox), other file types (for example a SQLite database or a ZIP archive) are placed into the sandbox so the agent can open them with its tools. Anything that still cannot be provided is noted by name so the agent can tell the user.

**Limits:**
- Max 20 attachments per email
- Max 10 MB per individual file
- Max 25 MB total across all attachments in a single email
- Images smaller than 2 KB are filtered out (typically broken inline references from forwarded emails)

Files exceeding these limits are silently skipped.
