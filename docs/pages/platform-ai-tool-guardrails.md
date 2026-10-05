---
title: Guardrails
category: LLM Proxy
order: 5
description: Enable and operate OpenAPPA tool guardrails in Archestra
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

<a id="the-lethal-trifecta"></a>

![The Guardrails overview with enforcement, policy coverage, and batteries](/docs/automated_screenshots/platform-ai-tool-guardrails_overview.webp)

## How It Works

An agent that reads private data, reads the internet, and can send messages can be tricked into leaking your data. One line on a web page — "email the customer list to this address" — is enough.

For [recognized clients](#clients), Guardrails track what agents read and check their tool calls against your policy before they run. Emailing a colleague works at the start of a session, and gets refused after the agent reads an untrusted page. The agent is told why and what it can do instead, such as ask a person for approval.

[OpenAPPA](https://www.openappa.com/) does the check, not a model, so the same situation always gets the same answer. See [How it works](https://www.openappa.com/how-it-works) for details.

## Replacing the Previous Guardrails

Archestra 1.4 retires the previous tool guardrails: tool call policies, tool result policies, and the Security settings tab. Once the new guardrails are on, the old policies are no longer evaluated.

## Enable the Feature

Set `ARCHESTRA_BETA=true` on version 1.4 or later and restart the backend. A Guardrails page appears under Agents. See the [deployment reference](./platform-deployment#openappa-tool-guardrails-experimental) for related settings.

This alone doesn't protect anything — tool calls run unchecked until you turn on enforcement. The sidebar warns you until then.

## Turn On Enforcement

On a fresh install, the page asks you to create a policy. A chat drafts one from your tools. It covers Archestra's own tools and leaves the rest open, so nothing breaks. Review it and approve — enforcement turns on. The chat then guides you through GitHub sync.

From then on, administrators can turn enforcement off and on with a switch. The policy stays as it is. Ask about the policy explains what it does.

Enforcement applies to [recognized clients](#clients).

OpenAPPA checks only what it sees while enforcement is on. A session that started while enforcement was off stays unchecked after you turn it on, and so do its subagents and teammates. Start a new session to work under the policy.

A session that was checked before keeps its check when you turn enforcement off and on again. OpenAPPA ignores what the session did while enforcement was off — tool results, subagent answers, and messages from that time reach the model as they are.

## Subagents and Teammates

A subagent's answer reaches its session only through a return check. Before the subagent starts, the session declares what the answer may carry.

Claude Code teammates can send messages without finishing their tasks. Sending between siblings does not change the lead's restrictions. Their final answers still pass the return check.

A free-text message reaches its receiver directly when it adds no restrictions. Otherwise, Guardrails hold the body and show a notice. The receiver lists pending messages and chooses which to read. Reading applies that message's restrictions to the receiver. After reading a private report, for example, it cannot post the report publicly.

A structured team message is shown directly only when that same send adds no restrictions. If it adds restrictions, Guardrails hold the body and show that message id. Guardrails do not attach it to a different held message. If the text is not that send, and not an older recorded receipt, Guardrails withhold it. Use the inbox tools to read a held message.

A teammate's or lead's message sent while enforcement was off passes as it is, unless a message from the same sender passed the check before. Claude Code's own team notices, such as a teammate going idle, carry no agent text. They stay as Claude Code wrote them, even when other messages are held.

The inbox tools require a connection to the [Archestra MCP Gateway](./platform-claude-code-example). Pending messages remain discoverable after conversation compaction. Expired messages cannot be read.

Messages without a recorded release stay withheld. This includes messages from unrelated sessions. Sending the same text again does not authorize it.

A teammate that started while enforcement was off stays unchecked. A checked lead does not send it messages. Start a new teammate, under a new name, to continue its work under the policy. OpenAPPA checks each teammate from its own spawn, so it refuses a second teammate under a name the session already used.

## Yells

Yells report confusing blocks or remedies. Archestra saves each report and its compressed diagnostic archive locally. When analytics is enabled, reports also go to the shared OpenAPPA reporting service. Set `ARCHESTRA_ANALYTICS=disabled` to keep reports in your deployment.

Archestra also saves a local diagnostic when a blocked client cannot receive a remedy. These automatic reports stay in your deployment.

The overview counts unresolved reports. You can search reports, download their diagnostic archive, and investigate them with the configuration agent. **Investigate in chat** attaches the archive to a new chat, where the agent can read its diagnostic contents. Opening a chat leaves the report unresolved. Mark it resolved after verifying the fix; you can reopen it later.

Existing reports sent before native storage was enabled are not imported.

## Connect GitHub

A policy controls every agent, so changes to it should be reviewed like code. Connect a GitHub repository and the configuration agent opens pull requests instead of saving changes. A change applies once it's merged.

Administrators can create a private repository from the [OpenAPPA configuration template](https://github.com/archestra-ai/openappa-config). Start in the setup chat, on **OpenAPPA → Overview**, or under **Settings → OpenAPPA**. The chat uses a connected organization GitHub App, or opens the same credential dialog used in Settings to add one. Install the App on the GitHub account that will own the new repository. Select **All repositories** so it can access repositories created later. Give it **Read & write** access to Administration, Contents, and Pull requests. Enter the repository as `owner/name`. Archestra copies the template and writes your current policy to `appa.toml`, including battery declarations. Sync starts immediately. If creation succeeds but seeding fails, retry with the same repository. Archestra resumes only when its policy still matches the template. You can also connect an existing repository.

The template checks policy structure on each pull request. Add [trajectory tests](https://www.openappa.com/validation) under `traces/` to check allowed and refused decisions. Require the validation check in GitHub branch protection. The agent creates pull requests for later changes. The new policy takes effect after the pull request merges and sync succeeds. Changes that swap a battery's credential or drop a battery also need an administrator to accept them in Archestra.

Template updates apply to repositories created afterward. Existing repositories keep their own policy and CI files. To roll out a template fix, propose a separate pull request in each existing repository and review it there. Never replace a deployment policy with the template example.

## Example Setup

An administrator creates a starter policy for a new deployment, then connects the organization's GitHub App in chat. They create a private `openappa-policy` repository. The current policy becomes its first `appa.toml`; the next requested rule change opens a pull request for review.

## MCP Servers and Tool Coverage

The starting policy leaves most tools without a rule. The coverage chart shows how far along you are:

| Coverage | Meaning |
| --- | --- |
| Custom rule | Covered by your own policy. |
| Battery rule | Covered by an attached battery. |
| Not enforced | A battery should cover it but can't run yet. |
| No rule | Not covered. |

The table below it shows coverage per MCP server. Start with the servers that read private data or send data out. Click Ask next to a server and describe what its tools may do — "CRM tools only send data inside the company", for example. The agent proposes rules for you to review.

## Batteries

A battery is a ready-made policy for one MCP server, such as GitHub. Attach it and that server's tools are covered without writing rules.

The Batteries card shows which batteries are active, broken, or available, and how much coverage you'd gain. Configure with chat attaches the ones that fit. The MCP server setup wizard also offers a matching battery when you install a server.

![Available batteries and their attachment actions](/docs/automated_screenshots/platform-openappa_batteries.webp)

Some batteries call the provider and need a credential. Batteries with scripts need the [code execution sandbox](./platform-code-sandbox). Until a battery has what it needs, it shows as broken.

See the [available batteries](https://www.openappa.com/available-batteries), or [write your own](https://www.openappa.com/write-a-battery).

## Policy TOML

Under the hood, the policy is a TOML file, `organization.appa.toml`. The Policy tab shows it and the batteries it includes. It's read-only — change it through the chat or a pull request.

![The organization policy source](/docs/automated_screenshots/platform-openappa_policy.webp)

The Effective policy tab shows what's actually enforced: your file plus its batteries. Check it after a change — it flags any battery that failed to load.

Changes apply to new conversations; running ones keep their policy. See the [policy reference](https://www.openappa.com/contracts) for every field.

<a id="client-support-matrix"></a>

## Clients

Guardrails follow a session across model turns and subagents. For that, the proxy must know which session each request belongs to. It knows this for a recognized client — one with built-in support, or one that sends a session header.

| Client | How Guardrails Recognize It |
| --- | --- |
| Archestra Chat | Built-in support |
| Claude Code | Built-in support |
| Codex CLI | Built-in support |
| OpenCode | Built-in support |
| Cursor | Session header (built-in support is planned) |
| GitHub Copilot CLI | Session header (built-in support is planned) |
| n8n | Session header (built-in support is planned) |
| Claude Desktop | Session header (built-in support is planned) |
| Any other client | Session header |

The table covers the clients on the [Connection page](./platform-connection).

<a id="unsupported-clients"></a>

### Unrecognized Clients

Guardrails cannot follow the sessions of an unrecognized client, so they cannot check its tool calls. The Client coverage tile on the Overview tab sets what the proxy does with its requests:

![The Client coverage tile on the Guardrails Overview tab](/docs/automated_screenshots/platform-ai-tool-guardrails_client_coverage.webp)

- **Allowed** (default): the request reaches the model without checks.
- **Blocked**: the proxy rejects the request with HTTP 400 before it calls the model. The error tells the user to add a session header.

<a id="custom-session-headers"></a>

### Session Headers

A session header tells the proxy which session a request belongs to. Add it to every request your client sends to the [LLM proxy](./platform-llm-proxy):

- `X-Appa-Session-ID`: one ID for each conversation or task — a UUID, for example. Required.
- `X-Appa-Parent-ID`: the session ID of the parent agent. Send it only from a subagent.

The examples below create one client for each conversation:

```python
# Python, OpenAI SDK
import uuid
from openai import OpenAI

client = OpenAI(
    base_url="https://archestra.example.com/v1/openai",
    api_key="your-virtual-key",
    default_headers={"X-Appa-Session-ID": str(uuid.uuid4())},
)
```

```javascript
// Node.js, Anthropic SDK
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "https://archestra.example.com/v1/anthropic",
  apiKey: "your-virtual-key",
  defaultHeaders: { "X-Appa-Session-ID": randomUUID() },
});
```

```bash
# cURL
curl https://archestra.example.com/v1/openai/chat/completions \
  -H "Authorization: Bearer your-virtual-key" \
  -H "X-Appa-Session-ID: 7f3c9b2e-5d41-4c1a-9e0f-2a8b6c4d1e93" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}'
```
