---
title: Sharing Skills
category: Agents
order: 4
description: Share Archestra skills into Claude Code and Codex CLI through native plugin marketplaces
lastUpdated: 2026-05-27
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

Archestra skills can be installed into a teammate's local Claude Code or Codex CLI through each tool's native plugin marketplace. A signed share link points the client at an Archestra-hosted git repository that serves both marketplaces in parallel — Claude reads `.claude-plugin/marketplace.json`, Codex reads `.agents/plugins/marketplace.json`, and the underlying `SKILL.md` files are identical.

The marketplace lives at `/connection` alongside the MCP Gateway and LLM Proxy connection flows. Picking a client (or "Any client") expands a "Share skills as a marketplace" step that snapshots every current skill into one link.

## Who can share

Creating, refreshing, and revoking the marketplace link requires the `skill: admin` permission. Members can install a link that has been shared with them; they cannot create new links.

## Scope and authentication

The marketplace link is organization-private. There is no public listing — a link only resolves while its token is valid, and the token is bound to a single share-link row in the database. The clone URL embeds the token; anyone who holds the URL can clone the marketplace until you revoke it.

The same clone URL works for both Claude Code and Codex; only the install command differs:

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

The `/connection` step generates both snippets for the selected client and lets you copy them with one click.

## Snapshot semantics

The marketplace link is a **snapshot** of the org's skills at creation time. Adding, editing, or deleting skills afterwards does not update the materialized repo. The step shows a "covers N of M skills" indicator when the link has drifted from the current set; click **Refresh link** to issue a new token with the up-to-date skill list (the previous link is revoked at the same time).

For security, the clone URL is only returned at creation. After a page reload the URL is no longer visible — the admin must refresh the link to reveal a new URL.

## Updates and revocation

When a skill's content changes in Archestra the materialized repo is rewritten in place, so users who run `claude plugin marketplace update` (or the Codex equivalent) will see the new revision. New or deleted skills require a link refresh (snapshot).

Revoking a marketplace link deletes the underlying repository on disk and causes future clone or pull requests to return `404`. Existing local clones keep working until the user attempts a pull, at which point they need a fresh link. The token also persists in the user's local `git` config after `plugin marketplace add`; revoke the link when sharing ends, and prefer short TTLs (the step defaults to 30 days).

Every clone is audit-logged with the share-link ID and skill IDs — the raw token is never written to logs.

## Configuration

Deployment-side configuration lives in three environment variables documented in [platform-deployment](/docs/platform-deployment#environment-variables):

- `ARCHESTRA_SKILL_MARKETPLACE_CACHE_DIR` — directory used to materialize per-share-link git repos.
- `ARCHESTRA_GIT_BINARY_PATH` — path to the `git` binary; the public endpoint shells out to `git http-backend` (CGI).
- `ARCHESTRA_GIT_AUTHOR` — author/committer identity stamped on every materialized commit.
