---
name: archestra-upgrade-guide
description: Use when writing or updating an Archestra upgrade guide (docs/pages/admin/upgrade-vA-B-to-vX-Y.md) for a new stable line, when a change on main alters what operators must do on upgrade (add it to the draft guide), or when a release PR fails "Require an upgrade guide for a new stable line". Covers finding every operator-impacting change between two release lines, verifying it in code, and writing the page for the platform admin who runs the upgrade.
---

# Archestra Upgrade Guide

Every new stable line `X.Y` ships one page: `docs/pages/admin/upgrade-vA-B-to-vX-Y.md`, where `A.B` is the previous stable line. It must be on `release/X.Y` before `X.Y.0` publishes; the `Release Freeze Check` on the release PR fails without it. The v1.3 → v1.4 page (`docs/pages/admin/upgrade-v1-3-to-v1-4.md` on `release/1.4`) is the model.

Read `archestra-docs-writer` before writing. This skill adds what is specific to upgrade guides.

## The Draft on Main

While `X.Y` is in development on `main`, its guide lives there as a draft: `docs/pages/admin/upgrade-vA-B-to-vX-Y.md` with `draft: true` in its frontmatter, which keeps it off the docs site. Collect notes in it as changes land:

- A PR that changes what an operator must do on upgrade (a Helm default, a removed value, an env var, data a migration deletes) adds its item to the draft in the same PR. Create the draft if it does not exist yet.
- Put upgrade steps only here. Feature and deployment pages describe the current product, never "before you upgrade".
- A rough item under the right heading is fine. It is a draft: you refine it when you finish the page.

When you cut `release/X.Y`, finish the page from this skill and delete `draft: true`. The `Release Freeze Check` fails on a guide that is still a draft.

## The Reader

The reader is the platform admin who runs Archestra for their organization and is about to upgrade it. They will do exactly what the page says, in order, on a production deployment, once. Write for them:

- Say what changes **in their deployment**, what they will see, and what they must do. Never describe how Archestra implemented it.
- Every row and step needs an action. A change with nothing to do does not belong on the page.
- Give commands that run as written against a default install, with the defaults named. They will copy them.
- Say exactly what is deleted, and what is kept. "Cost limits are deleted" when only LLM Proxy limits are is a wrong page, not a short one.

## Find the Changes

Work read-only against refs. `A.B` is the previous line's last tag, `X.Y` is `origin/release/X.Y`.

```bash
OLD=platform-vA.B.N; NEW=origin/release/X.Y
BASE=$(git merge-base "$OLD" "$NEW")
git log --oneline "$BASE..$NEW" | grep -E '!:|BREAKING'
git diff "$OLD" "$NEW" -- platform/helm/archestra
git diff "$OLD" "$NEW" -- platform/backend/src/config.ts platform/.env.example
git diff --name-only "$OLD" "$NEW" -- platform/backend/src/database/migrations | grep '\.sql$'
git diff "$OLD" "$NEW" -- docs/openapi.json platform/shared/archestra-mcp-server.ts
```

Then look for what the commit log does not flag:

- **Data that migrations delete or rewrite.** Read the SQL of every `DELETE`, `DROP`, and permission rewrite. The `WHERE` clause is the scope; a commit title is not.
- **Custom roles.** Permission keys that a migration drops instead of converting.
- **Auth.** Requests or tokens that start failing: new required credentials, rate limits, retired token types.
- **Helm.** Removed or renamed values, values whose meaning changed, new render-time failures, RBAC rules for `rbac.create: false`, image registries and digest pinning. Render both charts with `helm template` and diff them. Render the old default `values.yaml` with the new chart: it pins the old `archestra.imageTag`.
- **Environment variables.** Removed, renamed, and changed defaults. A removed feature flag can turn a feature on that an admin had turned off.
- **APIs, MCP tools, and settings pages** that clients or people use.
- **Docker quickstart.** What the new container does on first start to existing volumes and the embedded cluster.
- **IaC.** The Terraform provider's minimum and maximum supported Archestra versions.

## Verify Before You Write

Every claim needs evidence: a file and line at a ref, or a commit. Then check the page from three angles, ideally with separate reviewers (subagents, and other models such as Codex or Gemini when available), each told to form its own opinion:

1. **Fact check:** every sentence, table row, link, anchor, and UI label against the code at `NEW`.
2. **Gap hunt:** changes an admin must act on that the page misses.
3. **Dry run:** walk the procedure literally against rendered manifests for a default Helm install and for the Docker quickstart. Check resource names, label selectors, hook order, timeouts, replica counts after a scale to zero (autoscaling and GitOps included), and the rollback order.

Settle disagreements in the code yourself. Reviewers are often confidently wrong.

## Page Shape

Keep these sections, in this order:

1. **Intro**, two or three sentences: the downtime, what is deleted for good, and that the backup is the only way back.
2. **What Changes for Your Deployment:** grouped lists under `###` headings: **Deleted in vX.Y** (record before, recreate after), **Clients That Stop Working**, and **Behavior Changes**. Each item opens with a short bold label, then the change and the action. Most damaging first.
3. **Before You Upgrade:** numbered steps while the old version still runs.
4. **Upgrade With Helm** and **Upgrade With Docker:** numbered, copyable commands, including the stop, the backup, the upgrade, the start, and how to tell it worked.
5. **After You Upgrade:** what to rebuild.
6. **Helm Values** and **Environment Variables:** lists of only the keys that need a change: `` `key`: what to do ``.
7. **Roll Back:** stop the new version first, restore the backup, then the old release.

Rules:

- Pin versions with `# x-release-please-version` on the line, and add the page to `extra-files` in `.github/release-please/release-please-config.json` on `release/X.Y`, so patches keep the version current.
- Link every environment variable, permission, API route, and MCP tool as `archestra-docs-writer` requires.
- Link from **Release Channels And Upgrades** in `docs/pages/admin/deployment.md`.
- No tables of prose. A two-column table with sentences in each cell renders as a cramped wall; use a list. Tables are only for short, same-shaped values.
- No history, no internals, no "we", no hedging, no praise.

## Finish

1. Delete `draft: true` from the frontmatter.
2. Run the docs checks from the repository root:

   ```bash
   for check in links env-var-links mcp-tool-links permission-links api-links navigation; do
     python3 .github/scripts/check-docs-$check.py
   done
   ```

3. View the page in the website's `vX.Y` docs (see the website repository's `app/docs/README.md` to preview an unmerged branch).
4. Merge it to `release/X.Y` through the queue. When a later `X.Y.Z` patch adds an admin action, update the page in the same backport.
