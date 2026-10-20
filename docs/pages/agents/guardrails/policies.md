---
title: Managing the Policy
description: Change the Guardrails policy with the APPA Keeper, include batteries, and validate it
order: 1
beta: "Policy syntax and behavior may change as OpenAPPA evolves."
lastUpdated: 2026-10-20
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

You manage the policy by chatting with the APPA Keeper: change rules in plain words, add [batteries](#batteries) for your MCP servers, check the policy with [validations](#validating-the-policy), and fix what keeps agents [stuck](#yells).

<a id="change-the-policy"></a>

## Changing the Policy

You change the policy by chatting with the APPA Keeper, the built-in agent that writes the rules for you. On **Overview**, click **Chat with APPA Keeper**, or pick one of the suggested questions next to it.

Ask it in plain words, for example:

- "Require a review before anything is posted to Slack."
- "After the agent reads a web page, block sending email outside the company."

To see your policy, open the **Policy** tab, or ask the APPA Keeper to explain it.

![The Policy tab showing two rules: reading Slack limits the audience to internal, and a new issue in the public acme/sdk repository needs a public audience](/docs/automated_screenshots/platform-openappa_policy.webp)

A change that cannot be applied never turns Guardrails off. The last working policy stays enforced, and the **Policy** tab shows why the change was refused.

## Batteries

A [battery](https://www.openappa.com/batteries) is a ready-made set of rules for one MCP server, such as GitHub, Linear, or Google Workspace. Include one, and that server's tools are covered without writing rules.

Ask the APPA Keeper, for example "Cover my GitHub server with a battery". It proposes the batteries that fit your MCP servers, and you approve the change.

Some batteries call an API to decide, for example to check if a repository is public. Such a battery needs a token: the APPA Keeper asks you to set one up in the chat. You can also add it on the **Batteries** tab: open the battery and set its token under **Credentials**.

![The Batteries tab listing the batteries that ship with Archestra, with their status and servers](/docs/automated_screenshots/platform-openappa_batteries.webp)

<a id="validations"></a>

## Validating the Policy

A validation keeps one policy scenario checked over time, such as "refuse an email after the agent reads an untrusted page". The APPA Keeper runs your validations before every policy change, so a change that quietly weakens the policy shows up as a failed validation.

![The Validations tab listing two validations of the Slack rule, both passed](/docs/automated_screenshots/platform-openappa_validations.webp)

### Write a Validation

Ask the APPA Keeper to write one, for example "check that the agent cannot email outside the company after it reads a web page". Review the scenario it proposes, and approve it.

For more details about validations, check the [OpenAPPA validation guide](https://www.openappa.com/validation).

### Run Validations

Click **Run all** to check every saved file, or the run button on a row to check one. Every accepted policy change also runs them all.

What to know:

- A run executes no tools, but asks the policy's annotators and models live, with your organization's credentials. So a run can spend model tokens.
- A run asks no person. A step that expects human review passes when the call offers it.

Required permissions:

- [`guardrailsPolicy:update`](/docs/reference/permissions#guardrailsPolicy:update) to run validations.

## Yells

When the agent can't achieve its task because of the policy, it reports the problem via a special yell tool call. The **Yells** tab lists the reports.

![The Yells tab listing three agent reports, with who reported each and when](/docs/automated_screenshots/platform-openappa_yells.webp)

Open a report and click **Investigate in chat**. The agent compares the report with the policy and the [validations](#validating-the-policy), and proposes a fix.

What to know:

- With **Break the glass** on in **Settings → Guardrails** (the default), a yell also turns Guardrails off for that session, so the agent is no longer stuck. The list marks these yells.
- Reports stay in your deployment. With analytics on, they also go to the shared [OpenAPPA reporting service](https://www.openappa.com/yell). To keep them local, set [`ARCHESTRA_ANALYTICS=disabled`](/docs/reference/configuration#ARCHESTRA_ANALYTICS). To turn reports off, set [`ARCHESTRA_OPENAPPA_YELL_ENABLED=false`](/docs/reference/configuration#ARCHESTRA_OPENAPPA_YELL_ENABLED).

Required permissions:

- [`log:read`](/docs/reference/permissions#log:read) to see and resolve yells.
