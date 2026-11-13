---
title: Git Sync
description: Keep the Guardrails policy in a GitHub or GitLab repository and review every change there
order: 2
beta: "Policy syntax and behavior may change as OpenAPPA evolves."
lastUpdated: 2026-11-14
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

With Git sync, every policy change goes through a pull request in your own GitHub or GitLab repository. Sync runs both ways: a change merged in the repository applies here, and a change made here opens a pull request (a merge request on GitLab) instead of saving.

## Set Up Git Sync

1. Go to **Settings → Guardrails** and click **Set up Git sync**. After the APPA Keeper saves a policy, the banner in chat links here too.
2. Pick **GitHub** or **GitLab**, then follow its steps below.

When setup is done, the card on **Settings → Guardrails** shows **Connected**. While something still waits, such as a GitHub App permission or a pull request to merge, the card shows a **Finish setup** notice. The Guardrails pages show the same notice.

**Finish setup** opens a wizard with one step for each item that waits. On its pull requests step, the wizard checks each pull request again when you return from GitHub. Once they all merge, the wizard goes to **Finish**. Like every Git sync wizard, it ends on the **Finish** step, which lists each part of the setup and what it still needs. While you edit Git sync, **Finish** opens from any step.

### GitHub

1. Enter the **GitHub URL**, either GitHub.com or your GitHub Enterprise Server address, and the **Organization**. Then choose one:
   - **Start fresh:** click **Create on GitHub** to create a private repository from the [OpenAPPA template](https://github.com/archestra-ai/openappa-config). On GitHub Enterprise Server, create an empty private repository instead, and setup adds the OpenAPPA files.
   - **Use an existing repository:** one that already holds an OpenAPPA policy. Setup proposes your current policy to it in a pull request.
2. Pick a GitHub App: **Use an App I already have**, or **Create a new GitHub App**, which creates one on GitHub with no keys to copy. Install it on the policy repository only.
3. **MCP Guardrails Self-Service:** tick it to let [MCP owners manage their servers' Guardrails](#mcp-guardrails-self-service), and pick the folder their policy files go to, `mcp` unless you change it. You can turn it on later too.
4. Choose the repository and the **Sync schedule**, then click **Connect repository**. To change the **Branch**, **Policy file** (`appa.toml`), or **Validations folder** (`traces`), open **Advanced** first.

The App needs **Read & write** on Contents, Pull requests, Checks, and Workflows. Archestra posts its policy check with Checks, and keeps the validation workflow current with Workflows (see [Repository Files](#repository-files)).

If repository rules block the first commit, setup opens a pull request instead. Your current policy stays active until that pull request merges, and the **Finish** step links it. With self-service on, the **Finish** step also offers the branch ruleset, because the ruleset names both the App and the repository.

### GitLab

Git sync works with gitlab.com and self-managed GitLab, through an access token with the `api` scope.

1. Pick a saved token, or click [**Add a GitLab token**](/docs/agents/skills/importing#private-repositories).
2. Choose the policy project and the **Sync schedule**. To change the branch, policy file, or validations folder, open **Advanced** first.
   - **New project:** pick a **Group**, or **Your namespace** for your own account, and enter a **Project name**. Click **Create project**. Setup creates a private project with your current policy.
   - **Existing project:** pick it and click **Connect project**. A project that already holds a policy gets your current policy as a merge request.

If GitLab refuses the first commit to a protected branch, setup stops with an error. Use a token with the Maintainer role, or allow the first push to that branch.

## When Merged Changes Apply

A pull request merged in the repository applies at the next scheduled sync: every 15 minutes, unless you pick every 5 minutes, every hour, or once a day. The Git sync card on **Settings → Guardrails** shows the schedule. Click **Sync now** to pull at once, or **Edit** to change the schedule.

Git sync also pulls at once, without waiting for the schedule, when:

- you save a Git sync or self-service setting;
- you open **Edit** or **Finish setup**, or close a Git sync wizard with **Done**;
- the APPA Keeper finds that a pull request it opened for a policy, validation, or MCP server rules change has merged;
- the GitHub App merges a self-service pull request (see [Auto-merge](#auto-merge));
- you turn Guardrails enforcement on again.

## Repository Checks

Before you connect, the dialog checks what the repository holds. Whatever it finds, setup carries your whole policy over: the policy file, every file it includes from its repository such as the MCP servers' files, and its validations. Nothing is lost when you move to another repository.

- **OpenAPPA template**, **Empty repository**, or **Empty project:** setup copies your current policy and the files it reads into it. A private repository that still holds the template's example `appa.toml` counts as a template copy, however it was created.
- **Found appa.toml:** setup opens a pull request, or a merge request on GitLab, that puts your current policy and the files it reads in place of that file. Merge it as it is, or combine the two policies on its branch first. Your current policy stays active until it merges.
- **No appa.toml:** pick another repository, or set the policy file under **Advanced**.
- **No access:** the App or token cannot read it. On GitHub, click **Change access** to fix it.

## Repository Files

Archestra keeps the files beside your policy current, so the repository's checks keep working after each Archestra upgrade. These files are the validation workflow, the Dependabot configuration, and the READMEs from the [OpenAPPA template](https://github.com/archestra-ai/openappa-config). The policy itself never changes this way.

- **Setup** writes the current files into a new repository. For an existing repository, the setup pull request adds or updates them.
- **Every sync** compares the files at the accepted commit with the ones this Archestra version ships. When a file differs, sync opens a pull request that updates the files, and **Finish setup** waits for its merge. A later version updates that pull request, or on GitLab replaces its merge request.
- **The Workflows permission** lets the GitHub App write the workflow file. Until you grant it, the pull request carries the other files, and the **Finish setup** wizard asks for the grant. The next sync then adds the workflow to the same pull request.
- **The Archestra check** runs on every pull request of a repository connected through a GitHub App, starting with the setup pull request. It fails when the pull request would merge a policy that is invalid for this deployment. Make it a required check, together with the repository's own `Validate policy` check.

What to know:

- The standalone `appa` in the workflow cannot replay a policy that Archestra composes with its batteries. For such a policy, the workflow skips the replay and says why, and the Archestra check validates the change.
- Archestra compares the files only when the policy is `appa.toml` at the repository root and its validations are in `traces/`.

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

Git sync proposes that include itself. When the policy file lacks it, the next sync opens a pull request that adds it. If the setup pull request has not merged yet, Git sync adds the include to that pull request instead. **Finish setup** lists the pull request with the others to merge.

MCP servers whose tools carry the same tool prefix share one rules file, because rules match tools by name. To change a shared file, you need edit access to each of these servers that is shared with a team or the organization. Members' personal copies of these servers follow the same file. When only personal copies carry the prefix, a change needs edit access to each copy.

Enable it in the Guardrails setting when setting up git sync or afterwards. Can also be controlled with the [`ARCHESTRA_OPENAPPA_SELF_SERVICE`](/docs/admin/deployment/configuration#ARCHESTRA_OPENAPPA_SELF_SERVICE) env var.

### The Check and the Ruleset

- **The check**, `Check OpenAPPA Guardrails`, is the check Archestra posts on every pull request (see [Repository Files](#repository-files)). With self-service, it also fails when the author of a policy change lacks the permission to make it. To give the check another name, set [`ARCHESTRA_OPENAPPA_POLICY_CHECK_NAME`](/docs/admin/deployment/configuration#ARCHESTRA_OPENAPPA_POLICY_CHECK_NAME).
- **The ruleset**, a branch ruleset that requires the check, so a pull request with policy updates merges only once the check passes. You import it yourself: click **Download ruleset** in the self-service setup, open the repository's **Settings → Rules → Rulesets** on GitHub, choose **New ruleset → Import a ruleset**, pick the file, and click **Create**. Archestra reads the branch's rules and shows whether the ruleset is missing, needs a change, or is in place. It writes no rules, so the App needs no Administration permission.

What to know:

- Turning self-service off leaves the ruleset in place. Archestra keeps posting the check, so pull requests still merge once it passes. The Git sync card names the rule.
- Moving Git sync to another repository or branch, or stopping it, is refused while the rule is still there. Remove the rule first.

### Auto-merge

MCP owners need no access to the policy repository: the GitHub App merges their pull requests itself. Turn on **Auto-merge pull requests** in the Self-service step of Git sync setup, or by editing the source later. The Git sync card then says that admitted self-service pull requests merge automatically.

- A pull request merges within about a minute once every check on it passes, and Git sync then applies it. The APPA Keeper opens it without asking you to approve it first. The Keeper then follows it in the chat and reports when the change applies, or what holds it.
- Only rules pull requests opened from Archestra for an MCP server merge this way. Pull requests people open on GitHub keep the repository's own review.
- A conflict or a draft holds the pull request until someone resolves it on GitHub. If GitHub refuses a merge for another reason, the App tries again a minute later, then every 15 minutes.
- If the branch ruleset takes the check from another GitHub App, **Finish setup** shows the fix. The App merges the pull request within a minute of that fix.

The [`ARCHESTRA_OPENAPPA_SELF_SERVICE_AUTO_MERGE`](/docs/admin/deployment/configuration#ARCHESTRA_OPENAPPA_SELF_SERVICE_AUTO_MERGE) env var sets it for the whole deployment.
