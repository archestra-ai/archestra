---
title: Incoming Email
category: Agents
order: 6
description: Invoke agents by sending emails to auto-generated addresses
lastUpdated: 2026-03-27
---

Incoming Email lets users invoke agents by sending mail to agent-specific aliases. Archestra watches a shared mailbox, extracts the target agent from the alias, and turns the email body into the agent's first message.

Use **Agent Triggers** → **Email** to:

- run the setup wizard for the webhook subscription
- reconfigure or renew the Microsoft Graph subscription
- enable or edit email invocation settings for individual agents
- review which agents currently have an active email alias

When an email arrives:

1. Microsoft Graph sends a webhook notification to Archestra
2. Archestra extracts the agent ID from the recipient alias
3. The email body becomes the agent's input message
4. The agent executes and generates a response
5. Optionally, the agent's response is sent back as an email reply

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
- **Manual**: open **Agent Triggers** → **Email** and run the setup wizard

Microsoft Graph subscriptions expire after 3 days. Archestra automatically renews them before expiration, and the Email trigger page also lets you renew or replace the subscription manually.

## Email Address Format

Agent aliases follow this pattern:

```
<mailbox-local>+agent-<agentId>@<domain>
```

For example, if your mailbox is `agents@company.com` and your agent ID is `abc12345-6789-...`, emails sent to:

```
agents+agent-abc123456789...@company.com
```

will invoke that specific agent. You can copy the exact alias for any enabled agent from **Agent Triggers** → **Email**.

## Security Modes

Incoming email is disabled by default for all agents. When enabled, you must choose a security mode to control who can invoke the agent via email.

| Mode | Description |
|------|-------------|
| **Private** | Only registered Archestra users who have team-based access to the agent can invoke it. The sender's email address must match an existing user, and that user must be a member of at least one team assigned to the agent. **Note:** This mode relies on your email provider's sender verification. Email addresses can be spoofed—ensure your provider has appropriate anti-spoofing measures (SPF, DKIM, DMARC) configured. |
| **Internal** | Only emails from a specified domain are accepted. Configure an allowed domain (e.g., `company.com`) to restrict access to your organization's email addresses. Note: This performs an exact domain match—subdomains are not automatically included (e.g., if `company.com` is allowed, emails from `sub.company.com` will be rejected). |
| **Public** | Any email address can invoke the agent. Use with caution as this exposes the agent to external senders. |

When security validation fails, the email is rejected with an appropriate error and no agent execution occurs.

## Attachments

Emails sent to agents can include file attachments (both inline images and attached files). Attachments are automatically extracted and passed to the agent for processing. Image attachments are included inline in the agent's context; non-image attachments are noted but not processed as inline content.

**Limits:**
- Max 20 attachments per email
- Max 10 MB per individual file
- Max 25 MB total across all attachments in a single email
- Images smaller than 2 KB are filtered out (typically broken inline references from forwarded emails)

Files exceeding these limits are silently skipped.
