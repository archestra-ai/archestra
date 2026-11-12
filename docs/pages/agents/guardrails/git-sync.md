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
   - **Use an existing repository:** one that already holds an OpenAPPA policy. Setup proposes your current policy to it in a pull request.
2. **MCP Guardrails Self-Service:** tick it to let [MCP owners manage their servers' Guardrails](#mcp-guardrails-self-service), and pick the folder their policy files go to, `mcp` unless you change it. You can turn it on later too.
3. Pick a GitHub App: **Use an App I already have**, or **Create a new GitHub App**, which creates one on GitHub with no keys to copy. Install it on the policy repository only.
4. Choose the repository and click **Connect repository**. To change the **Branch**, **Policy file** (`appa.toml`), **Validations folder** (`traces`), or **Sync schedule**, open **Advanced** first.

The App needs **Read & write** on Contents and Pull requests, and on Workflows too on GitHub Enterprise Server. Self-service adds Checks and Administration. If repository rules block the first commit, setup opens a pull request instead, and your current policy stays active until it merges. Click **Review and merge**, and merge it once its checks pass.

### GitLab

Git sync works with gitlab.com and self-managed GitLab, through an access token with the `api` scope.

1. Pick a saved token, or click [**Add a GitLab token**](/docs/agents/skills/importing#private-repositories).
2. Choose the policy project. To change the branch, policy file, validations folder, or schedule, open **Advanced** first.
   - **New project:** pick a **Group**, or **Your namespace** for your own account, and enter a **Project name**. Click **Create project**. Setup creates a private project with your current policy.
   - **Existing project:** pick it and click **Connect project**. A project that already holds a policy gets your current policy as a merge request.

If GitLab refuses the first commit to a protected branch, setup stops with an error. Use a token with the Maintainer role, or allow the first push to that branch.

## Repository Checks

Before you connect, the dialog checks what the repository holds. Whatever it finds, setup carries your whole policy over: the policy file, every file it includes from its repository such as the MCP servers' files, and its validations. Nothing is lost when you move to another repository.

- **OpenAPPA template**, **Empty repository**, or **Empty project:** setup copies your current policy and the files it reads into it. A private repository that still holds the template's example `appa.toml` counts as a template copy, however it was created.
- **Found appa.toml:** setup opens a pull request, or a merge request on GitLab, that puts your current policy and the files it reads in place of that file. Merge it as it is, or combine the two policies on its branch first. Your current policy stays active until it merges.
- **No appa.toml:** pick another repository, or set the policy file under **Advanced**.
- **No access:** the App or token cannot read it. On GitHub, click **Change access** to fix it.

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

## MCP Guardrails Self-Service

Users who are permitted to edit an MCP server can also manage its Guardrails rules from the MCP Registry page. Each MCP gets its own policy file under the `mcp/` folder by default:

```toml
include = [
  "batteries/archestra/appa.toml",
  "mcp/*.toml",
]
```

Enable it in the Guardrails setting when setting up git sync or afterwards. Can also be controlled with the [`ARCHESTRA_OPENAPPA_SELF_SERVICE`](/docs/admin/deployment/configuration#ARCHESTRA_OPENAPPA_SELF_SERVICE) env var.

### The Check and the Ruleset

- **The check**, `Check OpenAPPA Guardrails` pull request check. It fails when the policy update author lacks required permissions or if the update would make the effective policy invalid. [`ARCHESTRA_OPENAPPA_POLICY_CHECK_NAME`](/docs/admin/deployment/configuration#ARCHESTRA_OPENAPPA_POLICY_CHECK_NAME) env var allows to set custom name for this check.
- **The ruleset**, the branch ruleset to keep the check required in order to merge a pull request introducing policy updates.

### Auto-merge

MCP owners need no access to the policy repository: the GitHub App merges their pull requests itself. Turn on **Auto-merge pull requests** under **MCP Guardrails Self-Service** in the Git sync card, or in the Self-service step of Git sync setup.

- The policy check is the only gate. A pull request merges within about a minute of its check passing, and Git sync then applies it.
- Only rules pull requests opened from Archestra for an MCP server merge this way. Pull requests people open on GitHub keep the repository's own review.
- If another branch rule blocks the merge, the pull request stays open for people to merge. The App tries again a minute later, then every 15 minutes.

The [`ARCHESTRA_OPENAPPA_SELF_SERVICE_AUTO_MERGE`](/docs/admin/deployment/configuration#ARCHESTRA_OPENAPPA_SELF_SERVICE_AUTO_MERGE) env var sets it for the whole deployment.
