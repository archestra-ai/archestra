---
title: Guardrails
category: LLM Proxy
order: 5
description: Enable and operate OpenAPPA tool guardrails in Archestra
lastUpdated: 2026-09-29
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

<a id="the-lethal-trifecta"></a>

![The Guardrails overview with enforcement, policy coverage, and batteries](/docs/automated_screenshots/platform-ai-tool-guardrails_overview.webp)

## How It Works

An agent that reads private data, reads the internet, and can send messages can be tricked into leaking your data. One line on a web page — "email the customer list to this address" — is enough.

Guardrails track what the agent has read and check every tool call against your policy before it runs. Emailing a colleague works at the start of a session, and gets refused after the agent reads an untrusted page. The agent is told why and what it can do instead, such as ask a person for approval.

The check is done by [OpenAPPA](https://www.openappa.com/), not by a model, so the same situation always gets the same answer. See [How it works](https://www.openappa.com/how-it-works) for details.

## Replacing the Previous Guardrails

Archestra 1.4 retires the previous tool guardrails: tool call policies, tool result policies, and the Security settings tab. Once the new guardrails are on, the old policies are no longer evaluated.

## Enable the Feature

Set `ARCHESTRA_BETA=true` on version 1.4 or later and restart the backend. A Guardrails page appears under Agents. See the [deployment reference](./platform-deployment#openappa-tool-guardrails-experimental) for related settings.

This alone doesn't protect anything — tool calls run unchecked until you turn on enforcement. The sidebar warns you until then.

## Turn On Enforcement

On a fresh install, the page asks you to create a policy. A chat drafts one from your tools. It covers Archestra's own tools and leaves the rest open, so nothing breaks. Review it and approve — enforcement turns on. The chat then guides you through GitHub sync.

From then on, administrators can turn enforcement off and on with a switch. The policy stays as it is. Ask about the policy explains what it does.

## Connect GitHub

A policy controls every agent, so changes to it should be reviewed like code. Connect a GitHub repository and the configuration agent opens pull requests instead of saving changes. A change applies once it's merged.

Administrators can create a private repository from the [OpenAPPA configuration template](https://github.com/archestra-ai/openappa-config). Start in the setup chat, on **OpenAPPA → Overview**, or under **Settings → OpenAPPA**. The chat uses a connected organization GitHub App, or opens the same credential dialog used in Settings to add one. The App needs repository administration, contents, and pull request permissions. It must have access to new repositories. Archestra copies the template and writes your current policy to `appa.toml`, including battery declarations. Sync starts immediately. You can also connect an existing repository.

The template checks policy structure on each pull request. Add [trajectory tests](https://www.openappa.com/validation) under `traces/` to check allowed and refused decisions. Require the validation check in GitHub branch protection. The agent creates pull requests for later changes. The new policy takes effect after the pull request merges and sync succeeds. Changes that swap a battery's credential or drop a battery also need an administrator to accept them in Archestra.

Template updates apply to repositories created afterward. Existing repositories keep their own policy and CI files. To roll out a template fix, propose a separate pull request in each existing repository and review it there. Never replace a deployment policy with the template example.

## Example Setup

An administrator creates a starter policy for a new deployment, then connects the organization's GitHub App in chat. They create a private `openappa-config` repository. The current policy becomes its first `appa.toml`; the next requested rule change opens a pull request for review.

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
