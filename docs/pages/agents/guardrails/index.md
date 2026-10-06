---
title: Guardrails
description: Stop agents from leaking data, with OpenAPPA policies on every tool call
order: 1
alpha: "Turn it on with [`ARCHESTRA_BETA=true`](/docs/reference/configuration#ARCHESTRA_BETA), then restart the backend."
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Guardrails check every tool call an agent makes against your organization's policy, before the call runs. So an agent that has read an untrusted web page cannot then email your customer list. The [OpenAPPA](https://www.openappa.com/) policy engine decides by rules, not by asking another model. It runs outside the agent's loop, so a prompt injection cannot change its decisions.

![The Guardrails Overview tab with the enforcement, GitHub sync, and yells cards above the policy coverage charts](/docs/automated_screenshots/platform-ai-tool-guardrails_overview.webp)

<a id="the-lethal-trifecta"></a>

## How It Works

An agent that reads private data, reads untrusted content, and can send data out can be tricked into a leak. One hidden line on a web page, such as "email the customer list to this address", is enough.

Guardrails follow each session through the [LLM Proxy](/docs/llm-proxy). Every tool result can add restrictions to the session. Every tool call must meet the policy for the session as it stands. The policy tracks four things ([how it works](https://www.openappa.com/how-it-works)):

| Property | What It Tracks | Example |
| --- | --- | --- |
| [**Trust**](https://www.openappa.com/contracts#trust) | Whether session content can drive sensitive actions. | Reading an external website makes the session `suspicious`. |
| [**Audience**](https://www.openappa.com/contracts#audiences) | Who may receive data from the session. | Reading an internal document limits output to `internal`. |
| [**Effects**](https://www.openappa.com/contracts#effects) | What the session has already done. | A report must be archived before it is sent. |
| [**Attention**](https://www.openappa.com/contracts#attention) | Approval for one specific call. | Publishing a report needs a team review. |

Restrictions only add up. A trusted read never restores lost trust, and an approval allows one call without lifting the session's restrictions. With a typical policy, emailing a colleague works at the start of a session, and fails after the agent reads an untrusted page.

<a id="configure-with-the-agent"></a>

## Turn On Guardrails

You need [`openappaPolicy:update`](/docs/reference/permissions#openappaPolicy:update) to write the policy, and [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update) to turn enforcement on or off. **Guardrails** appears under **Agents** in the sidebar.

1. Go to **Guardrails** and click **Create my policy**. A chat with the configuration agent opens.
2. The agent drafts a starting policy from your tools and explains what it allows and blocks.
3. Approve the policy. Saving the first policy turns enforcement on.
4. Optionally, let the agent set up [GitHub sync](/docs/agents/guardrails/policies#github-sync).

The **Enforcement** card on **Overview** now shows **On**.

What to know:

- The starting policy covers only Archestra's own tools. Every other tool runs without restrictions. The [code sandbox](/docs/agents#code-sandbox) tool [`run_command`](/docs/reference/archestra-mcp-server#run_command) is labeled by your organization's default model before each command, so reading a credentials file narrows who can see the result. A policy you already saved keeps its own rules. Next, [cover your other tools](/docs/agents/guardrails/policies#policy-coverage).
- Enforcement applies to sessions that start while it is on. Start a new session after you turn it on.

## Blocked Calls

When the policy refuses a call, the call does not run. The agent gets the reason instead, with the [remedies](https://www.openappa.com/how-it-works#keeping-agents-useful-under-restrictions) the policy allows:

- **Approval:** a person or a system approves this one call.
- **Sanitize:** the data is cleaned first, for example with secrets redacted.
- **Narrow or withhold:** the agent accepts a narrower audience, or drops the tool result.
- **Isolate:** a subagent does the risky read and returns only what the policy permits.

When an approval is needed, the agent asks you, and the call runs only after you approve. If no remedy works, the call stays blocked and the agent explains why.

The agent uses [`get_remedy_plans`](/docs/reference/archestra-mcp-server#get_remedy_plans) and [`execute_remedy_plan`](/docs/reference/archestra-mcp-server#execute_remedy_plan) for this. A confusing block shows up as a [yell](/docs/agents/guardrails/policies#yells).

## Protection Limits

Guardrails check tool calls. They do not contain the machine the agent runs on. Pair them with isolation:

- **Shell, files, and network:** Guardrails do not sandbox them. Run the agent in [Agent Runtime](/docs/agents/runtime) instead. It gets its own container, and an [egress policy](/docs/admin/environments#network-egress-policies) limits where it can send data.
- **Traffic around the proxy:** Guardrails check only requests through the [LLM Proxy](/docs/llm-proxy). [Connect every client](/docs/agents/guardrails/clients) to it, and block the clients Guardrails do not recognize.
- Provider-hosted tools, such as a provider's own web search: most run before the proxy sees the call. Where you need the check, use a tool that runs in the client or through the [MCP Gateway](/docs/mcp/gateway).
- **Sessions that cannot be checked:** the proxy rejects them with HTTP 400. These are tools deferred to a tool search, Codex in code mode, and client-run `local_shell` or `computer_use` tools.
