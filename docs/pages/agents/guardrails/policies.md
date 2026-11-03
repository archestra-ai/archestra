---
title: Managing the Policy
description: Change the Guardrails policy with the APPA Keeper, include batteries, and validate it
order: 1
beta: "Policy syntax and behavior may change as OpenAPPA evolves."
lastUpdated: 2026-11-03
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

You manage the policy by chatting with the APPA Keeper: change rules in plain words, add [batteries](#batteries) for your MCP servers, check the policy with [validations](#validating-the-policy), and fix what keeps agents [stuck](#yells).

<a id="change-the-policy"></a>

<span id="keep-a-policy-snapshot-for-new-sessions"></span>

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

- The Break the glass settings in **Settings → Guardrails** can let a blocked call through and record the yell for you. **Human approval** keeps the review by default. Set to **Waive in unattended sessions** (Agent Runtimes, Scheduled tasks, or any client sending `X-Archestra-Unattended: 1`; a remedy plan a workload runs counts too), a call that waits for a person runs, and a remedy plan that needs a person is approved for the agent. It can also be waived everywhere. **Soft block**, set to **Waive the block**, lets through calls no approval can lift, except the `blocked` mark. OpenAPPA does not see a waived call: its result is not checked, and its labels and effects are skipped.
- By default, every yell also turns Guardrails off for its session: the agent's own, and the one recorded for a waived call. To keep checking after the first one, set **Yell tool** to **Record only**.
- Reports stay in your deployment unless you [enable external diagnostic forwarding](/docs/admin/deployment/configuration#ARCHESTRA_OPENAPPA_YELL_FORWARDING_ENABLED) to the shared OpenAPPA reporting service. To turn reports off, set [`ARCHESTRA_OPENAPPA_YELL_ENABLED=false`](/docs/admin/deployment/configuration#ARCHESTRA_OPENAPPA_YELL_ENABLED).

Required permissions:

- [`log:read`](/docs/reference/permissions#log:read) to see and resolve yells.
