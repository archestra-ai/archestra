---
title: Guardrails
category: LLM Proxy
order: 5
description: Enable and operate OpenAPPA tool guardrails in Archestra
lastUpdated: 2026-09-28
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

On a fresh install, the page asks you to create a policy. A chat drafts one from your tools. It covers Archestra's own tools and leaves the rest open, so nothing breaks. Review it and approve — enforcement turns on.

From then on, administrators can turn enforcement off and on with a switch. The policy stays as it is. Ask about the policy explains what it does.

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
