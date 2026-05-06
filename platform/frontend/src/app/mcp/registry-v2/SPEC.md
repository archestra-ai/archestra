# Catalog Presets — Backend Implementation Spec

Status: draft, paired with the frontend spike at `platform/frontend/src/app/mcp/registry-v2/`.

## Problem

Today the install model collapses two distinct axes onto one row in `mcp_server`:

- **Configuration** — host, port, database name (what the server connects to)
- **Credentials** — username, password, API key (who is calling)

This makes "Datavase for Studio 1" and "Datababe for Studio 2" impossible to coexist in one catalog item, because the duplicate-install rule keys on `(catalogId, scope-target)` and rejects the second install. The current workaround is to clone the catalog item, which is a toil work, requires separate maintinaing of the catalog items.

## Concept

Insert a **preset** layer between catalog item and install:

```
catalog_item  →  preset (named param set)  →  install (scope + credentials)
```

- **Catalog item** — what the server is. Image, command, field schema, transport, mappings, common fields values between presets (e.g. `db_driver=psycopg`) One per integration kind.
- **Preset** — a named configuration of the catalog item. Holds values for fields that vary across deployments of the same catalog (e.g. `db_name=studio1`).  Values can be plain config or secrets. Multiple presets per catalog.
- **Install** — who can use which preset, with what credentials. The existing `mcp_server` row, now keyed on `(catalogId, presetId, scope-target)`.

Field schema splits into three scopes, encoded by two mutually-exclusive boolean flags. Each flag is a single positive declaration ("prompt at install" / "prompt at preset"); no overloading.

- **Static field** — both flags false/absent. Catalog-wide constant; same value for every preset. Value lives in the existing `UserConfigField.default` (userConfig) or `EnvironmentVariable.value` (env-var). UI shows this as the "Static value" checkbox in the env-field editor.
- **Preset field** — `promptOnPreset: true`. Admin sets a value per preset; values live in `catalog_preset.fieldValues`. Identifies *what* the server connects to (e.g. `database`, `host`).
- **User field** — `promptOnInstallation: true`. Caller-supplied at install or per call. Identifies *who* is calling (e.g. `username`, `password`). Existing behavior; presets don't touch this.

The two flags are mutually exclusive — having both true is rejected at catalog save. Neither flag set means the field is static.

How resolved values reach the running MCP server — header vs env-var vs secret-file, baked into the pod at install time vs injected per call, one-pod-per-install vs one-pod-per-preset — depends on the field's mapping target and the catalog's server type. See §Runtime.

## Glossary


| Term           | Meaning                                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog item   | Existing `internal_mcp_catalog` row. Template for an MCP server.                                                                                |
| Preset         | New `catalog_preset` row. Named parameter set bound to a catalog item.                                                                          |
| Install        | Existing `mcp_server` row. Who can use a preset, with what credentials.                                                                         |
| Static field   | Field with both `promptOnInstallation: false/absent` and `promptOnPreset: false/absent`. Catalog-wide constant — value lives in `UserConfigField.default` (userConfig) or `EnvironmentVariable.value` (env-var); presets cannot override it. Equivalent to today's "non-prompted catalog field" semantics. |
| Preset field   | Field with `promptOnPreset: true`. Admin sets a value per preset; values live in `catalog_preset.fieldValues`. UI: shown in the per-preset editor (the "Static value" checkbox is unchecked). |
| User field     | Field with `promptOnInstallation: true`. Caller supplies at install or per call. Existing semantics — no change. |
| Default preset | Per catalog item, *at most* one preset with `isDefault=true`. The flag is **system-managed** (set at auto-creation, never modified, never exposed to admins). Auto-created when there's nothing per-preset for an admin to configure: catalogs with no `promptOnPreset: true` fields get one on creation, and existing (pre-spec) catalogs get one via migration. Catalogs that *do* have `promptOnPreset` fields never get a default preset — admin creates presets explicitly, all non-default; installs must supply `presetId`. |
| Single-tenant catalog | Self-hosted catalog where each install gets its own pod (per `(preset, scope-target)`). Existing concept — pre-dates this spec. |
| Multitenant catalog   | Self-hosted catalog where one pod serves all installs of a preset (under this spec, one pod per preset). Existing concept — pre-dates this spec. |
| Remote catalog        | Catalog whose MCP server runs outside the platform. No pod; gateway forwards requests over HTTP. Existing concept — pre-dates this spec. |


## Data model

### New table: `catalog_preset`

```
id              uuid pk
catalogId       uuid fk → internal_mcp_catalog (on delete cascade)
name            text            -- DNS-1123 label compatible: ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$, max 63 chars. Validated at creation time. Immutable after creation — admins must delete and recreate to change the name.
fieldValues     jsonb           -- Record<fieldKey, value> for preset-scoped fields. Value type matches UserConfigFieldDefaultSchema (string | number | boolean | string[]) — same union the field-level `default` already uses.
isDefault       boolean
createdBy       uuid fk → users (on delete set null)  -- audit; nullable for migration-created defaults.
createdAt       timestamp
updatedAt       timestamp

unique(catalogId, name)
-- Partial unique index enforces "exactly one default per catalog" at the DB level:
unique index catalog_preset_one_default on catalog_preset(catalogId) where isDefault = true
```


### Modified: `mcp_server`

Add column:

```
presetId        uuid fk → catalog_preset (nullable during migration window, then NOT NULL)
```

### Modified: `internal_mcp_catalog.userConfig` and `localConfig.environment`

These are the only two places in the catalog schema with **per-field declarations**. Every entry there has `promptOnInstallation` and a `default` (and, for env-vars, a `value`) — i.e. somewhere a field could *otherwise* be preset-overridable. The other parts of `localConfig` (`command`, `arguments`, `dockerImage`, `serviceAccount`, `transportType`, `httpPort`, `httpPath`, `nodePort`, `envFrom`, `imagePullSecrets`) are **scalar catalog-wide settings**, not per-field schemas — there's no per-field shape to attach `promptOnPreset` to, and varying them per preset would mean preset-overriding the runtime image / command / transport, which is out of scope for v1 (see "Why these fields only" below).

One new optional flag is added: `promptOnPreset`. It is the positive declaration of "this field is prompted per preset by the admin." Together with the existing `promptOnInstallation` it encodes the three scopes (see §Concept and §Glossary).

```typescript
// userConfig field — add `promptOnPreset`
UserConfigField = {
  // ...existing fields (type, title, description, required, default, sensitive,
  // multiple, min, max, headerName, valuePrefix)
  promptOnInstallation?: boolean;
  promptOnPreset?: boolean;          // NEW — when true, value is set per preset (catalog_preset.fieldValues)
}

// localConfig.environment entry — add `promptOnPreset`
EnvironmentVariable = {
  // ...existing fields (key, type, value, required, description, default, mounted)
  promptOnInstallation: boolean;
  promptOnPreset?: boolean;          // NEW — when true, value is set per preset
}
```

**Validation at catalog save**:
- `promptOnInstallation` and `promptOnPreset` are mutually exclusive. Both `true` is rejected (a field can't be both caller-prompted and admin-prompted-per-preset). Neither set is the static case (catalog-wide constant, the existing default).

**Convention** for the resolution pseudocode below:
- `field.value ?? field.default` denotes the existing *catalog-level* fallback for a field. Concretely, this resolves to `EnvironmentVariable.value ?? EnvironmentVariable.default` for env-var entries and to `UserConfigField.default` for userConfig fields (which have no `value` property — `value` is treated as `undefined` and the chain skips it). This asymmetry is preserved as-is from today; presets don't change either shape.
- `userConfigValues[key]` denotes the resolved per-install value for a user-prompted field — i.e. what the caller submitted in the install request body's `userConfigValues` map, after the platform resolved it through the install's `secret` row (or Vault, depending on storage type). It is *not* a column on `mcp_server`; it's the logical lookup the runtime performs against the install's stored secret material.

**Runtime resolution** (per field):
```
if promptOnInstallation:                                          // user field
    value = userConfigValues[key] ?? field.default
elif promptOnPreset:                                              // preset field
    value = preset.fieldValues[key] ?? field.value ?? field.default
else:                                                             // static field
    value = field.value ?? field.default
```

Preset and static branches share the same catalog-level fallback (`field.value ?? field.default`). The behavioral difference is *whether* presets can supply an override — preset fields can, static fields cannot — not in what happens when no override is set. This means an admin can flip a static field to `promptOnPreset: true` without losing the existing baked-in value: presets that don't override the key still resolve to `field.value`.

The save-time guard at preset save (see §Routes) ensures `preset.fieldValues[key]` is never populated for static or user fields. Existing catalogs keep working unchanged after migration: existing fields have no `promptOnPreset` flag set, so they remain static and continue to read from `field.value` / `field.default` exactly as today. Admins enable per-preset variation explicitly by editing the catalog and setting `promptOnPreset: true` (this corresponds to leaving the "Static value" checkbox unchecked in the field-editor UI — which is the default for new env-fields).

Mapping target stays where it is today — `userConfig[key].headerName` for header destinations, `localConfig.environment[i].key` for env-var destinations, `mounted: true` for secret-file mounts. Nothing about mappings changes.

**Why these fields only**: the primary preset use case (one catalog → many `database` / `host` / `service-account-key` values) varies *field values*, not the *runtime image or command*. Bringing scalar `localConfig` fields like `dockerImage`, `command`, `arguments`, `transportType`, etc. under per-preset override would mean preset A could pin image tag `v2.1` while preset B pins `v3.0-beta`. That's a real but separable feature: it complicates the K8s naming / pod-rebuild story (every image change rebuilds every preset's pods), overlaps with image-tag management primitives that live elsewhere, and isn't required by the use cases driving this spec. If a future need arises, the cleanest expansion is an additive `catalog_preset.localConfigOverrides` jsonb that holds a partial `LocalConfig` and gets shallow-merged at install/pod-creation time. Out of scope for v1; revisit if a real catalog needs it.

### New: `internal_mcp_catalog.mappingTemplates`

Multi-field templated mappings (composing a DSN from `host`, `port`, `database`, `username`, `password` into one header) are part of v1. Today every field maps 1-to-1; templates are the additive new mechanism.

```
mappingTemplates  jsonb default '[]'   -- MappingTemplate[]
```

**Shape**:
```typescript
type MappingTemplate = {
  template: string;               // e.g. "postgresql+{dialect}://{username}:{password}@{host}:{port}/{database}"
  target:
    | { kind: 'header'; name: string; valuePrefix?: string }
    | { kind: 'env-var'; name: string }
    | { kind: 'secret-file'; path: string };
};
```

`{key}` placeholders reference field keys from `userConfig` or `localConfig.environment`. v1 uses simple string substitution — no Handlebars, no conditionals, no expressions.

**Validation at catalog save**:
- Every `{key}` placeholder must reference an existing field in `userConfig` or `localConfig.environment`.
- No two mappings may share a target. Across single-field mappings *and* `mappingTemplates` entries, each header name / env-var key / secret-file path may appear at most once. Single-field↔template, single-field↔single-field, and template↔template collisions are all rejected.

**Runtime resolution**:
1. For each `{key}` placeholder, resolve the field's value via the same chain as single-field mappings (user fields from caller; preset fields from `preset.fieldValues` with `field.value` / `field.default` as fallback).
2. Substitute into the template string.
3. Project the rendered string onto the target (header / env-var / secret-file), exactly like a single-field mapping.

**Example**:
```jsonc
mappingTemplates: [
  {
    template: "postgresql+{dialect}://{username}:{password}@{host}:{port}/{database}",
    target: { kind: "header", name: "x-db-url" }
  }
]
```
With `dialect`, `host`, `port`, `database` resolving from preset values and `username`, `password` from caller values, the gateway injects a single composed `x-db-url` header per call.

### Modified: `tools`

Add column and extend the existing 4-column unique constraint (`tool.ts:65-70`):

```
presetId        uuid fk → catalog_preset (on delete cascade)  -- nullable; null for proxy-sniffed and delegation tools, set for catalog-derived MCP tools

unique(catalogId, presetId, name, agentId, delegateToAgentId)  -- was unique(catalogId, name, agentId, delegateToAgentId)
```

Why a column instead of relying on the prefixed name: ownership queries ("tools belonging to preset X" — needed for auto-assign on install and per-preset delete) and rename safety (tool identity stops depending on the preset name appearing in the tool name). The prefix in the *name* is a separate concern — see §Agent-tool wiring — and exists only so that the LLM-facing tool roster distinguishes two presets' identically-named tools.

Cascade flows naturally: deleting a preset deletes its tools, which cascades through the existing `agent_tools.toolId` constraint to drop agent bindings. No change required to `agent_tools.mcpServerId` cascade behavior.

### Unchanged: `agent_tools`

The existing `unique(agentId, toolId)` constraint already permits binding to multiple presets' tools simultaneously, because each preset's tools are distinct rows in `tools` (distinct `presetId`, distinct `toolId`). No schema change needed.

## Migration

```sql
-- 1. Add mappingTemplates column (starts empty)
ALTER TABLE internal_mcp_catalog
  ADD COLUMN mapping_templates jsonb NOT NULL DEFAULT '[]';

-- 2. Create catalog_preset table

-- 3. Auto-create default preset per existing catalog item
INSERT INTO catalog_preset (id, catalog_id, name, field_values, is_default)
SELECT gen_random_uuid(), id, 'default', '{}'::jsonb, true
FROM internal_mcp_catalog;

-- 4. Add nullable mcp_server.preset_id

-- 5. Backfill mcp_server.preset_id to point at each catalog's default
UPDATE mcp_server m
SET preset_id = (SELECT id FROM catalog_preset p
                 WHERE p.catalog_id = m.catalog_id AND p.is_default = true);

-- 6. Make mcp_server.preset_id NOT NULL

-- 7. Add nullable tools.preset_id (fk → catalog_preset, on delete cascade)

-- 8. Backfill tools.preset_id to each catalog's default for catalog-bound tools
UPDATE tools t
SET preset_id = (SELECT id FROM catalog_preset p
                 WHERE p.catalog_id = t.catalog_id AND p.is_default = true)
WHERE t.catalog_id IS NOT NULL;

-- 9. Replace the existing unique(catalog_id, name, agent_id, delegate_to_agent_id)
--    with unique(catalog_id, preset_id, name, agent_id, delegate_to_agent_id)
```

No schema or data migration on `userConfig` or `localConfig.environment`. Field shapes don't change. Existing catalogs get one default preset with empty `fieldValues`; runtime resolution falls through to `field.value` / `field.default`, so behavior is identical to today. Existing installs work unchanged.

**Risks**:
- Backfilling thousands of `mcp_server.preset_id` rows. Dry-run on a copy of prod data; batch if needed.

**OAuth caveat**: `oauthConfig` and `enterpriseManagedConfig` on `internal_mcp_catalog` stay catalog-level in v1. If a real catalog needs different OAuth apps per preset, this becomes a per-preset jsonb. Document the limitation and revisit.

## Routes

### Install route — `routes/mcp-server.ts:212-259`

Extend duplicate-install check:

- From `(catalogId, ownerId)` / `(catalogId, teamId)`
- To `(catalogId, presetId, ownerId)` / `(catalogId, presetId, teamId)`

Accept optional `presetId` in install body. Resolution:

- If `presetId` is supplied → use it.
- If `presetId` is omitted and the catalog has a default preset (`isDefault=true`) → use the default. Back-compat for catalogs without `promptOnPreset` fields and for migrated catalogs.
- If `presetId` is omitted and the catalog has no default preset → reject with a clear error ("This catalog requires an explicit `presetId`; available presets: …"). Catalogs with `promptOnPreset` fields fall into this branch unless an admin has explicitly marked one of their presets as default.

### New: preset CRUD

Under `/api/internal_mcp_catalog/:catalogId/presets`:


| Method | Path         | Auth   | Behavior                               |
| ------ | ------------ | ------ | -------------------------------------- |
| GET    | `/`          | member | List presets for catalog               |
| POST   | `/`          | admin  | Create preset (always non-default; `isDefault` is not accepted in the request body) |
| PATCH  | `/:presetId` | admin  | Update `fieldValues` only. `name` and `isDefault` are immutable. |
| DELETE | `/:presetId` | admin  | Cascade-delete installs, pods, secrets |


Add to `requiredEndpointPermissionsMap` in `shared/access-control.ee.ts` — match permissions on existing catalog endpoints.

**Validation at preset save** (POST and PATCH):

- Only `promptOnPreset: true` field keys are permitted in `fieldValues`. Entries for static fields (neither flag set) and user fields (`promptOnInstallation: true`) are rejected — static fields are locked at the catalog level, user fields are caller-supplied. This single rule covers both "unknown keys" and "static-field locking."
- For every catalog field with `required: true` and `promptOnPreset: true`, the *effective* value at preset save — `preset.fieldValues[key] ?? field.value ?? field.default` — must resolve to a non-empty value. If the chain resolves to nothing, reject the request. This catches the "admin creates a preset that omits a required key and the catalog has no fallback" case at save time, not at install time.

Default-preset rules:

- `isDefault` is **system-managed**. The flag is set exclusively by the auto-creation path (catalog creation when the catalog has no `promptOnPreset: true` fields, plus the migration backfill). The API never accepts it from clients — it's not in any request body, not on POST, not on PATCH.
- The partial unique index `catalog_preset_one_default` enforces "at most one default per catalog" defensively at the DB level.
- Once set, `isDefault=true` is never modified. Eliminates the tool-rename-on-flip class of bugs entirely.
- Auto-creation triggers: catalog creation when the catalog has no `promptOnPreset: true` fields, plus the one-time migration backfill for pre-spec catalogs. Catalogs with `promptOnPreset` fields never get an auto-default.
- Deletion of the default preset is allowed (FK restrict still protects against deletion-while-installs-exist). After deletion the catalog has no default, permanently — admins can create new presets, but those are non-default, so installs from then on must supply `presetId` explicitly. Same end-state as a catalog that started with `promptOnPreset` fields.

`reinstall_required` scoping: when `PATCH` changes a preset's `fieldValues`, set `reinstall_required = true` only on `mcp_server` rows whose `presetId` matches the changed preset. Catalog-level changes (image, command, mappings, mappingTemplates) still flip the flag on every install of the catalog, as today.

### New: cross-catalog admin views


| Method | Path                       | Auth  | Behavior                                                          |
| ------ | -------------------------- | ----- | ----------------------------------------------------------------- |
| GET    | `/api/mcp_catalog/presets` | admin | Flat list across catalogs with rolled-up caller/pod/status counts |
| GET    | `/api/mcp_catalog/fields`  | admin | Flat audit view derived from `userConfig` and `localConfig.environment`, including each field's scope (static / preset / user — derived from the `promptOnInstallation` and `promptOnPreset` flags) and any per-preset overrides |


Both v1.5 — defer the Fields view if scope pressures.

## Runtime

### Per-call header resolution — `routes/mcp-gateway.ts` + `clients/mcp-client.ts`

The per-call header plumbing already exists via `extractPassthroughHeaders()` (mcp-gateway.ts:290) and `mergePassthroughHeaders()` (mcp-client.ts:1562, 1592). The new piece is preset-aware header resolution:

1. Resolve which `mcp_server` install the call hits (already known via gateway routing).
2. Load the catalog's `userConfig` and `mappingTemplates`, plus the install's preset `fieldValues` and the caller's `userConfigValues`. (`localConfig.environment` is irrelevant per call — env-var values are already baked into the pod for self-hosted catalogs and don't apply to remote.)
3. **Single-field header mappings** — for each `userConfig` field with `headerName` set, resolve its value via the resolution chain (user fields from caller; preset fields from `preset.fieldValues` with `field.value` / `field.default` as fallback) and inject into the named header (with optional `valuePrefix`).
4. **Template header mappings** — for each `mappingTemplates` entry with `target.kind === 'header'`, resolve every `{key}` placeholder via the same chain, substitute, and inject the rendered string into the named header.
5. Merge into the existing per-call header set.

`env-var` and `secret-file` targets — single-field or template — are not applied per call. They are baked at install time:

- **Self-hosted single-tenant**: per-install pod env / secret is the install's resolved preset-field values. One pod per `(preset, scope-target)`.
- **Self-hosted multitenant**: per-preset pod env / secret is the preset's resolved preset-field values. One pod per preset, shared across all installs of that preset.
- **Remote**: no pod; `env-var` and `secret-file` targets are invalid (existing constraint, unchanged).

Templates targeting `env-var` or `secret-file` may not reference user-scoped fields, since those values are per-caller and the target is shared across callers within a pod. Validate at catalog save.

### K8s naming — `k8s/mcp-server-runtime/k8s-deployment.ts`


| Function                                                         | Current                                            | After                                                                        |
| ---------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `constructDeploymentName` (line 272)                             | catalogId[:8] for multitenant, mcpServer.name else | Both: unsuffixed for the default preset (back-compat — existing multitenant pods keep their names); suffixed with preset name for non-default presets. Multitenant base remains catalogId[:8]; single-tenant base remains mcpServer.name. |
| `constructK8sSecretName` (line 294)                              | catalogId[:8] for multitenant, mcpServerId else    | Same suffixing rule — unsuffixed for default preset, preset-name suffix for non-default. |
| `McpServerModel.constructServerName` (`models/mcp-server.ts:30`) | suffix by ownerId/teamId                           | also suffix by preset name when preset is non-default                       |


Pods per preset, by server type:

- **Remote**: 0 (no pod ever; preset values flow per-call as headers).
- **Self-hosted single-tenant**: one per `(preset, scope-target install)`.
- **Self-hosted multitenant**: one per preset, shared across all installs of that preset.

Default preset's pod inherits the catalog's existing deployment name, so existing multitenant pods do not churn at migration time. Non-default presets get suffixed names.

Pod creation for self-hosted multitenant becomes preset-keyed: the first install of a preset spins up its pod; subsequent installs of the same preset reuse it. Deleting the last install of a non-default preset tears the pod down (the default preset's pod stays as long as the catalog exists).

## Agent-tool wiring

- **Tool name prefixing**: tools belonging to the **default preset** keep their unprefixed names (`query`). Tools belonging to **non-default presets** get prefixed (`sql_studio2__query`). Adding a second preset is purely additive — existing tool names never change. The prefix exists so that an agent binding to multiple presets exposes distinguishable tools to the LLM; DB-level uniqueness is handled by the `presetId` column on `tools` (see §Data model), not by the name.
- **Tool storage dedup**: handled by the new 5-column unique constraint on `tools` — `unique(catalogId, presetId, name, agentId, delegateToAgentId)` (see §Data model `Modified: tools`).
- **Tool invocation policies**: match by `(catalogId, baseName)` so a policy on `query` blocks all presets, unless the policy is explicitly per-preset.
- **Auto-assign on personal install** (`routes/mcp-server.ts:697-699`): per-preset. Installing Studio 2 adds Studio 2's tools without touching Studio 1's bindings.

## Out of scope (v1)

- Per-preset visibility / team restrictions
- Per-preset OAuth client config
- Template language beyond simple `{field}` substitution (no Handlebars, conditionals, or expressions)
- Central Fields admin page (defer until central Presets page proves the pattern)
- "Create preset at install time" UX (admins create, users pick)
- Bulk operations on the central Presets page (revoke all, export CSV)
- Per-preset metrics dashboards (status pill is sufficient v1)

## Risks

1. **Migration on prod data.** Backfilling thousands of `mcp_server.preset_id` rows. Dry-run on a copy of prod data before running. Stage in batches if needed.
2. **Cascade semantics.** Deleting a preset must clean up installs, pods, secrets, tools, and agent_tool bindings. Application-level deletion runs the existing per-install teardown (which handles K8s pods + secrets) for each `mcp_server` row, then deletes the preset row. The DB cascade then drops `tools` rows via `tools.preset_id`, which in turn drops `agent_tools` rows via the existing `agent_tools.tool_id` cascade. The FK on `mcp_server.preset_id` should be `restrict` (not `cascade`) to enforce that the application-level pod teardown runs first; the FK on `tools.preset_id` is `cascade`. No change is needed to `agent_tools.mcpServerId` cascade behavior — the cleanup flows through `tools` instead.
3. **OAuth/enterprise-managed configs** stay catalog-level in v1. Document that two presets can't have different OAuth apps; revisit if a real catalog needs it.
4. **No preset-level access control.** Anyone with install permission on a catalog can install any preset, including presets whose fieldValues contain shared secrets. Admin responsibility in v1; revisit by adding per-preset visibility if this becomes a real problem.

