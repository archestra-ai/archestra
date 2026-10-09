---
title: Guardrail Policies
sidebarTitle: Policies
description: Cover your tools with rules, change the policy, and sync it with GitHub
order: 1
alpha: "Policy syntax and behavior may change as OpenAPPA evolves."
lastUpdated: 2026-10-09
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Your policy decides which tool calls an agent can make, and when. It combines your own rules with [batteries](/docs/agents/guardrails/batteries), ready-made rules for common MCP servers.

Let the configuration agent do the work. Describe what you want in plain words, such as "CRM tools only send data inside the company". The agent writes the rules for you. You can still read every rule in [OpenAPPA](https://www.openappa.com/contracts) format.

## Policy Coverage

The **Tool coverage** chart on **Overview** shows how many of your tools a rule covers:

| Coverage | Meaning |
| --- | --- |
| **Custom rule** | A rule in your own policy. |
| **Battery rule** | A rule from a [battery](/docs/agents/guardrails/batteries). |
| **Catch-all rule** | A wildcard rule that classifies the call. |
| **Not enforced** | A battery covers the tool but cannot run yet. |
| **No rule** | Nothing restricts the tool. The starting policy's catch-all counts here, because it adds no restrictions. |

Start with the servers that read private data or send data out. Under **MCP servers**, click **Ask** on a server to have the agent propose rules for its tools. **Improve with chat** does the same for all your tools.

## Change the Policy

1. Click any chat button on the Guardrails pages.
2. Describe the change, such as "require a review before anything is posted to Slack".
3. Review the change and approve it.

The **Policy** tab shows the source. **Effective** shows the policy that runs, with batteries included.

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

- Changes apply to new conversations. Running ones keep the policy they started with.
- A change that fails keeps the last valid policy running. **Effective** shows the error.
- Changing the policy needs [`openappaPolicy:update`](/docs/reference/permissions#openappaPolicy:update). Turning enforcement on or off needs [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update).

For every field, see the [policy reference](https://www.openappa.com/contracts).

## Human Review

Use `requires = { attention = ["human-approval"] }` for potentially destructive actions or publishing outside the company, not every tool call. The starting policy includes a reviewer for this mark.

## GitHub Sync

With GitHub sync, the policy lives in a repository. The agent opens a pull request instead of saving, and a change applies after merge and successful sync.

1. On **Overview**, click **Create repository** on the **GitHub sync** card.
2. Choose a GitHub App, and enter the owner and repository name.
3. Archestra creates a private repository from the [configuration template](https://github.com/archestra-ai/openappa-config) and commits your current policy. If repository rules block the commit, it opens a pull request instead.
4. If a pull request is needed, click **Review and merge PR**, wait for the repository checks to pass, and merge it. The dialog stays open and keeps checking for the merge; click **Check if merged** to check right away. Your current policy stays active until then.

To use a repository you already have, click **Connect existing repository** in the same dialog, or ask the setup chat. The policy file in that repository replaces the current policy.

The **GitHub sync** card shows **Connected** after setup. When a pull request is needed, it shows **Awaiting initial merge** until the initial policy is merged and synced. Manage it under **Settings → OpenAPPA**.

What to know:

- Setting up sync needs [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update).
- **The GitHub App** must be installed on the owner with **All repositories**, and **Read & write** on Administration, Contents, and Pull requests. The setup chat can create it.
- For an existing repository configured with a PAT, read access supports sync. Publishing policy or validation changes also needs Contents and Pull requests **Read & write**. Creating a repository through the setup flow requires a GitHub App.
- A pull request that changes a battery credential waits until someone with [`credential:update`](/docs/reference/permissions#credential:update) clicks **Accept repository text** on **Batteries**.

## Validations

Keep a policy assumption checked over time, such as refusing an email after an agent reads untrusted data. Open **View Validations** on **Overview** to review the latest saved run, or use the **Validations** tab.

1. Click **Add validation** to write a `.appa` scenario, or **Ask About Validations** for guided help.
2. Review the expected decisions and run the draft from its editor.
3. Save locally, or commit the file to the configured Git repository.
4. Click **Run all** to check every saved file and retain the result in run history.

Each file describes ordered tool calls and expected decisions. Calls in one file share session state; separate files start fresh. Replay uses the effective policy, including batteries, without executing tools, models or external helpers. See the [OpenAPPA validation guide](https://www.openappa.com/validation) for the format.

What to know:

- **Results:** the table shows **Passed** or **Failed** and the last run time. A file that cannot run appears as **Failed**, with its reason: replay stops at the first call that needs a live answer, such as the [`run_command`](/docs/reference/archestra-mcp-server#run_command) model label, human review, or a team membership lookup. Open a history run for details; results apply to the policy and files captured by that run.
- **Drafts:** **Run file** checks only the current editor text. Its temporary result does not change saved suite results or history. Search filters and unsaved drafts do not change **Run all**.
- **Policy changes:** accepted changes from local saves or GitHub sync automatically queue the full suite. Unchanged syncs and validation-only edits do not trigger runs. Validation failures do not block or roll back a policy; configure repository CI if failures should block merges.

### Git-Backed Validations

With sync enabled, Git is the only source of truth for validation files. Archestra loads them from the same accepted commit as the policy, with no local fallback.

Set the optional validation directory under **Settings → OpenAPPA → GitHub source**. Saving checks that the folder exists on the selected branch. Leave it empty to disable Git-backed validations and their automatic runs. Editor changes remain drafts you can preview and export for a repository commit.

### Ask the Configuration Agent

For an open-ended request, the agent discovers a few replayable examples and asks which observed behavior you want to preserve. Discovery checks single calls in fresh sessions; it does not prove broader protection or complete coverage. If discovery cannot prepare a check, it explains the missing input or unavailable dependency instead of inventing prerequisites.

After you choose a discovered example, the agent previews its exact file for review. A specific requirement uses normal drafting and replay, even when the assertion fails against the current policy. It saves only within your authorization. Validation-only requests leave the policy unchanged, and first-time policy setup skips validations unless requested.

For a concrete policy change, the agent can include a focused regression check and replay the full suite against the proposal. It preserves unrelated files and expectations. Publication saves policy and validations together locally, or opens one GitHub pull request; previews do not create saved run history.

## Yells

When an agent finds a block confusing, it reports it with the [`yell`](/docs/reference/archestra-mcp-server#yell) tool. See [Reporting](https://www.openappa.com/yell). The **Yells** tab lists the reports for anyone with [`openappaDiagnostics:read`](/docs/reference/permissions#openappaDiagnostics:read). The list shows unresolved reports. To see a resolved report or reopen it, set the status filter to **Resolved**. The link keeps the filter, so you can share it. Click **Investigate in chat** to have the agent propose a fix, then **Mark resolved**, which needs [`openappaDiagnostics:update`](/docs/reference/permissions#openappaDiagnostics:update).

The agent compares the report with the current policy and validations. A policy fix can include an essential regression check where offline replay represents the issue. Client and helper failures receive their own diagnosis rather than weaker policy.

Once you confirm the fix, the agent can mark the report resolved in the chat. A report keeps its investigation chat, so **Investigate in chat** opens it again.

Reports stay in your deployment. With analytics on, they also go to the shared OpenAPPA reporting service. To keep them local, set [`ARCHESTRA_ANALYTICS=disabled`](/docs/reference/configuration#ARCHESTRA_ANALYTICS). To turn reports off, set [`ARCHESTRA_OPENAPPA_YELL_ENABLED=false`](/docs/reference/configuration#ARCHESTRA_OPENAPPA_YELL_ENABLED).
