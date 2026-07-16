# Implement: allow renaming MCP servers (product-spec/rename-mcp-servers.md)

## Context

Renaming an internal-catalog MCP server today orphans its K8s deployment: the deployment name is derived from the mutable display name (`mcp-<slug(name)>`, multitenant `mcp-mt-<catalogId8>-<slug>`), so a rename + reinstall creates a second deployment while the old one keeps running; pod lookup by the `mcp-server-id` label then first-matches the orphan. Renaming is blocked twice today: UI-only `nameDisabled` (PR #4329) and a model-level immutability guard (models/internal-mcp-catalog.ts:473-492 — the spec predates this guard).

Fix per spec + user-chosen variant ("spec + safe merges"): freeze deployment identity into a stored `deployment_name` column written once at creation, adopt live deployment names at startup **inside** the orphan sweep path (one adopt-then-sweep pass instead of a separately-sequenced backfill task), and make a rename a pure DB cascade (catalog → install names → tool slugs → limits) with a 409 org-level name gate and a client-reload warning in the UI. Zero pod churn on upgrade and on rename.

Verified zero-churn preconditions (read directly, must be preserved):
- Deploy reconcile compares ONLY `spec.selector.matchLabels["mcp-server-id"]` (k8s-deployment.ts:2466-2469); existing running deployments are read and left untouched (:2488-2504); 409 create-conflict re-enters reconcile (:2610-2625).
- Nothing reads the `mcp-server-name` label value back anywhere; Service + NetworkPolicy names derive from `deploymentName` (frozen for free); secrets and Service selectors are already id-keyed; env never carries the display name; custom-YAML path forces `metadata.name = deploymentName` and its template selector is already id-only (k8s-yaml-generator.ts:162-167).

Spec corrections discovered (fold into the spec file in slice 6):
- Backend does NOT currently accept renames (model guard above) — "rename disable is UI-only" is stale.
- `app_pins.toolName` stores the **stripped** short tool name (models/mcp-server.ts:708-710; fed from `catalogApp.toolName`, routes/app/app.routes.ts:222,302) → rename-immune, **no app_pin cascade** (spec listed one).
- `limits.mcpServerName/toolName` have no enforcement matcher today (`checkLimitsBeforeRequest` is token_cost-only, models/limit.ts:753) — cascade kept per spec, but it's display-consistency, not live enforcement.
- No DB uniqueness exists for root catalog names (`unique(parentCatalogItemId, name)` is NULLS-DISTINCT for roots) and legacy duplicates must keep working → 409 is app-level only, check-then-write race accepted.

## Ordered implementation (reviewable slices)

### Slice 1 — Schema + types + migration (no behavior change)
1. `database/schemas/mcp-server.ts` + `database/schemas/internal-mcp-catalog.ts`: nullable `deploymentName: text("deployment_name")` (doc comment: frozen at creation, adopt pass backfills, renames never touch it).
2. Omit `deploymentName` from Insert/Update zod schemas: types/mcp-server.ts (:75-88, :90-97) and types/mcp-catalog.ts (:216-223, :250-262). Select schemas keep it (runtime consumes Select-derived types).
3. Generate migration (`pnpm db:generate`, `drizzle-kit check`; load `platform:archestra-dev-migrations`). No SQL backfill, no unique index.
4. `pnpm codegen:api-client` in platform/shared; commit generated client.

### Slice 2 — Freeze at creation, frozen reads, selector switch
5. `k8s/shared.ts`: `constructFrozenMcpDeploymentName(name, id)` → `mcp-<slug40>-<id[0:8]>`; slug40 = `ensureStringIsRfc1123Compliant(name).slice(0,40)` + trailing-trim, `"server"` fallback (53 chars max → `-service` suffix fits 63).
6. `McpServerModel.create` (models/mcp-server.ts:90-123): `const id = crypto.randomUUID()` (id column is `defaultRandom()`, so supplying it is safe; precedent models/account.ts:127); include `id` + (local only) `deploymentName` in the single insert.
7. `InternalMcpCatalogModel.create` (models/internal-mcp-catalog.ts:39-97): `id = catalogItem.id ?? crypto.randomUUID()`; when `multitenant`, freeze `mcp-mt-<id8>-<slug(name)>` **byte-identical to the legacy recompute** (k8s-deployment.ts:370-375) so existing-shape names never churn.
8. `constructDeploymentName` (k8s-deployment.ts:366-379): return stored `catalogItem.deploymentName` (mt) / `mcpServer.deploymentName` when set; legacy recompute stays as NULL fallback (transitional).
9. Selector switch (k8s-deployment.ts:1827-1829): `matchLabels: this.getPodSelectorLabels()`; metadata + pod-template labels keep the full 3-label set (selector-subset rule). Do NOT touch the reconcile comparison (:2466-2469).

### Slice 3 — Adopt pass + sweep
10. `manager.ts`: new private `adoptDeploymentNames(installedServers)`, **awaited in `start()` right after `findAll()` (:157), before the startServer loop (:183-190)** — ordering is load-bearing (start() redeploys everything; a diverged row would otherwise deploy under a fresh name pre-backfill). One `listNamespacedDeployment({labelSelector:"app=mcp-server"})`; group by `mcp-server-id` label (= server id single-tenant, **catalog id multitenant**, k8s-deployment.ts:1641-1646); skip already-frozen rows (idempotent); tie-break duplicate deployments per id: prefer name == legacy recompute, else newest `creationTimestamp` (losers left for the sweep); persist via new setters + mutate the in-memory rows (same array feeds startServer/egress/sweep); recompute-freeze fallback for rows with no live deployment. Errors propagate (fatal to start(); churn-prevention outranks runtime availability). Expose completion as a `deploymentNamesAdopted` promise on the manager (resolved after the adopt pass persists, rejected on failure) — the rename gate in item 20 awaits it.
11. New `McpServerModel.setDeploymentName(id, name, tx?)` and `InternalMcpCatalogModel.setDeploymentName(id, name, tx?)` (bypass the type-omit deliberately).
12. Sweep (manager.ts:1417-1498): belt-and-braces NULL-skip before the compare at :1459-1464; otherwise unchanged (picks up frozen names via step 8). Keep its existing silent skip of mt deployments (label=catalogId misses `serverById`); note in PR. Pre-existing gap, out of scope: orphaned `mcp-egress-*` policies are never GC'd.

### Slice 4 — Rename cascade + 409 (backend)
13. `platform/shared`: export `SERVER_NAME_PLACEHOLDER = "${archestra.server_name}"`; backend test pins it against the YAML generator (k8s-yaml-generator.ts:157,173).
14. `ToolModel.renameToolPrefixesForCatalog({catalogId, newName}, tx)`: select catalog tools (`agentId IS NULL`), per row `newSlug = slugifyName(newName, row.rawName ?? unslugifyName(row.name))`, UPDATE `name` in place (ids/policies/assignments untouched — same guarantee tool.test.ts:2419 pins), return `{oldName,newName}` pairs. Dedicated tx-aware method because `syncToolsForCatalog` is not tx-aware and fires side effects; **no pod needed** — all inputs live on stored rows.
15. `LimitModel.renameNameKeys({serverNamePairs, toolNamePairs}, tx)`: exact-string swaps on `limits.mcpServerName` / `limits.toolName`.
16. `McpServerModel.update`: accept optional `tx`.
17. `InternalMcpCatalogModel.renameCascade({id, newName, flagReinstallRequired})` — one `db.transaction` (models own transactions; helper `withDbTransaction` from `@/database`): (a) **rename-time freeze fallback**: if K8s runtime enabled and `deploymentName` still NULL on the catalog (mt) or any local install, freeze legacy recompute **from the old name** — safe only behind the adopt-pass gate in item 20: post-adopt, a still-NULL row provably has no live deployment. Without that gate, a pre-upgrade diverged row (DB name ≠ live deployment) renamed during the startup window would freeze the wrong name and hand its live deployment to the sweep — exactly the orphan the spec forbids (rename-mcp-servers.md:37); (b) update catalog `name`; (c) per install from `findByCatalogId` (full rows incl. scope/ownerId/teamId): `constructServerName(newName, …)` → update row (+ `reinstallRequired` when flagged); (d) tool prefix renames → pairs; (e) limits swap (catalog + install name pairs; tool pairs). Also add `findRootByNameInOrg(name, orgId)` — case-insensitive (`lower(name)`), `parentCatalogItemId IS NULL`, org-scoped (the real hazard is the lowercased tool-slug collision).
18. Keep the model guard (:473-492), reword comment: renames flow exclusively through `renameCascade` (guard = invariant, not obstacle).
19. `services/mcp-reinstall.ts`: delete the name check (:34-42) + stale "secret paths" comments (:12, :22-27). (`autoReinstallServer`'s name reconstruction :334-353 becomes a harmless no-op — row already renamed.)
20. PUT handler (routes/internal-mcp-catalog.ts:548): after the gate snapshot (:657-668), if `restBody.name` differs → 409 via `findRootByNameInOrg` excluding self (`ApiError(409, …, internal_code "catalog_name_conflict")`) → if K8s runtime enabled, `await manager.deploymentNamesAdopted` (a rename in the startup window blocks until live names are frozen; adopt failure fails the rename — churn-prevention outranks availability, matching item 10) → `renameCascade({flagReinstallRequired: local && deploymentSpecYaml?.includes(SERVER_NAME_PLACEHOLDER)})` → strip `name` from `restBody` + patch the gate snapshot's name. Downstream (:1061 update, :1138 `cascadeReinstallForCatalog`) then runs **unchanged** — pure rename shows no diff to the gates; rename+breaking-change composes naturally.

### Slice 5 — Frontend
21. Remove `nameDisabled` entirely: sole setter edit-catalog-dialog.tsx:183; prop + tooltip mcp-catalog-form.tsx:176,:198,:996-1015.
22. `cascade-decision.ts` (mirror contract with mcp-reinstall.ts, header :1-18): return `{mode: "skip"|"manual"|"auto"|"rename", renamed: boolean}`. Hoist the name check above the serverType branches (fixes the remote gap — remote tools re-slug too), delete the local name row (:117-118), evaluate the rest name-neutralized; `renamed && local && yaml.includes(SERVER_NAME_PLACEHOLDER)` (import from `@archestra/shared`) forces ≥ "manual"; pure rename → "rename". Update header decision tree.
23. `mcp-catalog-form.tsx` handleSubmit (:913-925) passes `{mode, renamed}`; `components/reinstall-confirm-bar.tsx` gains `mode: "rename"` (+`renamed?: boolean` to append the warning to manual/auto): body "Tools become `<newname>__…` immediately; no server restarts. Connected MCP clients must reload their tool list, or calls using the old tool names will fail." CTA "Save and rename".
24. 409 inline: `CATALOG_NAME_CONFLICT_CODE = "catalog_name_conflict"` in internal-mcp-catalog.query.ts (skip toast in onError :187-201), `form.setError("name", …)` in edit-catalog-dialog.tsx mirroring the serverUrl pattern (:125-136). Verify tools-list query invalidation on update success (tool names now change without reinstall).
25. Delete the dead byte-copy `_parts/reinstall-confirm-bar.tsx` (imported nowhere).

### Slice 6 — Tests, docs, spec
26. Backend tests (PGlite fixtures from `@/test`, no DB mocks):
    - k8s-deployment.test.ts — selector pin :514-526 → 2-label; name-construction block :291-458 + frozen-first cases (frozen wins, NULL falls back, mt reads catalog column).
    - manager.test.ts — mock stub :156-158 → frozen-first; sweep describe :2012-2122 fixtures carry `deploymentName`, add "frozen==live but ≠ recompute → NOT deleted" and "tie-break loser → deleted"; new adopt describe: freeze-live, diverged row adopts live name, both tie-break arms, recompute fallback, mt→catalog row, idempotent skip. `test/fixtures.ts` `makeMcpServer` gains `deploymentName` override.
    - mcp-reinstall.test.ts — invert/remove the "NAME changes ⇒ manual" pins (:335, :350).
    - New `routes/internal-mcp-catalog.rename.test.ts` (shape of the metadata-only-edit test): 409 (incl. case-insensitive, self-rename allowed, zero rows modified on 409); pure rename → catalog/installs/tools renamed atomically, tool ids + policies + agent assignments stable, no k8s interaction, `reinstallRequired` untouched; placeholder-YAML → flagged; rename+breaking-change → renamed AND flagged/auto; limits swapped; adopt gate (mocked `deploymentNamesAdopted`: pending → rename waits, rejected → error with zero rows modified).
27. Frontend tests: cascade-decision.test.ts matrix (remote rename no longer "skip", pure rename → "rename", placeholder → manual, combined+renamed); e2e mcp-install.spec.ts:332-334 stale regex → match current bar copy (silently no-ops today).
28. Docs audit (CLAUDE.md rule 4, `archestra-docs-writer`): registry page — renaming + client-reload caveat.
29. Update product-spec/rename-mcp-servers.md with the corrections listed in Context (guard exists; app_pins no-op; merged adopt-into-sweep; tie-break).
30. `cd backend && pnpm knip` (new exports used only by tests need `/** @public */` or real consumers); `pnpm lint`, `pnpm type-check`, `pnpm test`.

## Critical files
- platform/backend/src/routes/internal-mcp-catalog.ts (409 + rename branch)
- platform/backend/src/models/internal-mcp-catalog.ts (renameCascade, create-freeze, setter)
- platform/backend/src/models/mcp-server.ts (create-freeze, setter, tx)
- platform/backend/src/models/tool.ts (renameToolPrefixesForCatalog)
- platform/backend/src/k8s/mcp-server-runtime/k8s-deployment.ts (frozen reads, selector)
- platform/backend/src/k8s/mcp-server-runtime/manager.ts (adopt pass, sweep)
- platform/backend/src/services/mcp-reinstall.ts (drop name gate)
- platform/frontend/src/app/mcp/registry/_parts/cascade-decision.ts + mcp-catalog-form.tsx + edit-catalog-dialog.tsx, platform/frontend/src/components/reinstall-confirm-bar.tsx

## Verification (end-to-end, tilt)
1. `tilt up`; install a local MCP server; note `kubectl -n archestra-dev get deploy` name + pod age.
2. Rename the catalog entry via UI → confirm bar shows rename warning → save: same deployment/pod (age unchanged, zero k8s API writes), tool list shows `<newname>__*` immediately with unchanged tool ids; policies/agent assignments intact; logs page still streams.
3. Rename to another catalog's name → 409 inline on the name field; DB rows unchanged.
4. Catalog with `${archestra.server_name}` in deploymentSpecYaml → rename flags installs `reinstallRequired`.
5. Restart backend (tilt trigger pnpm-dev-backend): zero deployments recreated (adopt pass idempotent); simulate a pre-upgrade diverged row (SQL: set mcp_server.name ≠ live deployment — with user approval) → restart adopts the live name, deployment survives.
6. Backend unit + frontend unit + affected e2e green.
