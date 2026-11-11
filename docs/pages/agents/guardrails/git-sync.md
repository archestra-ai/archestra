---
title: Git Sync
description: Keep the Guardrails policy in a GitHub or GitLab repository and review every change there
order: 2
beta: "Policy syntax and behavior may change as OpenAPPA evolves."
lastUpdated: 2026-11-10
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

With Git sync, every policy change goes through a pull request in your own GitHub or GitLab repository. Sync runs both ways: a change merged in the repository applies here, and a change made here opens a pull request (a merge request on GitLab) instead of saving.

## Set Up Git Sync

1. Go to **Settings → Guardrails** and click **Set up Git sync**. After the APPA Keeper saves a policy, the banner in chat links here too.
2. Pick **GitHub** or **GitLab**, then follow its steps below.

When setup is done, the card on **Settings → Guardrails** shows **Connected**.

### GitHub

1. Enter the **GitHub URL**, either GitHub.com or your GitHub Enterprise Server address, and the **Organization**. Then choose one:
   - **Start fresh:** click **Create on GitHub** to create a private repository from the [OpenAPPA template](https://github.com/archestra-ai/openappa-config). On GitHub Enterprise Server, create an empty private repository instead, and setup adds the OpenAPPA files.
   - **Use an existing repository:** one that already holds an OpenAPPA policy.
2. Pick a GitHub App: **Use an App I already have**, or **Create a new GitHub App**, which creates one on GitHub with no keys to copy. Install it on the policy repository only. Tick **Self-service MCP Guardrails** here to let [MCP owners manage their servers' Guardrails](#self-service-mcp-guardrails); you can turn it on later too.
3. Choose the repository and click **Connect repository**. To change the **Branch**, **Policy file** (`appa.toml`), **Validations folder** (`traces`), or **Sync schedule**, open **Advanced** first.

The App needs **Read & write** on Contents and Pull requests, and on Workflows too on GitHub Enterprise Server. Self-service adds Checks and Administration. If repository rules block the first commit, setup opens a pull request instead, and your current policy stays active until it merges. Click **Review and merge**, and merge it once its checks pass.

### GitLab

Git sync works with gitlab.com and self-managed GitLab, through an access token with the `api` scope.

1. Pick a saved token, or click [**Add a GitLab token**](/docs/agents/skills/importing#private-repositories).
2. Choose the policy project. To change the branch, policy file, validations folder, or schedule, open **Advanced** first.
   - **New project:** pick a **Group**, or **Your namespace** for your own account, and enter a **Project name**. Click **Create project**. Setup creates a private project with your current policy.
   - **Existing project:** pick it and click **Connect project**.

If GitLab refuses the first commit to a protected branch, setup stops with an error. Use a token with the Maintainer role, or allow the first push to that branch.

## Repository Checks

Before you connect, the dialog checks what the repository holds:

- **OpenAPPA template**, **Empty repository**, or **Empty project:** setup copies your current policy into it.
- **Found appa.toml:** that file replaces your current policy.
- **No appa.toml:** pick another repository, or set the policy file under **Advanced**.
- **No access:** the App or token cannot read it. On GitHub, click **Change access** to fix it.

## Self-service MCP Guardrails

With self-service on, the people who [can edit an MCP server](/docs/admin/access-control#share-a-resource) change its Guardrails rules themselves, through a pull request, with no Guardrails permission. Each server's rules live in their own file, `mcp/<tool prefix>.toml` by default, which `appa.toml` includes with one line:

```toml
include = [
  "batteries/archestra/appa.toml",
  "mcp/*.toml",
]
```

Tick it when you set up Git sync, or click **Enable** on the Git sync card in **Settings → Guardrails** later; the dialog walks you through it. Then [share each server](/docs/admin/access-control#share-a-resource) with the team that owns it, with editing allowed, and share the **APPA Keeper** agent with those teams for use. **Edit** on the card changes or turns it off later. GitHub App sources only; [`ARCHESTRA_OPENAPPA_SELF_SERVICE`](/docs/admin/deployment/configuration#ARCHESTRA_OPENAPPA_SELF_SERVICE) sets it for the whole deployment instead.

### Edit a Server's Rules

1. Click **Edit Guardrails rules** for an owned server in the **MCP Registry**. The APPA Keeper opens on that server; a server without a file starts from one that names each tool with no rule.
2. Ask for the change, for example "refunds need a trusted session". The Keeper shows the diff.
3. Click **Approve**. The Keeper opens a pull request that changes only that file.
4. When the check passes, merge it. Git sync applies it at the next sync.

What to know:

- A rule in `appa.toml` wins over a server file's rule for the same tool.
- A server file holds rules for its own server's tools only; `<tool prefix>__*` covers every tool the file names no rule for. Git sync refuses a file that reaches further, whoever approved it.
- To merge, an editor needs write access to the repository, or someone who has it merges for them. Nobody needs to approve.

### The Check and the Ruleset

While self-service is on, Archestra keeps two things on the synced branch at each sync, and never merges anything itself:

- **The check**, `Check OpenAPPA Guardrails [<App name> App]`, posted within a minute on each pull request that changes a file Git sync reads, and skipped on any other. It fails when Git sync would refuse the result, and, for a pull request Archestra opened, when the person who asked may no longer edit the server or someone else pushed to its branch. [`ARCHESTRA_OPENAPPA_POLICY_CHECK_NAME`](/docs/admin/deployment/configuration#ARCHESTRA_OPENAPPA_POLICY_CHECK_NAME) renames it.
- **The ruleset**, named like the check, with one rule: that check must pass before a merge. Pull requests, reviews, pushes and history stay the repository's to rule, so it fits a folder in a repository that holds other work too. Rules an administrator adds stay; the check rule comes back at the next sync if removed.

## Validations in Git

With Git sync on, [validation files](/docs/agents/guardrails/policies#validating-the-policy) live in the repository's validations folder, and Archestra loads them from the same commit as the policy. Change the folder with **Edit** on **Settings → Guardrails**. An edit in Archestra stays a draft until you commit it to the repository.

What to know:

- Credentials never live in the repository. A policy with a `[credentials]` line fails to sync. Bind keys on the [**Batteries**](/docs/agents/guardrails/policies#batteries) tab instead.
- Validation failures do not block a merge on their own. Set up repository CI if they should.

Required permissions:

- [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update) to set up Git sync.
- [`credential:read`](/docs/reference/permissions#credential:read) to pick a saved GitHub App or GitLab token.
- [`credential:create`](/docs/reference/permissions#credential:create) to create a GitHub App or save a GitLab token.
- To change a server's rules: the server shared for editing and the APPA Keeper agent shared for use ([Granular Access Control](/docs/admin/access-control#granular-access-control)). No Guardrails permission.
