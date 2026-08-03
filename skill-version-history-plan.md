# Skill version history & restore — implementation plan

Status: planned, not started. Scope of the first iteration: **frontend-only**, on real data, in the real Archestra UI.
Visual reference: interactive mockup at https://claude.ai/code/artifact/a4beb9bd-77c6-43eb-ad5e-0fa39ebc6fd1

## Background

Three `_versions` tables exist (agents, skills, apps) with a shared design: append-only immutable
snapshots, per-entity `version` counter from 1, `contentHash` (sha256) suppressing no-op forks, and a
`latest_version` head pointer on the parent. Skills were chosen first: the payload is one markdown
body + resource files (easy to diff), the list/detail APIs already exist, and versions are
operationally meaningful (sandboxes pin them).

Key code:

- Schema: `platform/backend/src/database/schemas/skill-version.ts` (+ `skill-version-file.ts`)
- Model: `platform/backend/src/models/skill-version.ts` (`computeContentHash` at :37)
- Routes: `platform/backend/src/routes/skill/skill.routes.ts`
  - `GET /api/skills/:id/versions` (:737, paginated metadata) and `GET /api/skills/:id/versions/:version` (:770, body + files)
  - `PUT /api/skills/:id` (:807) — every content edit forks a version; frontmatter drives `name`/`description`/`allowedTools`
  - `POST /api/skills/:id/reset` (:1049) — built-in skills only; shipped in PR #5223
- Generated SDK already has `getSkillVersions`/`getSkillVersion` (`shared/hey-api/clients/api/sdk.gen.ts`)
- Frontend skills UI: `platform/frontend/src/app/skills/` (list page + `_parts/skill-editor-dialog.tsx`)

## Decisions record

| # | Topic | Decision |
|---|---|---|
| 1 | Mechanics | Fork-forward: restoring v6 while head is v12 creates v13 with v6's payload; history stays append-only |
| 2 | Rename | Frontmatter `name:` drives the skill name, so restore may rename; allowed, warned inline, 409 on namespace conflict |
| 3 | Payload | Full: SKILL.md body + all resource files replace live `skill_files` |
| 4 | Untouched | Scope, teams, user grants, environments, GitHub sync config — live-only, never restored |
| 5 | GitHub-synced | History read-only; restore blocked with "disconnect from GitHub first" |
| 6 | Concurrency | `expectedHeadVersion` guard (client-side approximation now, server-side later) |
| 7 | Reset unification | "Reset to default" moves inside the version history dialog (built-in skills only); each reset will eventually write a `source: 'reset'` version row |
| 8 | Placement | Separate top-level dialog (no dialog-in-dialog); replaces the "Reset to default" row action |
| 9 | Attribution | New provenance columns later (see backend roadmap); omitted from UI until then |
| 10 | Diff UI | GitHub-commits-like timeline; diffs each version against its predecessor |
| 11 | Restore UX | Preview-first, then explicit confirm listing effects |
| 12 | Legacy | Pre-versioning skills are just v1; no special state |

First-iteration choices (user-confirmed):

- Restore is **real**, via the existing `PUT /api/skills/:id` (sending only `content` + `files` leaves scope/teams/etc. untouched — `skill.routes.ts:225-258`)
- Diff rendering via **Monaco `DiffEditor`** (`@monaco-editor/react` is already a dependency)
- **No attribution UI** until the backend provenance columns land
- **Component tests now**, Playwright e2e once the design settles

## Frontend iteration (build now)

### 1. Query hooks — `frontend/src/lib/skills/skill.query.ts`

- `useSkillVersions(skillId)` — `useInfiniteQuery` over the paginated list (pageSize ~20);
  `hasNextPage` drives "Load older versions". `throwOnApiError` per convention.
- `useSkillVersion(skillId, version)` — detail (body + files); enabled only when selected; also used
  to lazily fetch the predecessor (`version - 1`) for diffing.
- `useRestoreSkillVersion()` — mutation; all toasts here:
  1. Fresh `getSkill`; if `latestVersion !== expectedHeadVersion` abort with "Skill changed while
     you were previewing — review the latest version and try again." (Client-side approximation of
     the future server guard; a small TOCTOU window remains — accepted and stated.)
  2. **No-op short-circuit**: if the selected version's `contentHash` equals the head's, do not
     submit; toast "Already identical to the current version." (contentHash dedup means no fork
     would happen; without this check the success toast would claim a version that was not created.)
  3. `updateSkill` with only `{ content, files }`. **Always send `files`, even `[]`** — omitting it
     keeps the current files (`skill.routes.ts:229-231`) and would corrupt a restore of a
     zero-file version. Map `SkillVersionFile → SkillFileInput` (path/content/encoding/kind).
  4. Success: invalidate skill detail, skills list, versions; toast "Restored — v{latestVersion}
     created" using the response. Errors (409 name conflict, 400 legacy body failing today's
     manifest validation) surface the backend message verbatim, not a generic failure.

### 2. Diff wrapper — `frontend/src/components/diff-editor.tsx`

Sibling of `components/editor.tsx`: wraps Monaco `DiffEditor`, theme from `next-themes`
(`vs-dark`/`light`), `readOnly`, `tabFocusMode: true` (same WCAG rationale as `editor.tsx:27`),
`renderSideBySide: false`, `hideUnchangedRegions` on.

Known inherited caveat: `@monaco-editor/react` has no `loader.config` anywhere in the app, so Monaco
loads from the jsdelivr CDN at runtime — blank editor in air-gapped deployments. Accepted for this
iteration (existing `editor.tsx` has the same issue); self-hosting Monaco is a separate follow-up.

### 3. Dialog — `frontend/src/app/skills/_parts/skill-version-history-dialog.tsx`

Props: `skillId`, `open`, `onOpenChange`; fetches its own data (`useSkill` + hooks above).

- Wide shadcn `Dialog` (~`max-w-5xl`), two panes.
- **Left (timeline)**: rows grouped by day from `createdAt` — version chip, short `contentHash`,
  relative time, "Current" badge on `latestVersion`; "Load older versions" button.
- **Right**: header (vN · date · hash) + shadcn `Tabs`:
  - **Changes**: DiffEditor, predecessor body vs selected body, language `markdown`. Predecessor
    missing (v1 or orphaned row) → "no previous version — showing full content". Resource files:
    compare file lists → added/removed/changed chips; clicking a changed text file swaps it into the
    DiffEditor; base64 files get a "binary file changed" note.
  - **SKILL.md**: existing `Editor` component, read-only.
  - **Files**: simple rows (path · kind · encoding).
- **Footer**: preview-first restore.
  - Disabled + note when selected is current.
  - Disabled + top banner when `skill.githubSyncInterval !== null` ("Content is synced from
    GitHub — disconnect to restore").
  - **Permission-gated**: restore and reset render enabled only under
    `useHasPermissions({ skill: ["update"] })`; read-only users must not get a button that 403s.
  - Rename warning when the selected body's frontmatter `name:` differs from `skill.name` — small
    tested frontmatter-peek util (leading `---` block, `name:` line only; may drift from the backend
    parser but only affects the warning's accuracy).
  - Confirm `AlertDialog` listing effects: creates v{head+1}, replaces SKILL.md + N files,
    conditional rename line, "scope/teams/environments untouched".
- **Built-in skills** (`sourceType === "built_in"`): quiet "Reset to shipped default…" footer button
  reusing `useResetSkill` and the existing confirm copy (with `useAppName()` interpolation, as at
  `page.client.tsx:751`); success invalidates versions.
- Conventions: conditional text wrapped in `<span>` (bare-text-node rule); no hardcoded app name;
  shadcn components only.

### 4. Wiring

- `page.client.tsx`: replace the "Reset to default" row action (:463) with "Version history"
  (permission `{ skill: ["read"] }`); new `historySkill` state renders the dialog; delete
  `ResetSkillDialog` (:727), its state (:200), and mount (:620-627).
- `skill-editor-dialog.tsx`: footer "History" button via an `onShowHistory` callback — parent closes
  the editor and opens history (separate top-level dialogs).

### 5. Tests (this iteration)

- `skill-version-history-dialog.test.tsx` — mock the query hooks and both Monaco wrappers (jsdom
  cannot run Monaco): timeline grouping/selection, Current badge, restore disabled on head /
  GitHub-synced / missing update permission, rename warning on frontmatter mismatch, confirm calls
  the mutation with `{skillId, version, expectedHeadVersion}`, reset button only for `built_in`.
- Unit tests: frontmatter-peek util, file-comparison util, mutation guards (head moved → abort, no
  `updateSkill` call; identical contentHash → short-circuit) alongside the `app.query.test.ts`
  pattern.
- Update any `page.client` test touching the removed reset action.

### 6. Checks

From `platform/`: `pnpm type-check && pnpm lint && pnpm test && pnpm knip`.
Per `frontend/AGENTS.md`, consult `node_modules/next/dist/docs/` before writing (breaking Next changes).
No codegen, no DB changes, no docs changes yet (docs ride with the finalized feature).

### Accepted limitations (stated honestly)

- Restores made via PUT are **permanently** recorded as ordinary edits — when provenance columns
  land, historical restores cannot be backfilled to `source: 'restore'`.
- Client-side head check has a TOCTOU window until the server-side guard ships.
- `allowedTools` set via the API override (outside frontmatter) is silently re-derived from
  frontmatter on restore — the "frontmatter canonical" stance, happening implicitly for now.

## Backend roadmap (later PRs)

### PR A — provenance columns

Nullable, provenance-only columns on `skill_versions` (excluded from `contentHash`, same rule as
`app_versions.spec`):

```
created_by             uuid REFERENCES users(id) ON DELETE SET NULL
source                 text  -- 'editor' | 'agent' | 'conversion' | 'github_import'
                             -- | 'github_sync' | 'reset' | 'restore' | 'system'
restored_from_version  integer
```

Thread provenance through `SkillVersionModel.insertVersion` → `SkillModel.createWithFiles`/
`updateWithFiles`, stamping every fork site: skill routes (create :455, update :807, convert :604,
reset :1085, GitHub import :1474), MCP `create_skill`/`edit_skill`
(`archestra-mcp-server/skills.ts:375,436,601`), `task-queue/handlers/skill-github-sync-handler.ts`,
`seed.ts` (`system`). Metadata flows into responses automatically (`SkillVersionMetadataSchema` is
schema-derived, `types/skill.ts:122`). Then the UI adds the author/source line and "Restored from vN"
labels.

### PR B — restore endpoint

`POST /api/skills/:id/versions/:version/restore`, body `{ expectedHeadVersion }`:
`findSkillOrThrow` → `authorizeSkillModify` → 400 if `githubSyncInterval !== null` → load version +
files (404) → 409 if `latestVersion !== expectedHeadVersion` → `parseManifestOrThrow` (name conflict
→ 409 via `isSkillNameConflict`) → `updateWithFiles` with `source: 'restore'` → `loadSkillDetail`.
Route permission in `shared/access-control.ts` mirroring UpdateSkill; audit record with before/after
diff; tests in `restore-version.skill.route.test.ts` per backend conventions; OpenAPI codegen.
Frontend then swaps the mutation body — nothing else changes. No MCP restore tool for now.

### Deferred / open

- Diffstat in the timeline (store at fork time vs lazy client compute)
- "Compare to current" diff toggle
- Self-hosted Monaco (`loader.config`) — affects agents pages too, separate change
- Playwright e2e spec once the design settles
- Docs page update when the feature finalizes
