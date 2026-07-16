# Product spec: allow renaming MCP servers

Issue: [#4328 — Bug during renaming mcp server internal catalog item](https://github.com/archestra-ai/archestra/issues/4328)

## Problem

Renaming an internal-catalog MCP server orphans its Kubernetes deployment. The deployment name is derived from the mutable server name (`mcp-<rfc1123(mcp_server.name)>`, `platform/backend/src/k8s/mcp-server-runtime/k8s-deployment.ts:366-379`), so a rename + reinstall creates a second deployment while the old one keeps running. Pod lookup goes by the stable `mcp-server-id` label, which matches both pods first-match — so the UI streams the orphaned pod's logs and the new pod is effectively hidden.

The mutable name is also embedded as the `mcp-server-name` label inside `spec.selector.matchLabels` (`getSystemLabels`, `k8s-deployment.ts:1599-1605`, selector at `:1827-1829`). Kubernetes selectors are immutable, so even with a stable deployment name, no post-rename update of an existing deployment can ever be applied in place — the selector must stop carrying the name.

Renaming is currently disabled UI-only (PR #4329, a `nameDisabled` prop; the backend `PUT /api/internal_mcp_catalog/:id` still accepts name changes). PR #4334 proposed pure-id deployment names (`mcp-<id8>`) and was rejected for operator readability — a k8s admin can't tell which deployment maps to which server; only its orphan-cleanup half was merged separately (#4409, startup-only sweep).

## Goal

Users can rename an MCP server (its catalog entry) after registration:

- The rename never orphans, restarts, or re-identifies K8s deployments.
- Tools are renamed in place (`<newname>__<tool>`) with tool IDs, policies, and agent assignments preserved.
- The user is warned before renaming that connected MCP clients must reload their tool list, or their calls to the old tool names will error.
- Renaming to a name already used by another catalog in the organization is rejected (409). Tool names embed the catalog name (`<name>__<tool>`) and are unique only per catalog (`database/schemas/tool.ts:97-103`); tool-call routing resolves the incoming name string with `.limit(1)` (`ToolModel.findByNameForAgent`, `tool.ts:645-658`), so a collision silently routes calls to the wrong server — including calls from stale clients, which would otherwise get a clean `-32601` error (`routes/mcp-proxy.ts:124-137`).
- Deployment names stay human-readable for k8s operators.
- The upgrade itself recreates nothing: no fleet churn, no in-flight call failures.

## Non-goals

- Renaming `mcp_server` install rows directly — "rename a server" means renaming the `internal_mcp_catalog` entry; install names remain derived.
- Retroactively de-duplicating catalog names that already collide today — only *new* collisions via rename are blocked (see Goals); existing duplicates stay, and become harmless to K8s for new installs.
- Back-updating the denormalized `mcp_tool_calls.mcpServerName` on historical rows (audit data), and `a2a_task_approval_request.toolName` (request history).
- Converging legacy deployments onto the new naming scheme (they keep their frozen current names; mixed-scheme fleet is accepted).

## Decision

Deployment identity moves from the recomputed mutable name to a frozen, stored name:

- New column `deployment_name` (full name, not a slug) on `mcp_server`, and an analogous frozen name on `internal_mcp_catalog` for multitenant catalogs. Written once at install/creation time; the generic `update()` excludes it — renames cannot touch it.
- New installs: `mcp-<slug40>-<server.id[0:8]>`, where `slug40` is the sanitized name capped at 40 chars (`'server'` fallback for symbol-only names). Multitenant keeps the existing shape `mcp-mt-<catalogId[0:8]>-<slug>`. The id component guarantees uniqueness structurally for new rows (no collision handling), while the slug keeps `kubectl` output readable (addresses the #4334 review objection).
- Existing rows: backfilled at startup from **live K8s state** — a one-shot task lists deployments labeled `app=mcp-server`, maps each to its server via the `mcp-server-id` label, and freezes the deployment's *actual* name; only servers with no live deployment fall back to recomputing with `ensureStringIsRfc1123Compliant` (`platform/backend/src/k8s/shared.ts:210-219`). Recomputing for everyone is not safe: the rename disable is UI-only (the PUT API still accepts name changes), so a row renamed via API and never reinstalled already has a DB name that diverges from its live deployment — freezing a recomputed name there would mark the live deployment orphaned. Adopting the live name gives **zero churn** for all rows, including already-diverged ones (an improvement over today, where the #4409 sweep deletes their deployment on every restart). Legacy duplicate-name collisions remain possible but are no worse than today and age out as servers are reinstalled for other reasons.
- The deployment's `spec.selector.matchLabels` stops carrying `mcp-server-name`: the selector uses `getPodSelectorLabels()` (`app` + `mcp-server-id`, `k8s-deployment.ts:1616-1621`); `mcp-server-name` remains as a mutable deployment/pod-template metadata label only. New creates get the fixed selector; existing deployments converge on their next natural recreate (selectors are immutable, so no in-place fix is possible or attempted).

With deployment identity frozen and nothing in the pod depending on the display name, **a rename is a pure DB cascade — no reinstall, no pod restart, no user action**:

1. Reject with 409 if another root catalog in the org already has the target name (no such constraint exists today — only `(parentCatalogItemId, name)`, `database/schemas/internal-mcp-catalog.ts:221-224`).
2. Update the catalog name (after the new warning dialog).
3. Recompute and update every install's derived `mcp_server.name` (`constructServerName`).
4. Re-sync tool names in place via `syncToolsForCatalog`, which matches by raw tool name and UPDATEs rows, preserving tool IDs, policies, and agent assignments.
5. Update name-string-keyed rows in the same transaction: `limits.mcpServerName` / `limits.toolName` (`database/schemas/limit.ts:21-22`) and `app_pin.toolName` (`app-pin.ts:49`, part of its unique key). Without this, usage limits silently stop matching and app pins are orphaned after the rename. (`mcp_tool_calls.mcpServerName` and `a2a_task_approval_request.toolName` are audit/request history and stay untouched; agent export snapshots taken before a rename won't re-import by old tool names — accepted as a snapshot caveat.)

Multitenant catalogs go through the same cascade at catalog level (one shared deployment per catalog, not per-install): the frozen name lives on `internal_mcp_catalog`, and steps 3–5 apply identically. Today's shared deployment name also embeds the mutable catalog slug (`mcp-mt-<catalogId[0:8]>-<slug>`, `k8s-deployment.ts:370-375`), so multitenant is exactly as rename-fragile as single-tenant — the frozen column fixes both. Note the name check in `requiresNewUserInputForReinstall` (`mcp-reinstall.ts:33-42`) currently fires *before* the multitenant branch; it is removed together with the single-tenant gate.

The only exception: installs whose catalog `deploymentSpecYaml` references the `serverName` placeholder (the one place a display name can reach the pod spec) are flagged `reinstallRequired` as today.

## Why no reinstall is needed

Verified against the code:

- Pod env contains no display name — env is built purely from `localConfig.environment` + userConfig (`k8s-deployment.ts:2205-2260`).
- Secret names are id-keyed (`constructK8sSecretName`, `k8s-deployment.ts:388-397`). The "name change affects secret paths" comment in `requiresNewUserInputForReinstall` (`mcp-reinstall.ts:35-36`) is stale and is removed by this change.
- Tool prefixes come from `catalogItem.name` directly (`mcp-reinstall.ts:418`), and tool renaming is catalog-wide and pod-independent (`ToolModel.syncToolsForCatalog`, `tool.ts:2495`).
- "Reinstall" today is not a rolling restart anyway — it is delete → wait → recreate (`restartServer`, `manager.ts:1036-1043`), i.e. downtime per install. Routing renames through it bought only freshness of the cosmetic `mcp-server-name` label while leaving `mcp_server.name` and tool prefixes stale until each install owner acted.

## Mechanism

- Schema + migration: nullable `deployment_name` columns on `mcp_server` and `internal_mcp_catalog` (multitenant); no SQL backfill. Backfill is a one-shot startup task in application code that adopts each live deployment's actual name (list by `mcp-server-id` label; recompute-fallback only when no deployment exists) and **must complete before `cleanupOrphanedDeployments` runs** — the sweep is currently fired-and-forgotten from `initialize()` (`manager.ts:233-235`) and deletes any name-mismatched live deployment with no readiness check, so this ordering is load-bearing. Lazy backfill inside `constructDeploymentName` is ruled out: the sweep itself calls that function, so at sweep time the column would be NULL or freshly mis-frozen from a diverged DB name, and the sweep would delete a healthy running deployment.
- `McpServerModel.create` (`platform/backend/src/models/mcp-server.ts`) computes `deployment_name` at insert for new local servers using the new `mcp-<slug40>-<id8>` scheme; the generic `update()` excludes it.
- `K8sDeployment.constructDeploymentName` returns the stored name; `generateDeploymentSpec` switches `spec.selector.matchLabels` to `getPodSelectorLabels()`.
- Backend gate: the PUT handler gains the org-level name-conflict check (409) before any write; drop the name check from `requiresNewUserInputForReinstall` (`mcp-reinstall.ts:35-42`); `cascadeReinstallForCatalog` (`internal-mcp-catalog.ts:1868`) gains the DB-only rename branch (update install names + tool re-sync + `limits`/`app_pin` cascade), with the `deploymentSpecYaml`/`serverName`-placeholder exception flagging `reinstallRequired`.
- The existing startup sweep `cleanupOrphanedDeployments` (`platform/backend/src/k8s/mcp-server-runtime/manager.ts`, from #4409) stays as a safety net for pre-existing orphans; it must compare live deployments against the frozen stored name (not a recomputed one), skip servers whose `deployment_name` is still NULL, and be sequenced after the backfill task.
- Frontend: remove `nameDisabled` (reverts #4329) in `platform/frontend/src/app/mcp/registry/_parts/edit-catalog-dialog.tsx` / `mcp-catalog-form.tsx`; update the mirror gate in `cascade-decision.ts` (`:118`) so a pure name change routes to the new DB-only cascade rather than "manual"; when a submitted edit changes the name, the confirm dialog warns: all tools will be renamed and connected MCP clients must reload their tool list.

## Accepted costs

- The `mcp-server-name` k8s label and the frozen deployment name both drift from the display name after renames. Cosmetic: exact mapping always remains via the `mcp-server-id` label; the label converges on the next natural recreate, the deployment name never does (frozen by design — refreshing it would reintroduce the orphan problem).
- Fleet naming is mixed-scheme: legacy deployments keep their pre-suffix names indefinitely; only new installs carry the `<slug>-<id8>` suffix. Legacy duplicate-name collisions are not fixed retroactively.
- Readability of the slug is partly diluted for personal/team-scoped installs, whose derived names already embed owner/team ids (`constructServerName`, `models/mcp-server.ts:64-88`).

## Success criteria

- Rename of a standard catalog performs no k8s API interaction at all: `kubectl` shows the same untouched deployment and pod before and after; logs/status in the UI keep pointing at the live pod.
- Tool list shows `<newname>__<tool>` immediately after the rename — no reinstall — with unchanged tool IDs; agent assignments and policies intact.
- The rename confirmation dialog states the MCP-client reload requirement before the user commits.
- Upgrade recreates zero deployments at backend restart; a rename performed after the upgrade creates no second deployment (the orphan bug is gone).
- A catalog with `deploymentSpecYaml` using the `serverName` placeholder still flags its installs `reinstallRequired` on rename.
- Renaming to a name already used by another catalog in the org fails with a clear 409; no catalog, install, or tool rows are modified.
- A usage limit keyed to the old server/tool name still enforces after the rename (the `limits` cascade), and app pins survive.
- Backend restart with a row that was renamed via the API before the upgrade (DB name ≠ live deployment name) does not delete the live deployment; its frozen `deployment_name` equals the live one.

## Alternatives considered

| Option | Orphan-proof | Operator readability | Migration cost | Ongoing complexity |
|---|---|---|---|---|
| Keep name-derived names, fix the rename cascade | No (fragile ordering; restart on every rename) | Good | None | High |
| Pure id `mcp-<id8>` (PR #4334) | Yes | Poor (rejected in review) | One-time churn | Low |
| Frozen `mcp-<slug>-<id8>` for everyone, SQL backfill + universal recreate | Yes | Good | One-time recreate of every deployment (pod downtime, in-flight stdio failures, external references break once) | Low |
| **Frozen stored name; `<slug>-<id8>` for new installs only, byte-exact JS backfill (chosen)** | **Yes** | **Good** | **Zero** | **Low** |

Rename-flow alternative — keep the flag-`reinstallRequired` → manual-Reinstall path for name changes: rejected. Reinstall is delete+recreate (downtime) per install, requires action from every install owner, and leaves tool prefixes and `mcp_server.name` inconsistent until the first owner acts — all to refresh one cosmetic label. The DB-only cascade is immediate, consistent, and touches no pods.

Tool-prefix alternative — freeze the tool-name prefix at creation (same trick as `deployment_name`) and treat the catalog name as pure display metadata: rejected, but worth recording as the cheapest orphan-proof option. A rename would then break nothing at all — no client-reload warning, no tool re-sync, no cross-catalog collision risk, no name-keyed staleness; the implementation shrinks to a one-column update. Rejected because tool prefixes are LLM- and user-facing, and renames commonly exist precisely to fix them (typos, disambiguation) — a permanently frozen `gihtub__*` prefix is worse than a one-time client reload. A hybrid (display-only rename by default, opt-in "also rename tools") is a possible future refinement, out of scope here.

## Implementation notes (as shipped)

Corrections to statements above, discovered and settled during implementation:

- **"Rename disable is UI-only" was stale.** A model-level immutability guard (`models/internal-mcp-catalog.ts`, `update()`) also rejected API renames. The guard stays, reworded: it is now the invariant that renames flow exclusively through `InternalMcpCatalogModel.renameCascade` (which writes the name column directly inside its transaction).
- **No `app_pin` cascade (step 5 correction).** `app_pins.toolName` stores the *stripped* short tool name (`parseFullToolName(...).toolName`), which does not embed the catalog name — pins are rename-immune.
- **`limits` cascade is display-consistency, not live enforcement.** `checkLimitsBeforeRequest` is token_cost-only today and never matches `mcpServerName`/`toolName`; the cascade still swaps them so the rows don't silently go stale.
- **The 409 gate is app-level only.** Root catalog names have no DB uniqueness (`unique(parentCatalogItemId, name)` is NULLS-DISTINCT for roots) and legacy duplicates must keep working; the check-then-write race is accepted.
- **Backfill shape:** `adoptDeploymentNames` is a private manager method awaited inside `start()` right after `findAll()` — before any deploy and before the (unchanged, still fired-and-forgotten) orphan sweep. Adopt errors are fatal to `start()`. Duplicate live deployments per id tie-break to the legacy-recompute match, else the newest; losers are left for the sweep. The manager exposes `deploymentNamesAdopted`; the PUT rename branch awaits it whenever K8s is configured (even if the runtime errored), and the cascade's freeze-fallback (NULL rows frozen from the OLD name) only runs behind that gate.
- **Custom-YAML selector gap (addition to the selector switch).** `customYamlToDeployment` force-set `spec.selector.matchLabels` from the full 3-label system set — the "template selector is already id-only" observation covered only the template generator. The resolver now takes a separate id-only `selectorLabels`.
- **Per-install `deployment_name` is frozen for all local installs, including multitenant ones** (no catalog fetch in `McpServerModel.create`); for multitenant installs the column is simply never read — the catalog-level frozen name always wins.
- **Rename-only PUT fix:** the generic catalog `update()` now drops undefined-valued keys before building its set — a name-stripped rename-only body previously reached drizzle as an all-undefined update and threw "No values to set".
- **Frontend:** `computeCascadeOutcome` returns `{mode, renamed}` with a dedicated `rename` mode ("Save and rename"); a rename composed with a breaking change keeps the manual/auto mode and appends the client-reload warning. Catalog updates now also invalidate the `/tools` page query caches, which never refreshed on catalog edits before.
