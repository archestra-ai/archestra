---
title: Sharing Skills
category: Agents
order: 4
description: Share Archestra skills into Claude Code and Codex CLI through native plugin marketplaces
lastUpdated: 2026-05-26
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

Archestra skills can be installed into a teammate's local Claude Code or Codex CLI through each tool's native plugin marketplace. A signed share link points the client at an Archestra-hosted git repository that serves both marketplaces in parallel — Claude reads `.claude-plugin/marketplace.json`, Codex reads `.agents/plugins/marketplace.json`, and the underlying `SKILL.md` files are identical.

## Who can share

Creating, listing, and revoking share links requires the `skill: admin` permission on every skill referenced by the link. Members can install a link that has been shared with them; they cannot create new links.

## Scope and authentication

Share links are organization-private. There is no public marketplace listing — a link only resolves while its token is valid, and the token is bound to a single share-link row in the database. The clone URL embeds the token; anyone who holds the URL can clone the marketplace until you revoke it.

The same clone URL works for both Claude Code and Codex; only the install command differs:

**Claude Code**

```
claude plugin marketplace add <clone-url>
/plugin install <skill-slug>@<marketplace-name>
```

**Codex**

```
codex plugin marketplace add <clone-url>
/plugins  # then select "Install Plugin"
```

The Share dialog generates both snippets for you and lets you copy them with one click.

## Updates and revocation

Auto-update is out of scope for v1. When a skill changes in Archestra the marketplace repo is rewritten in place, so users who run `claude plugin marketplace update` (or the Codex equivalent) will see the new revision; running the install command again is the cleanest way to refresh. The previous git commit history is preserved so existing clones fast-forward without "unrelated histories" errors.

Revoking a share link deletes the underlying marketplace repository on disk and causes future clone or pull requests to return `404`. Existing local clones keep working until the user attempts a pull, at which point they need a fresh link. The token also persists in the user's local `git` config after `plugin marketplace add`; revoke the link when sharing ends, and prefer short TTLs (the dialog defaults to 30 days).

Every clone is audit-logged with the share-link ID and skill IDs — the raw token is never written to logs.

## Configuration

Deployment-side configuration lives in three environment variables documented in [platform-deployment](/docs/platform-deployment#environment-variables):

- `ARCHESTRA_SKILL_MARKETPLACE_CACHE_DIR` — directory used to materialize per-share-link git repos.
- `ARCHESTRA_GIT_BINARY_PATH` — path to the `git` binary; the public endpoint shells out to `git http-backend` (CGI).
- `ARCHESTRA_GIT_AUTHOR` — author/committer identity stamped on every materialized commit.
