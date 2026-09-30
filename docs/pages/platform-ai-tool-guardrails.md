---
title: Guardrails
category: LLM Proxy
order: 5
description: Enable and operate OpenAPPA tool guardrails in Archestra
lastUpdated: 2026-09-30
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

<a id="the-lethal-trifecta"></a>

![The Guardrails overview with enforcement, policy coverage, and batteries](/docs/automated_screenshots/platform-ai-tool-guardrails_overview.webp)

## How It Works

An agent that reads private data, reads the internet, and can send messages can be tricked into leaking your data. One line on a web page — "email the customer list to this address" — is enough.

For supported clients, Guardrails track what agents read and check their tool calls against your policy before they run. Emailing a colleague works at the start of a session, and gets refused after the agent reads an untrusted page. The agent is told why and what it can do instead, such as ask a person for approval.

The check is done by [OpenAPPA](https://www.openappa.com/), not by a model, so the same situation always gets the same answer. See [How it works](https://www.openappa.com/how-it-works) for details.

## Replacing the Previous Guardrails

Archestra 1.4 retires the previous tool guardrails: tool call policies, tool result policies, and the Security settings tab. Once the new guardrails are on, the old policies are no longer evaluated.

## Enable the Feature

Set `ARCHESTRA_BETA=true` on version 1.4 or later and restart the backend. A Guardrails page appears under Agents. See the [deployment reference](./platform-deployment#openappa-tool-guardrails-experimental) for related settings.

This alone doesn't protect anything — tool calls run unchecked until you turn on enforcement. The sidebar warns you until then.

## Turn On Enforcement

On a fresh install, the page asks you to create a policy. A chat drafts one from your tools. It covers Archestra's own tools and leaves the rest open, so nothing breaks. Review it and approve — enforcement turns on.

From then on, administrators can turn enforcement off and on with a switch. The policy stays as it is. Ask about the policy explains what it does.

Turning enforcement on also applies to sessions that are already running. If a subagent in such a session finished while enforcement was off, the proxy refuses the session's later requests. Start a new session to continue — or rewind the conversation to before the subagent ran. A teammate that started while enforcement was off is refused, and its earlier messages are withheld from the lead. Start a new teammate to continue its work.

## Subagents and Teammates

A subagent's answer reaches its session only through a return check. Before the subagent starts, the session declares what the answer may carry.

Claude Code teammates pass the same check. A teammate's message to its lead crosses the check, and the lead takes on the message's restrictions. A lead's message to a teammate carries the lead's restrictions to the teammate — after the lead reads a private report, for example, the teammate it messages cannot post it publicly either.

The model reads a message only if it passed the check on its way. Any other message is withheld, and the model reads a notice in its place. Messages from other sessions are always withheld.

A teammate that started while enforcement was off cannot be checked. OpenAPPA refuses its requests and does not send it messages. Start a new teammate to continue its work.

## Client Support Matrix

Guardrails track session history across model turns and child agents. To track a session, the proxy needs to identify the client and its session boundary.

The table below shows Guardrails support for each client available on the [Connection page](./platform-connection):

| Client | Guardrails Support |
| --- | --- |
| Claude Code | Native support |
| Codex CLI | Native support |
| OpenCode | Native support |
| Cursor | Upcoming support planned (requires [custom session headers](#custom-session-headers) today) |
| GitHub Copilot CLI | Upcoming support planned (requires [custom session headers](#custom-session-headers) today) |
| n8n | Upcoming support planned (requires [custom session headers](#custom-session-headers) today) |
| Claude Desktop | Upcoming support planned (requires [custom session headers](#custom-session-headers) today) |
| Custom / Generic Clients | Requires [custom session headers](#custom-session-headers) |

### Unsupported Clients

Clients without native support or session headers cannot maintain a guardrail session today. Native support for additional clients is actively planned.

On the Guardrails Overview tab, administrators choose how the proxy handles these requests:

![The setup cards on the Guardrails Overview tab with the unsupported clients setting](/docs/automated_screenshots/platform-ai-tool-guardrails_setup_cards.webp)

- **Bypass** (default): The request bypasses policy checks and reaches the model. Bypass is the default during the Guardrails v2 beta prior to general availability.
- **Block**: The proxy rejects the request with HTTP 400 before calling the model.

### Custom Session Headers

Custom session headers link model requests and tool results into one trajectory. Without a session header, the proxy cannot link related turns.

OpenAPPA uses two HTTP request headers:

- `X-Appa-Session-ID`: A unique, persistent identifier for the conversation or task (such as a UUID). Send this on every request of a session to link turns and tool calls together.
- `X-Appa-Parent-ID`: An optional identifier linking a subagent or child task to its parent trajectory. Send this when an agent spawns a child session; omit it for root sessions.

To configure an arbitrary client, pass `X-Appa-Session-ID` with every request to the LLM proxy:

```python
# Python OpenAI SDK example
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:9000/v1",
    api_key="your-virtual-or-provider-key",
    default_headers={"X-Appa-Session-ID": "session-12345"},
)
```

```javascript
// Node.js Anthropic SDK example
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://localhost:9000/v1",
  apiKey: "your-virtual-or-provider-key",
  defaultHeaders: { "X-Appa-Session-ID": "session-12345" },
});
```

```bash
# cURL example
curl http://localhost:9000/v1/chat/completions \
  -H "Authorization: Bearer your-virtual-or-provider-key" \
  -H "X-Appa-Session-ID: session-12345" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}'
```

## Connect GitHub

A policy controls every agent, so changes to it should be reviewed like code. Connect a GitHub repository and the configuration agent opens pull requests instead of saving changes. A change applies once it's merged.

You can also run policy tests as a [required CI check](https://www.openappa.com/validation#make-policy-tests-a-required-ci-check), so a bad change fails before it's merged. Changes that swap a battery's credential or drop a battery also need an administrator to accept them in Archestra.

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
