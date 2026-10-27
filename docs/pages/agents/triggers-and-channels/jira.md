---
title: Jira
description: Connect a Jira service account to an Archestra agent and answer issue comments
order: 6
beta: "Jira messaging channels are in Beta."
lastUpdated: 2026-10-27
---

Mention the bot in a Jira issue comment, and its Archestra agent answers in the issue. Each bot connects one Jira account to one agent. Give each connected project its own instructions.

## Prepare the Jira Account

Create or reuse an Atlassian service account for the bot, then connect it in Archestra.

1. Open [Atlassian Administration](https://admin.atlassian.com/), select your organization, and go to **Directory → Service accounts**.
2. Use the service account already used by your Jira MCP server, or create a dedicated account if you do not have one. Give it a recognizable bot name.
3. Give the account Jira access on the intended site. In connected projects it needs **Browse Projects**, **Add Comments**, and **Edit Own Comments**. Looking up an unknown commenter's email also needs **Browse users and groups**; profile privacy can still hide it.
4. Open the account's **Credentials** tab and choose **Create credentials → API token**. Set a name and expiry, then select `read:jira-user`, `read:jira-work`, and `write:jira-work`. These functional scopes allow more than comments; Jira permissions still limit what the account can do.
5. Copy the account email and token. Atlassian shows the token only once.

What to know:

- Use Jira Cloud. Server and Data Center are not supported.
- Connect projects whose issues and comments are visible to everyone allowed to use the agent. Restricted issues and restricted comments are not supported.
- Site access can include other Open projects. An Archestra project binding controls where the bot answers; it does not reduce the account's Jira permissions.

Atlassian documents [service accounts](https://support.atlassian.com/user-management/docs/understand-service-accounts/) and their [API token lifecycle](https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/).

## Connect Jira

Use polling when Archestra has no public HTTPS address. It needs no webhook, tunnel or incoming port.

1. Go to **Settings → Messaging Channels → Jira**.
2. Under **1. Connect your Jira Cloud site**, enter **Jira site URL**, such as `https://example.atlassian.net`.
3. Set **Event delivery** to **Poll Jira every minute**, enable **Receive Jira events**, and click **Save Jira site**.
4. Under **2. Connect Jira bots**, click **Connect Jira bot**. Pick **Agent**, enter **Jira account email**, choose **Service account / scoped API token**, and paste **Jira API token**.
5. Click **Verify and connect**. The card shows the verified Jira name, account ID and agent. Archestra discovers the cloud ID; you do not copy it yourself.
6. On the card, click **Connect project**, choose **Jira project**, and click **Save project binding**.

In a connected project, mention the bot in an issue comment: `@Support Bot summarize the next action`. Pick the account from Jira's mention list. A placeholder appears, then becomes the agent's answer.

The agent needs a model connection available to the person or service identity running it. A personal subscription stays with its owner. Connecting a Jira token does not share model credentials.

Each additional bot needs its own Jira account and agent. If you reuse an MCP service account, enter its email and token here too. Choose **Classic API token** only for a token created without scopes.

## When the Bot Answers

Mention the bot to start a conversation in an issue.

- One mention is enough. The bot then answers ordinary comments in that issue.
- Each issue is a separate conversation. The agent reads its summary, description and up to 50 recent comments.
- Editing your comment can start another answer. Archestra handles each edit once and ignores the bot's own comments.
- A placeholder comment shows that the bot is working. It is edited into the final answer.
- Assigning an issue to the account does not trigger the bot. The bot does not read attachments or respond to issue status changes.

Polling checks every minute. Comments created or edited before polling was enabled do not start runs. Jira search indexing can delay discovery.

To quiet the issue, comment `mute`. A new mention resumes automatic replies. The `archestra-mute` label blocks replies until removed, including replies already being prepared; mentioning the bot does not override that label. Jira reactions are not mute controls.

## Project Instructions

Tell the agent how to behave in one project. Add **Project instructions (optional)** when connecting it, or click **Edit instructions** in **3. Project bindings**. For example: "Summarize the next action and list unanswered questions."

These instructions supplement the agent's own instructions. Saving an existing project binding replaces its project instructions. Tool permissions still apply.

## Identity and Approvals

Archestra matches your Jira email to your Archestra account and remembers the connection if Jira later hides your email. Someone without an account gets one with the organization's default role, set in **Settings → Auth**. Access to the agent is checked on every request.

### Hidden Email

If Jira hides your email before your accounts are connected, open **Identity fallback** on the bot card. Choose a restricted **Archestra service account** and a **Human approval reviewer**. Both need access to the agent.

The Archestra service account runs the agent; the Atlassian account posts its comments. The Archestra account needs its own authorized model and tool connections.

Fallback works for agents without a [dedicated runtime](/docs/agents/runtime). Agents with a dedicated runtime need a connected human identity. There is no Jira account-linking screen.

### Approvals

Approval comments name the action and ask the designated reviewer to reply `approve <approval-id>` or `decline <approval-id>`. A bare `approve` or `decline` works when exactly one request is pending in the issue. Other people cannot decide it.

Approvals and fallback reviewers require a verified Archestra email. Password-only deployments without email verification cannot use them. An [SSO sign-in](/docs/admin/identity/sso) can provide a verified identity.

The **Review the model session** link opens the issue's logged requests, responses and tool activity. Approve or decline in Jira. Viewing your own logs requires [`log:read`](/docs/reference/permissions#log:read); viewing the service account's logs requires [`log:admin`](/docs/reference/permissions#log:admin).

## Receive Webhooks Instead

Use incoming events when Jira can reach Archestra at a stable public HTTPS address. Both options use the **Webhook URL** shown on the Jira page and a secret separate from the bot's API token.

| Event Delivery | Configure in Archestra | Configure in Jira |
| --- | --- | --- |
| **Signed Jira webhook** | Set **Webhook signing secret** and save | Create a [Jira webhook](https://developer.atlassian.com/cloud/jira/platform/webhooks/) for `comment_created` and `comment_updated`, filtered to the intended projects. Use the same secret for HMAC-SHA256 signing. |
| **Jira Automation web request** | Set **Automation header secret** and save | Use **Send web request** to POST comment event JSON to the shown URL. Set `Content-Type: application/json` and `x-archestra-jira-secret` to the shared secret. |

A localhost URL is not reachable by Jira Cloud. Polling avoids this requirement. Automation's shared header is not the Jira API token and is not an `Authorization` header.

For the **Work item commented** Automation trigger, choose a custom request body. A newly added comment's creation time is its initial revision time:

```json
{
  "webhookEvent": "comment_created",
  "issue": { "id": "{{issue.id}}" },
  "comment": {
    "id": "{{comment.id}}",
    "updated": "{{comment.created.jiraDateTime}}"
  }
}
```

The separate [**Work item comment edited** trigger](https://support.atlassian.com/cloud-automation/docs/jira-automation-triggers/#Work-item-comment-edited) needs `comment_updated` and that comment's updated timestamp, not its creation time. Never send the issue's update time or `now`. Check the [comment smart values](https://support.atlassian.com/cloud-automation/docs/jira-smart-values-issues/#%7B%7Bcomment%7D%7D) and [date formatting](https://support.atlassian.com/cloud-automation/docs/jira-smart-values-date-and-time/) in the rule's audit log. Use signed webhooks or polling if the edited comment's timestamp is unavailable to the rule.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| **Connection verification fails** | Check the site, account email, token expiry and selected token type. Organization service accounts use scoped tokens. |
| **The project is missing** | Give the connected account permission to browse it, then open **Connect project** again. |
| **The bot does not answer** | Check that the bot is enabled and the project is connected. Pick its account from Jira's mention list, check mute state, and allow for the next polling scan. Restricted content is skipped. |
| **"Your Jira email is hidden"** | Check email lookup permissions and Jira profile visibility, or configure **Identity fallback** for an agent without a dedicated runtime. |
| **An approval is refused** | Use the assigned reviewer's linked identity and an unexpired request from the same issue. The reviewer must have a verified email and access to the agent. |
| **The token has expired** | Create a replacement in Atlassian Administration. Disconnect and reconnect the bot with the new token, then restore its project connections and instructions. |
