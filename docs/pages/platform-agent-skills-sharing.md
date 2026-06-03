---
title: Sharing Skills
category: Agents
order: 4
description: Share Archestra skills into Claude Code, Codex CLI, Copilot CLI, and Cursor through native plugin marketplaces
lastUpdated: 2026-05-27
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

Archestra skills can be installed into your local Claude Code, Codex CLI, Copilot CLI, or Cursor IDE through each tool's native plugin marketplace. A signed share link points the client at an Archestra-hosted git repository that serves the marketplaces in parallel — Claude reads `.claude-plugin/marketplace.json`, Codex and Copilot read `.agents/plugins/marketplace.json`, Cursor reads `.cursor-plugin/marketplace.json`, and the underlying `SKILL.md` files are identical.

Every shared skill is bundled into a single plugin so the user installs one thing instead of one-per-skill. The plugin name is the marketplace name (e.g. `archestra-acme-corp-skills`), and each skill lives under `skills/<slug>/` inside that plugin. Anthropic's official marketplaces follow the same one-plugin-per-toolkit convention.

The marketplace lives at `/connection` alongside the MCP Gateway and LLM Proxy connection flows. Picking a client (or "Any client") expands an "Install shared skills" step that snapshots every current skill into one link.

## Marketplace name

The marketplace name is generated at create time and frozen on the link, since clients register marketplaces by name in their local config — changing it later would silently break every installed marketplace.

Format: `<app-slug>-<org-slug>-skills` (e.g. `archestra-acme-corp-skills`). The app slug comes from the org's `appName` appearance setting and falls back to `archestra` when no white-label name is configured; the org slug comes from the better-auth organization row and falls back to a slugified org name, then a hex prefix of the org id.

## Who can share

Creating, refreshing, and revoking the marketplace link requires the `skill: admin` permission. Members can install a link that has been shared with them; they cannot create new links.

## Scope and authentication

The marketplace link is organization-private. There is no public listing — a link only resolves while its token is valid, and the token is bound to a single share-link row in the database. The clone URL embeds the token; anyone who holds the URL can clone the marketplace until you revoke it.

The same clone URL works for Claude Code, Codex, Copilot, and Cursor; only the install command differs:

**Claude Code**

```
claude plugin marketplace add <clone-url>
/plugin marketplace browse <marketplace-name>
```

**Codex**

```
codex plugin marketplace add <clone-url>
/plugins  # then select "Install Plugin"
```

**Copilot CLI**

```
copilot plugin marketplace add <clone-url>
copilot plugin marketplace browse <marketplace-name>
```

**Cursor**

```
/add-plugin <clone-url>
```

The `/connection` step generates the right snippet for the selected client and lets you copy it with one click. Picking "Any client" shows a generic clone-path guide.

## Snapshot semantics

The marketplace link is a **snapshot** of the org's skills at creation time. Adding, editing, or deleting skills afterwards does not update the materialized repo. The step shows a "covers N of M skills" indicator when the link has drifted from the current set; click **Refresh link** to issue a new token with the up-to-date skill list (the previous link is revoked at the same time).

For security, the clone URL is only returned at creation. After a page reload the URL is no longer visible — the admin must refresh the link to reveal a new URL.

## Updates and revocation

When a skill's content changes in Archestra a new commit is appended to the materialized repo's history with a deterministic SHA, so users who `git pull` (via `claude plugin marketplace update` or the Codex equivalent) fast-forward to the new revision instead of fetching unrelated histories. Adding or removing skills from a link's skill set still requires creating a new link (the link's snapshot is fixed at create time).

Revoking a marketplace link deletes the underlying repository on disk and causes future clone or pull requests to return `404`. Existing local clones keep working until the user attempts a pull, at which point they need a fresh link. The token also persists in the user's local `git` config after `plugin marketplace add`; revoke the link when sharing ends, and prefer short TTLs (the step defaults to 30 days).

Every clone is audit-logged with the share-link ID and skill IDs — the raw token is never written to logs.

## Configuration

Deployment-side configuration lives in two environment variables documented in [platform-deployment](/docs/platform-deployment#environment-variables):

- `ARCHESTRA_GIT_BINARY_PATH` — path to the `git` binary; the public endpoint shells out to `git http-backend` (CGI).
- `ARCHESTRA_SKILL_MARKETPLACE_CACHE_DIR` — directory holding materialized repos. Defaults to `~/.archestra/skill-marketplace-cache`. The authoritative history lives in `skill_share_link_revision`, so the cache is safe to wipe; in prod, mount a persistent volume here to skip rebuilds on container restart.

The git committer identity stamped on materialized commits is hardcoded (`Archestra Marketplace <marketplace@archestra.local>`) because the deterministic-replay contract folds it into every commit SHA; making it deployment-configurable would orphan stored revisions the moment a new value rolled out.
