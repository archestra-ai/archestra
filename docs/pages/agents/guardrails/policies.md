---
title: Guardrail Policies
sidebarTitle: Policies
description: Cover your tools with rules, change the policy, and sync it with GitHub
order: 1
alpha: "Turn it on with [`ARCHESTRA_BETA=true`](/docs/reference/configuration#ARCHESTRA_BETA), then restart the backend."
lastUpdated: 2026-10-07
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

## GitHub Sync

With GitHub sync, the policy lives in a repository. The agent opens a pull request instead of saving, and a change applies once it is merged.

1. On **Overview**, click **Create repository** on the **GitHub sync** card.
2. Choose a GitHub App, and enter the owner and repository name.
3. Archestra creates a private repository from the [configuration template](https://github.com/archestra-ai/openappa-config) and starts syncing.

The **GitHub sync** card shows **Connected**. Manage it under **Settings → OpenAPPA**.

What to know:

- Setting up sync needs [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update).
- **The GitHub App** must be installed on the owner with **All repositories**, and **Read & write** on Administration, Contents, and Pull requests. The setup chat can create it.
- Each pull request is validated. Add [trajectory tests](https://www.openappa.com/validation) to check what the policy allows and refuses.
- A pull request that changes a battery credential waits until someone with [`credential:update`](/docs/reference/permissions#credential:update) clicks **Accept repository text** on **Batteries**.

## Yells

When an agent finds a block confusing, it reports it with the [`yell`](/docs/reference/archestra-mcp-server#yell) tool. See [Reporting](https://www.openappa.com/yell). The **Yells** tab lists the reports for anyone with [`openappaDiagnostics:read`](/docs/reference/permissions#openappaDiagnostics:read). The list shows unresolved reports. To see a resolved report or reopen it, set the status filter to **Resolved**. The link keeps the filter, so you can share it. Click **Investigate in chat** to have the agent propose a fix, then **Mark resolved**, which needs [`openappaDiagnostics:update`](/docs/reference/permissions#openappaDiagnostics:update).

Once you confirm the fix, the agent can also mark the report resolved for you in the chat. Each report lists the chats you opened to investigate it, so you can pick one up again.

Reports stay in your deployment. With analytics on, they also go to the shared OpenAPPA reporting service. To keep them local, set [`ARCHESTRA_ANALYTICS=disabled`](/docs/reference/configuration#ARCHESTRA_ANALYTICS). To turn reports off, set [`ARCHESTRA_OPENAPPA_YELL_ENABLED=false`](/docs/reference/configuration#ARCHESTRA_OPENAPPA_YELL_ENABLED).
