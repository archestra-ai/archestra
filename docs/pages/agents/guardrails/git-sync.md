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
2. Pick a GitHub App: **Use an App I already have**, or **Create a new GitHub App**, which creates one on GitHub with the [permissions below](#github-app-permissions) and no keys to copy. Install it on the policy repository only: its tokens never reach past that repository, and so GitHub's own grant need not either.
3. Choose the repository and click **Connect repository**. To change the **Branch**, **Policy file** (`appa.toml`), **Validations folder** (`traces`), or **Sync schedule**, open **Advanced** first.

If repository rules block the first commit, setup opens a pull request instead, and your current policy stays active until it merges. Click **Review and merge**, and merge it once its checks pass.

### GitHub App Permissions

Each permission serves one part of Git sync, and a part whose permission is missing is reported on **Settings → Guardrails**, not failed. The App subscribes to no events: sync polls the repository on its schedule, so GitHub needs no route to Archestra.

| Permission | Access | What it does | Without it |
| --- | --- | --- | --- |
| Metadata | Read | Lists the repositories the installation covers, in setup. GitHub grants it to every App. | Nothing to choose. |
| Contents | Read and write | Reads `appa.toml`, the server files and the validations at each sync and for each pull request it checks. Writes the first policy into a new repository and the branch of each pull request Archestra opens. | Nothing syncs. |
| Pull requests | Read and write | Finds the open pull requests to check, with who opened them and what they change. Opens pull requests: a server's rules from the APPA Keeper, and the first policy when rules block a direct commit. | Sync reads, but proposes and checks nothing. |
| Checks | Read and write | Posts the **Guardrails Policy Admission** check on each pull request into the synced branch. | No check. The branch rules do without it until it is granted. |
| Administration | Read and write | Creates the **Guardrails Policy Admission** ruleset on the synced branch and restores its rules. | No branch rules. Settings shows them off. |
| Workflows | Read and write, GitHub Enterprise Server only | Lets setup commit the template's workflow files into an empty repository; GitHub refuses that commit otherwise. On GitHub.com the template repository brings them. | Setup on GitHub Enterprise Server fails on the workflow files. |

Each job mints its own token, good for the policy repository and under an hour, with that job's slice alone: reading the policy takes Contents read; checking pull requests takes Pull requests read and Checks write; opening a pull request takes Contents and Pull requests write; the branch rules take Administration write. An App created before a part existed lacks its permission: **Settings → Guardrails** lists what is missing under **Repository protection**, and **Update App permissions** opens the App's permissions page on GitHub. Grant them as read and write, accept the change on the installation, then click **Check again**.

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

The people who [can edit an MCP server](/docs/admin/access-control#share-a-resource) can change its Guardrails rules themselves, through a pull request, without a Guardrails permission. They do it in a chat with the **APPA Keeper** agent, which only administrators can use until you [share the agent](/docs/admin/access-control#share-a-resource) with their team. Each server's rules live in their own file in the policy repository, `mcp/<tool prefix>.toml`. One line in `appa.toml` includes every such file, so a server's first file needs no change to `appa.toml`:

```toml
include = [
  "batteries/archestra/appa.toml",
  "mcp/*.toml",
]
```

Any include entry may name every matching file in one folder this way, as OpenAPPA 0.41 and later read one: `teams/*.toml`, `policies/ops-*.toml`. Only the file name holds `*`, it ends in `.toml`, and the files load at the entry's position in name order, each once. Lay the repository out as you like and move files between folders freely; Git sync reads the files the commit holds. Only `mcp/<tool prefix>.toml` is a server's own file, held to that server's tools; a file anywhere else is organization policy, with no scope. Only Archestra reads the `<tool prefix>__*` rules below: a workflow that replays validations with `appa`, such as the template's **Validate OpenAPPA policy**, fails on a file that has one. The [policy check](#protect-each-servers-file) checks each pull request the way Git sync does, every included file folded in.

When two files write a rule for the same tool, the first one in the composed policy wins for a call, whole: the root's rules come first, then each included file's in `include` order, and a glob's files in name order. An exact tool name always beats `*`. So `appa.toml` overrides any included file, and an entry listed before `mcp/*.toml` overrides a server's file while one listed after it yields to it. Nothing merges and nothing warns: a shadowed rule is dead for that call. Two files cannot declare the same annotator.

### Before Editors Start

Three things put a server's rules in its editors' hands; each is in place once and holds for every server.

1. **Git sync on GitHub**, with an App that has [every permission above](#github-app-permissions). A GitLab project gets the pull requests and the policy check, but the check does not tell who asked there, and Archestra keeps no branch rules; protect its branch in GitLab.
2. **Editors on the server.** [Share the server](/docs/admin/access-control#share-a-resource) with the team that owns it, with editing allowed. Those people get **Edit Guardrails rules**, and the policy check passes their own changes.
3. **The APPA Keeper for those teams.** Only administrators can use the agent until you share it with the editors' teams for use.

To merge, an editor needs write access to the repository on GitHub, or someone who has it clicks **Merge** for them. Nobody needs to approve.

### Change a Server's Rules

1. In the **MCP Registry**, click **Edit Guardrails rules** in the server's row actions, or open the server's page, click **⋯**, then **Edit Guardrails rules**. The APPA Keeper chat opens on that server. An editor of the server without [`guardrailsPolicy:read`](/docs/reference/permissions#guardrailsPolicy:read) gets the same chat from **Configure Guardrails with agent**, on the last step of editing the server. A server with no file yet starts from a file that names each of its tools with no rule, so the first change decides about every tool on purpose; a tool left without a rule keeps the organization's defaults.
2. Ask for the change, for example "refunds need a trusted session". The Keeper writes the file and shows the diff.
3. Click **Approve**. The Keeper opens a pull request that changes only that file. If `appa.toml` does not include `mcp/*.toml` yet, the first pull request adds it.
4. When the **Guardrails Policy Admission** check passes, merge it. A server's only editor merges their own change; no one else's approval is needed. Git sync applies it at the next sync.

What to know:

- A rule in `appa.toml` wins over a server file's rule for the same tool, so the organization's own rules stay in force.
- A server file starts with `[policy]` and `version = 2`, like `appa.toml`, and holds only rules for that server's tools and annotators named `<tool prefix>.<name>`. `<tool prefix>__*`, such as `payments_api__*`, covers each of the server's tools the file has no rule for, including tools it gains later. Git sync refuses a commit whose server file reaches further, such as `*`, another server's tool, or an annotator name a battery uses, whoever approved it.
- A server file uses the organization's authorities and sanitizers but declares none of its own. To have a person approve a call, require an attention mark an authority permits, such as `requires = { attention = ["payments-refund"] }`. To clean a tool's result, give the tool a sanitizer's tag and list it under `[policy.deployment]` `confined_results`.

## Protect Each Server's File

A change from the APPA Keeper needs no one's approval: the policy check on its pull request confirms that the person who asked may edit that server, and the branch rules make the check the gate, so a server's only editor merges their own change. A pull request a person opens on GitHub is the repository's own business: who may open and merge one, and who reviews it, is set by GitHub's permissions, rulesets and any `CODEOWNERS` file you keep, none of which Archestra writes or reads. Archestra never merges anything itself. At each sync it keeps two things:

- **The policy check:** a pull request into the synced branch that changes a file Git sync reads gets the **Guardrails Policy Admission** check within a minute. It fails when Git sync would refuse the result, whoever opened it, and, for a pull request Archestra opened, when the person who asked may no longer edit the server or someone else pushed a commit onto its branch. A pull request that changes no such file gets the check as skipped at once, which passes, so a required check never holds it. The check's name, and the ruleset's, is [`ARCHESTRA_OPENAPPA_POLICY_CHECK_NAME`](/docs/admin/deployment/configuration#ARCHESTRA_OPENAPPA_POLICY_CHECK_NAME).
- **Branch rules,** when the policy file is at the repository's root: the **Guardrails Policy Admission** ruleset on the synced branch blocks force pushes and deletion. A merge needs a pull request that is up to date with the branch and the passing check, and no approval. To require a second pair of eyes as well, raise the approval count on the ruleset on GitHub: Archestra keeps it. The check is required only while the App may post it: without the Checks permission, the rules do without it until it is granted. Archestra adds no bypass; one an administrator adds on GitHub stays, and Settings shows it.

Who asked for a pull request Archestra opened is read from what GitHub vouches for: its commits are signed for the App, and their author is the person who asked. Git sync itself applies any valid commit that reaches the branch, whoever merged it, and refuses an invalid one, keeping the last accepted policy.

**Settings → Guardrails** shows the branch rules under **Repository protection**.

### Sync Into a Folder of an Existing Repository

The policy can live in a folder of a repository that holds other work, such as `guardrails/appa.toml` in a product repository. Set the **Policy file** under **Advanced** when you connect. Then Archestra adds no rules to that branch unasked, since they would reach the other work too. Every pull request still gets the **Guardrails Policy Admission** check, skipped at once when it changes nothing under that folder or in the validations folder, so requiring it holds nobody up. To have GitHub block a pull request that would break the policy, click **Require the Guardrails Policy Admission check** under **Repository protection**: Archestra adds a ruleset with that one rule, not strict, and keeps it; or require the check in a ruleset of your own. A required check also stops pushes straight to the branch, which no check runs for.

What to know:

- An App created before Archestra kept these lacks the Checks and Administration permissions; **Repository protection** lists them with **Update App permissions**. Until they are granted and accepted on the installation, the parts the App cannot do are reported as off. A ruleset that already requires the check while the App cannot post it holds every pull request; Settings says so until the permission is granted.
- To manage the branch yourself, turn the ruleset off on GitHub. Archestra leaves a disabled ruleset alone, and keeps any rule you make stricter.
- GitLab projects get the policy check as a commit status, for the policy alone: it does not tell who asked there. Protect the branch and its approvals in GitLab.

## Validations in Git

With Git sync on, [validation files](/docs/agents/guardrails/policies#validating-the-policy) live in the repository's validations folder, and Archestra loads them from the same commit as the policy. Change the folder with **Edit source** on **Settings → Guardrails**. An edit in Archestra stays a draft until you commit it to the repository.

What to know:

- Credentials never live in the repository. A policy with a `[credentials]` line fails to sync. Bind keys on the [**Batteries**](/docs/agents/guardrails/policies#batteries) tab instead.
- Validation failures do not block a merge on their own. Set up repository CI if they should.

Required permissions:

- [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update) to set up Git sync.
- [`credential:read`](/docs/reference/permissions#credential:read) to pick a saved GitHub App or GitLab token.
- [`credential:create`](/docs/reference/permissions#credential:create) to create a GitHub App or save a GitLab token.
- To change a server's rules: the server shared for editing and the APPA Keeper agent shared for use ([Granular Access Control](/docs/admin/access-control#granular-access-control)). No Guardrails permission.
