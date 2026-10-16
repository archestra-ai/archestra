---
title: Guardrail Policies
sidebarTitle: Policies
description: Cover your tools with rules, change the policy, and sync it with GitHub or GitLab
order: 1
beta: "Policy syntax and behavior may change as OpenAPPA evolves."
lastUpdated: 2026-10-15
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

While a revision is refused, the chart counts the earlier composition the runtime still enforces, and says so under the chart.

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

- Changes apply to new conversations. Running ones keep the policy they started with. A renamed or removed annotator stays available to them while one of them was active in the last 30 days ([`ARCHESTRA_OPENAPPA_KEPT_ANNOTATOR_HORIZON_DAYS`](/docs/reference/configuration#ARCHESTRA_OPENAPPA_KEPT_ANNOTATOR_HORIZON_DAYS)). **Effective** lists what it keeps.
- A change that fails keeps the last valid policy running. **Effective** shows the error.
- Changing the policy needs [`openappaPolicy:update`](/docs/reference/permissions#openappaPolicy:update). Turning enforcement on or off needs [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update).

For every field, see the [policy reference](https://www.openappa.com/contracts).

## Human Review

Use `requires = { attention = ["human-approval"] }` for potentially destructive actions or publishing outside the company, not every tool call. The starting policy's reviewer covers this mark, any other mark but `blocked`, data below `trusted`, and a missing `public` audience. A policy saved earlier keeps its reviewer; copy the `hitl` authority from the starting policy into it (or into `appa.toml` with GitHub sync) to get this default.

In Slack, Microsoft Teams, and Telegram, the agent pauses and posts the review in the conversation with **Approve** and **Decline** buttons. Only the person who sent the message can answer, within 24 hours. After that the action stays blocked. An approval lets the agent continue only when the policy allows it.

Over [A2A](/docs/agents/triggers-and-channels/webhook-a2a#approving-tool-calls), the task pauses and the caller answers.

<span id="github-sync"></span>

## Git Sync

With Git sync, the policy lives in a GitHub or GitLab repository, and every change gets reviewed there. Sync runs both ways: a change merged in the repository applies here, and a change made here opens a pull request (a merge request on GitLab) instead of saving.

1. Go to **Settings → Guardrails** and click **Set up Git sync**.
2. Pick **GitHub** or **GitLab**, then follow its steps below.

### GitHub

1. Enter the **GitHub URL**, either GitHub.com or your GitHub Enterprise Server address, and the **Organization**. Then choose one:
   - **Start fresh:** click **Create on GitHub** to create a private repository from the [OpenAPPA template](https://github.com/archestra-ai/openappa-config). On GitHub Enterprise Server, create an empty private repository instead, and setup adds the OpenAPPA files.
   - **Use an existing repository:** one that already holds an OpenAPPA policy.
2. Pick a GitHub App: **Use an App I already have**, or **Create a new GitHub App**, which creates one on GitHub with no keys to copy. Install a new App on the policy repository only.
3. Choose the repository and click **Connect repository**. To change the **Branch**, **Policy file** (`appa.toml`), **Validations folder** (`traces`), or **Sync schedule**, open **Advanced** first.

If repository rules block the commit, setup opens an initial pull request instead, and your current policy stays active until it merges. Click **Review and merge**, and merge it once its checks pass. Until then, the Guardrails pages show **Merge your initial policy**.

### GitLab

Git sync works with gitlab.com and self-managed GitLab, through an access token with the `api` scope.

1. Pick a saved token, or click [**Add a GitLab token**](/docs/agents/skills/importing#private-repositories).
2. Choose the policy project. To change the branch, policy file, validations folder, or schedule, open **Advanced** first.
   - **New project:** pick a **Group**, or **Your namespace** for your own account, and enter a **Project name**. Click **Create project**. Setup creates a private project and adds the OpenAPPA files with your current policy.
   - **Existing project:** pick it and click **Connect project**.

If GitLab refuses the first commit to a protected branch, setup stops with an error. To fix it, use a token with the Maintainer role, or allow the initial push to that branch.

### Repository Checks

Before you connect, the dialog checks the repository or project:

- **OpenAPPA template**, **Empty repository**, or **Empty project:** setup copies your current policy into it.
- **Found appa.toml:** that file replaces your current policy.
- **No appa.toml:** pick another repository, or set the policy file under **Advanced**.
- **No access:** the App or token cannot read it. On GitHub, click **Change access** to fix it.

It also warns when the validations folder is missing. When setup is done, the card on **Settings → Guardrails** shows **Connected**.

After the configuration agent saves a policy, the banner in chat links to **Set up Git sync**. It opens this setup in a new tab.

What to know:

- Setting up sync needs [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update) and, to pick a saved App or token, [`credential:read`](/docs/reference/permissions#credential:read). Creating a GitHub App or saving a GitLab token also needs [`credential:create`](/docs/reference/permissions#credential:create).
- The GitHub App needs only the policy repository, with **Read & write** on Contents and Pull requests. On GitHub Enterprise Server, an App created in setup also gets Workflows **Read & write**.
- A merged change that gives a battery a credential waits for approval. Click **Review** in **Settings > Guardrails** or on **Batteries** to see each battery and its credential, then **Approve**, which needs **Can use** on every credential ([Granular Access Control](/docs/admin/access-control#granular-access-control)). To reject it, undo the change in GitHub or GitLab.

## Validations

Keep a policy assumption checked over time, such as refusing an email after an agent reads untrusted data. Open **View Validations** on **Overview** to review the latest saved run, or use the **Validations** tab.

1. Click **Add validation** to write a `.appa` scenario, or **Ask About Validations** for guided help.
2. Review the expected decisions and run the draft from its editor.
3. Save locally, or commit the file to the configured Git repository.
4. Click **Run all** to check every saved file and retain the result in run history.

Each file describes ordered tool calls and expected decisions. Calls in one file share session state; separate files start fresh. Replay uses the effective policy, including batteries. It runs no tools, but asks the policy's annotators, helpers and models live with your organization's credentials, so a run can spend model tokens. See the [OpenAPPA validation guide](https://www.openappa.com/validation) for the format.

What to know:

- **Results:** the table shows **Passed** or **Failed** and the last run time. A file that cannot run appears as **Failed**, with its reason: replay stops at the first call whose answer did not come, such as a model whose key is not set or a helper that cannot be reached. Replay asks no person: a step that expects `authority hitl` passes when the call offers human review. Open a history run for details; results apply to the policy and files captured by that run.
- **Drafts:** **Run file** checks only the current editor text. Its temporary result does not change saved suite results or history. Search filters and unsaved drafts do not change **Run all**.
- **Policy changes:** accepted changes from local saves or Git sync automatically queue the full suite. Unchanged syncs and validation-only edits do not trigger runs. Validation failures do not block or roll back a policy; configure repository CI if failures should block merges.

### Git-Backed Validations

With sync enabled, Git is the only source of truth for validation files. Archestra loads them from the same accepted commit as the policy, with no local fallback.

Set the validations folder under **Advanced** during setup, or later with **Edit source** on **Settings → Guardrails**. It defaults to `traces`. Validations run once the folder holds `.appa` files. Editor changes remain drafts you can preview and export for a repository commit.

### Ask the Configuration Agent

For an open-ended request, the agent discovers a few replayable examples and asks which observed behavior you want to preserve. Discovery checks single calls in fresh sessions; it does not prove broader protection or complete coverage. If discovery cannot prepare a check, it explains the missing input or unavailable dependency instead of inventing prerequisites.

After you choose a discovered example, the agent previews its exact file for review. A specific requirement uses normal drafting and replay, even when the assertion fails against the current policy. It saves only within your authorization. Validation-only requests leave the policy unchanged, and first-time policy setup skips validations unless requested.

For a concrete policy change, the agent can include a focused regression check and replay the full suite against the proposal. It preserves unrelated files and expectations. Publication saves policy and validations together locally, or opens one pull request (a merge request on GitLab); previews do not create saved run history.

## Yells

When a remedy plan makes no sense, an agent keeps getting blocked, the user keeps being asked to approve similar calls, or the user is frustrated, the agent reports it with the [`yell`](/docs/reference/archestra-mcp-server#yell) tool. See [Reporting](https://www.openappa.com/yell). With **Break the glass** on in **Settings → Guardrails**, a yell also turns Guardrails off for that session, so the agent is no longer stuck. A yell that did this is marked in the list. The **Yells** tab lists the reports for anyone with [`openappaDiagnostics:read`](/docs/reference/permissions#openappaDiagnostics:read). The list shows unresolved reports. To see a resolved report or reopen it, set the status filter to **Resolved**. The link keeps the filter, so you can share it. Click **Investigate in chat** to have the agent propose a fix, then **Mark resolved**, which needs [`openappaDiagnostics:update`](/docs/reference/permissions#openappaDiagnostics:update).

The agent compares the report with the current policy and validations. A policy fix can include an essential regression check where replay represents the issue. Client and helper failures receive their own diagnosis rather than weaker policy.

Once you confirm the fix, the agent can mark the report resolved in the chat. A report keeps its investigation chat, so **Investigate in chat** opens it again.

Reports stay in your deployment. With analytics on, they also go to the shared OpenAPPA reporting service. To keep them local, set [`ARCHESTRA_ANALYTICS=disabled`](/docs/reference/configuration#ARCHESTRA_ANALYTICS). To turn reports off, set [`ARCHESTRA_OPENAPPA_YELL_ENABLED=false`](/docs/reference/configuration#ARCHESTRA_OPENAPPA_YELL_ENABLED).
