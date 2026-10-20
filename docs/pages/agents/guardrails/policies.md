---
title: Guardrail Policies
sidebarTitle: Policies
description: Cover your tools with rules and change the policy by describing what you want
order: 1
beta: "Policy syntax and behavior may change as OpenAPPA evolves."
lastUpdated: 2026-10-20
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Describe the rule you want in plain words, such as "CRM tools only send data inside the company", and the configuration agent writes it into your policy. The policy combines your own rules with [batteries](/docs/agents/guardrails/batteries), ready-made rules for common MCP servers. You can still read every rule in [OpenAPPA](https://www.openappa.com/contracts) format.

## Policy Coverage

The **Rules annotate your tools** chart on **Overview**, and the **Tool coverage** column under **MCP servers**, show which of your tools a rule covers. Start with the servers that read private data or send data out.

| Coverage | Meaning |
| --- | --- |
| **Custom rule** | A rule in your own policy. |
| **Battery rule** | A rule from a [battery](/docs/agents/guardrails/batteries). |
| **Catch-all rule** | A wildcard rule classifies the call. The starting policy's catch-all asks the annotator model. |
| **Not enforced** | A battery covers the tool but cannot run yet. |
| **No rule** | No rule reaches the tool, so its calls always run. |

Under **MCP servers**, click **Improve** on a server or a tool, and the agent proposes rules for it.

## Change the Policy

Any chat button on the Guardrails pages opens the configuration agent.

1. Describe the change, such as "require a review before anything is posted to Slack".
2. Review the change and approve it.

On the **Policy** tab, **Source** shows your policy text. **Effective** shows the policy that runs, with batteries included.

![The Policy tab showing the organization policy source](/docs/automated_screenshots/platform-openappa_policy.webp)

A rule says what a tool's result adds to the session (`delta`) and what a call needs (`requires`). Here, internal reads limit the audience, and public posts need a trusted session that may go public:

```toml
[[policy.tool]]
name = "docs__read_internal"
delta = { audience = ["internal"] }

[[policy.tool]]
name = "blog__publish_post"
requires = { trust = "trusted", audience = { contains = ["public"] } }
```

What to know:

- Running sessions take a change at their next tool call, unless they keep a snapshot. A review asked under the earlier revision is withdrawn, and the agent asks again.
- A change that fails keeps the last valid policy running. **Effective** shows the error.
- With [Git sync](/docs/agents/guardrails/git-sync), a change opens a pull request instead of saving.

For every field, see the [policy reference](https://www.openappa.com/contracts).

### Keep a Policy Snapshot for New Sessions

A snapshot stops policy changes from reaching sessions that are already running. Go to **Settings → Guardrails** and set **Policy for new sessions**:

- **New sessions reference the live policy** (the default): sessions take each policy change at their next tool call.
- **New sessions keep a policy snapshot**: a new session keeps the policy it opens with until it ends. A change reaches new sessions only.

The chat shows **policy snapshot** for a session that keeps one. Changing the setting needs [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update).

## Human Review

Ask for a person's approval on calls that are destructive or publish outside the company, not on every call. Mark them in the rule with `requires = { attention = ["human-approval"] }`. The starting policy's reviewer covers this mark, data below `trusted`, and a missing `public` audience.

- **Chat and coding agents:** the agent asks you, and the call runs only after you approve. See [approval cards](/docs/agents/guardrails/clients#approval-cards).
- **Slack, Microsoft Teams, and Telegram:** the agent posts the review in the conversation with **Approve** and **Deny**. Only the person who sent the message can answer, within 24 hours.
- **[A2A](/docs/agents/triggers-and-channels/webhook-a2a#approving-tool-calls):** the task pauses and the caller answers.

A policy saved before the starting policy had this reviewer keeps its own. Copy the `human-approval` authority from the starting policy into it to get the default.

<a id="blocked-calls"></a>

## Unblock a Call

A refused call does not run. The agent gets the reason, with the [remedies](https://www.openappa.com/how-it-works#keeping-agents-useful-under-restrictions) the policy allows:

- **Approval:** a person or a system approves this one call.
- **Sanitize:** the data is cleaned first, for example with secrets redacted.
- **Narrow or withhold:** the agent accepts a narrower audience, or drops the tool result.
- **Isolate:** a subagent does the risky read and returns only what the policy permits.

The agent uses [`get_remedy_plans`](/docs/reference/archestra-mcp-server#get_remedy_plans) and [`execute_remedy_plan`](/docs/reference/archestra-mcp-server#execute_remedy_plan) for this. If no remedy works, the call stays blocked.

## Yells

When the agent keeps getting blocked, or a remedy makes no sense, it reports the problem with the [`yell`](/docs/reference/archestra-mcp-server#yell) tool. The **Yells** tab lists the reports for anyone with [`log:read`](/docs/reference/permissions#log:read).

1. Open a report and click **Investigate in chat**. The agent compares the report with the policy and the [validations](/docs/agents/guardrails/validations), and proposes a fix.
2. Approve the fix, then click **Mark resolved**.

What to know:

- With **Break the glass** on in **Settings → Guardrails** (the default), a yell also turns Guardrails off for that session, so the agent is no longer stuck. The list marks these yells.
- The list shows unresolved reports. Set the status filter to **Resolved** to see or reopen the others.
- Reports stay in your deployment. With analytics on, they also go to the shared [OpenAPPA reporting service](https://www.openappa.com/yell). To keep them local, set [`ARCHESTRA_ANALYTICS=disabled`](/docs/reference/configuration#ARCHESTRA_ANALYTICS). To turn reports off, set [`ARCHESTRA_OPENAPPA_YELL_ENABLED=false`](/docs/reference/configuration#ARCHESTRA_OPENAPPA_YELL_ENABLED).
