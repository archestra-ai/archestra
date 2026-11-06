---
title: Git Sync
description: Keep the Guardrails policy in a GitHub or GitLab repository and review every change there
order: 2
beta: "Policy syntax and behavior may change as OpenAPPA evolves."
lastUpdated: 2026-11-06
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
2. Pick a GitHub App: **Use an App I already have**, or **Create a new GitHub App**, which creates one on GitHub with no keys to copy. Install it on the policy repository only.
3. Choose the repository and click **Connect repository**. To change the **Branch**, **Policy file** (`appa.toml`), **Validations folder** (`traces`), or **Sync schedule**, open **Advanced** first.

The App needs **Read & write** on Contents and Pull requests, and on Workflows too on GitHub Enterprise Server. If repository rules block the first commit, setup opens a pull request instead, and your current policy stays active until it merges. Click **Review and merge**, and merge it once its checks pass.

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

## Let Each Server's Team Own Its Rules

The people who can edit an MCP server can change its Guardrails rules themselves, through a pull request, without a Guardrails permission. Each server's rules live in their own file in the policy repository, `mcp/<tool prefix>.toml`. One line in `appa.toml` includes every such file, so a server's first file needs no change to `appa.toml`:

```toml
include = [
  "batteries/archestra/appa.toml",
  "mcp/*.toml",
]
```

1. Open the server in the **MCP Registry**, click the **⋯** menu, then **Edit Guardrails rules**. The APPA Keeper chat opens on that server. **Configure Guardrails with agent**, on the last step of editing the server, opens the same chat for anyone without a Guardrails permission.
2. Ask for the change, for example "refunds need a trusted session". The Keeper writes the file and shows the diff.
3. Click **Approve**. The Keeper opens a pull request that changes only that file. If `appa.toml` does not include `mcp/*.toml` yet, the first pull request adds it.
4. A reviewer merges it, and Git sync applies it at the next sync.

What to know:

- Your repository decides who reviews: give each file its owners in `CODEOWNERS`, such as `/mcp/payments_api.toml @example/payments`, and require code owner reviews on the branch.
- Archestra checks each open pull request into the synced branch every minute, the way Git sync checks a commit before applying it, and reports the result as the **Archestra Guardrails policy** check. Require that check in the branch's rules, so a change Git sync would refuse cannot merge. To post it, a GitHub App needs the **Checks** permission (Read and write). An App created before that permission was added needs it added in its settings on GitHub, and the change accepted on its installation. With a personal access token, or on GitLab, the result is posted as a commit status.
- A rule in `appa.toml` wins over a server file's rule for the same tool, so the organization's own rules stay in force.
- A server file starts with `[policy]` and `version = 2`, like `appa.toml`. It holds only rules for that server's tools and annotators named `<tool prefix>.<name>`. Git sync refuses a commit whose server file names another server's tool, `*`, or a tool without its server, whoever approved it, and the last accepted policy stays in force.
- For a rule that covers every tool of the server, name it `<tool prefix>__*`, such as `payments_api__*`. It applies to each of the server's tools that has no rule of its own in the file, including tools the server gains later.
- A server file uses the organization's authorities and sanitizers but does not declare its own. To have a person approve a call, require an attention mark that an authority permits, such as `requires = { attention = ["payments-refund"] }`. To clean a tool's result, give the tool a sanitizer's tag and list it under `[policy.deployment]` `confined_results`.

## Validations in Git

With Git sync on, [validation files](/docs/agents/guardrails/policies#validating-the-policy) live in the repository's validations folder, and Archestra loads them from the same commit as the policy. Change the folder with **Edit source** on **Settings → Guardrails**. An edit in Archestra stays a draft until you commit it to the repository.

What to know:

- Credentials never live in the repository. A policy with a `[credentials]` line fails to sync. Bind keys on the [**Batteries**](/docs/agents/guardrails/policies#batteries) tab instead.
- Validation failures do not block a merge on their own. Set up repository CI if they should.

Required permissions:

- [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update) to set up Git sync.
- [`credential:read`](/docs/reference/permissions#credential:read) to pick a saved GitHub App or GitLab token.
- [`credential:create`](/docs/reference/permissions#credential:create) to create a GitHub App or save a GitLab token.
