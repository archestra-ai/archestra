# Agent Skills — Design Doc

Status: **design review** (implementation paused). Working branch: `fix-slack` (skills work not yet committed).

This doc exists so the design can be discussed in a dedicated session before building.
It captures what is decided, what is open, and why.

Spec: <https://agentskills.io/specification> ·
Client guide: <https://agentskills.io/client-implementation/adding-skills-support>

---

## 1. Goal

Add Agent Skills support to Archestra: reusable `SKILL.md` instruction sets that
agents can load on demand (progressive disclosure), so a chat only pays the token
cost of skills it actually uses.

Archestra is **cloud-hosted**: there is no local filesystem to scan, and the chat
model has **no generic file-read tool** and **no code sandbox**. That constraint
shapes every decision below.

---

## 2. What a skill is (spec recap)

A skill is a *directory*:

```
skill-name/
├── SKILL.md          # required: YAML frontmatter + markdown instructions
├── scripts/          # optional: executable code
├── references/       # optional: extra .md docs, loaded on demand
└── assets/           # optional: templates, images, data
```

Real catalogs (`mattpocock/skills`, `addyosmani/agent-skills`) also put reference
`.md` files **directly next to `SKILL.md`** (e.g. `tdd/tests.md`), referenced as
`[tests.md](tests.md)`. So "resources" = any non-`SKILL.md` file in the dir.

`SKILL.md` frontmatter fields: `name` (req), `description` (req), `license`,
`compatibility`, `metadata`, `allowed-tools`.

Three-tier progressive disclosure:

| Tier | Content | ~tokens | Loaded |
|------|---------|---------|--------|
| 1 Catalog | `name` + `description` | 50–100/skill | always |
| 2 Instructions | `SKILL.md` body | <5000 | on activation |
| 3 Resources | `references/*`, `scripts/*`, `assets/*` | varies | on demand |

---

## 3. Research: how real clients do it

A subagent inspected source for 6 open-source clients (OpenCode, OpenHands, pi,
fast-agent, nanobot, + Claude Code docs). Findings:

- **No client inlines resources** at activation — all follow progressive
  disclosure; activation results only *list* available files.
- **Dedicated activation tool returning the `SKILL.md` body as text** is a proven
  pattern (OpenCode `skill`, OpenHands `invoke_skill`, fast-agent `read_skill`).
  The body itself needs no filesystem access.
- Every client still expects the model to read `references/*` and run `scripts/*`
  via *some* tool — generic `read`/`bash`, or a workspace sandbox (OpenHands).
- For our exact constraint (no model FS tool, no sandbox), the recommended shape
  is: **activation tool (text body) + a harness-mediated `read_skill_file` tool
  (text only) + treat `scripts/` as inert text** the model can read but not run.
- `scripts/` that genuinely need a runtime should be flagged via the
  `compatibility` frontmatter field — degrade-and-warn, do not refuse.

This validates the design below.

---

## 4. Data model

Two new tables for v1 (Drizzle / Postgres). A third — `agent_skill` — is
deferred; see below.

### `skills` — catalog + SKILL.md body + provenance
| column | type | notes |
|--------|------|-------|
| `id` | uuid pk | |
| `organizationId` | text | indexed |
| `authorId` | text → users (set null) | creator/importer |
| `name` | text | catalog tier; unique per org |
| `description` | text | catalog tier |
| `content` | text | SKILL.md body (tier 2) |
| `license` | text? | frontmatter |
| `compatibility` | text? | frontmatter — flags runtime needs |
| `metadata` | jsonb | frontmatter `metadata` map |
| `sourceType` | `manual` \| `github` | provenance |
| `sourceRef` | text? | e.g. `owner/repo@ref:path` |
| `sourceCommit` | text? | commit SHA at import |
| `createdAt`/`updatedAt` | timestamp | |

Unique `(organizationId, name)`.

### `skill_files` — bundled resources (tier 3), one row per file
| column | type | notes |
|--------|------|-------|
| `id` | uuid pk | |
| `skillId` | uuid → skills (cascade) | |
| `path` | text | relative, e.g. `references/REFERENCE.md` |
| `content` | text | text only — no binary assets |
| `kind` | `reference` \| `script` \| `asset` | derived from path |

Unique `(skillId, path)`.

### `agent_skill` — junction — **deferred**
v1 makes **every skill available to every agent** in the org, so no junction is
needed: discovery = "all skills in the org." A per-agent `agent_skill` junction
(`(agentId, skillId)` composite pk, cascade delete) is the planned follow-up for
scoped attachment — see §9.

**Open question:** binary assets (images in `assets/`) are unsupported in v1
(text-only `skill_files`). Acceptable?

---

## 5. Loading skills

Everything converges on one core: `parseSkill(files[])` — lenient YAML
frontmatter → metadata, body → `content`, the rest → `skill_files`.

### 5a. In-app authoring
Create/edit a skill and its files in the UI. `sourceType = manual`. Authoring UX
is raw `SKILL.md` paste + a flat resource-file list — see §7c.

### 5b. GitHub import (primary path)
Input = **repo URL + optional subpath** (mirrors `gemini skills install <url>
--path skills` and `claude /plugin marketplace add owner/repo`).

Flow:
1. Parse `owner/repo`, `ref`, `subpath` from the URL.
2. Walk the git tree (`GET /repos/{o}/{r}/git/trees/{ref}?recursive=1`).
3. Find every directory containing a `SKILL.md` under `subpath`.
4. Return the discovered skill list → user **multi-selects**.
5. For each selected skill, fetch all files in its dir → `parseSkill` → DB rows.

Decisions:
- **Private repos supported.** GitHub token is taken **per import request and
  discarded** (not persisted) — safe because import is snapshot-only, so the
  token is never needed again. No secrets-manager / settings work.
- **Snapshot only, no re-import/sync.** Imported files are copied into the DB;
  the DB row is the editable source of truth. To update: delete + re-import.
  No cron, no background jobs.
- skills.sh registry API (search/browse) **deferred to v2** — needs a
  Vercel-issued key, and skills.sh sources are GitHub repos anyway.

---

## 6. Activation — chat integration

**Revised after design review.** The original plan injected two tools per-chat
into `routes/chat/routes.ts`. They are instead **real Archestra built-in
tools** (`archestra-mcp-server/skills.ts`) so they appear in the agent tool
picker and assign like `artifact_write`/`todo_write`:

- Listed in `DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES` → auto-assigned to every new
  agent; a startup backfill (`ToolModel.backfillSkillToolsToAllAgents`, fired
  once when the tools are first seeded) assigns them to existing agents.
- Per-agent control: deselect them in the picker like any tool.
- Executed via `executeArchestraTool` with the org-scoped `ArchestraContext`.

Static tool descriptions can't embed a per-org catalog, so discovery moved into
the tool itself.

### `activate_skill({ name? })`
- **No `name`** → returns the `<available_skills>` catalog (name + description
  per org skill). This is tier 1, fetched on demand rather than always-on.
- **With `name`** → returns the SKILL.md body wrapped in `<skill_content>`, a
  `<skill_resources>` listing of bundled file paths, and the `compatibility`
  requirement if set.

### `read_skill_file({ skill, path })`
- Returns one bundled resource file's text content.
- Harness-mediated — the model never gets a generic filesystem tool; this tool
  only resolves paths within one skill's `skill_files`.
- `scripts/*` are returned as **text** (readable, not executable).

Context-compaction protection remains open — see §10.

---

## 7. UI

Lives at **`/agents/skills`** — a sidebar sub-item under "Agents", sibling to
*Scheduled* and *Triggers* (`frontend/src/app/_parts/sidebar.tsx`). Mirrors the
existing Knowledge Bases feature: top-level list + create/edit + GitHub import.

Three screens, **no custom widgets** — a flat path list stands in for a file
tree, so there is no tree component and no add-file modal.

### 7a. Skills list

```
┌──────────────────────────────────────────────────────────────────────┐
│  Skills                          [ Import from GitHub ]   [ + New ]   │
│  Reusable SKILL.md instruction sets. Available to all agents.          │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ pdf-processing                                  github       ⋯ │  │
│  │ Extract text and tables from PDF files.         3 files         │  │
│  ├────────────────────────────────────────────────────────────────┤  │
│  │ tdd                                             manual       ⋯ │  │
│  │ Test-driven development workflow.               1 file          │  │
│  ├────────────────────────────────────────────────────────────────┤  │
│  │ slack-summary                       ⚠ runtime   github       ⋯ │  │
│  │ Summarize a Slack channel into a digest.        4 files         │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

Row menu (`⋯`): Edit · Delete. `⚠ runtime` = the `compatibility` flag surfaced
to the user. Source badge: `github` | `manual`. `owner/repo@sha` provenance moves
to a tooltip/detail. Empty state: one card prompting import or manual authoring.

### 7b. GitHub import — one dialog, two states

```
┌─ Import skills from GitHub ────────────────┐   ┌─ Import skills from GitHub ─────────────────┐
│  Repository URL                            │   │  anthropics/skills @ main      [ ← Change ] │
│  ┌──────────────────────────────────────┐  │   │  Found 4 skills — select to import:         │
│  │ github.com/anthropics/skills         │  │   │  ┌───────────────────────────────────────┐  │
│  └──────────────────────────────────────┘  │ → │  │ [✓] pdf-processing            3 files │  │
│  ▸ Advanced  (subpath, private token)      │   │  │ [✓] docx-builder              5 files │  │
│                                            │   │  │ [ ] xlsx-tools     • exists   2 files │  │
│              [ Cancel ]   [ Discover → ]   │   │  │ [✓] pptx-deck      ⚠ runtime  6 files │  │
└────────────────────────────────────────────┘   │  └───────────────────────────────────────┘  │
                                                  │  ⚠ scripts/ import as readable text.        │
                                                  │            [ ← Back ]   [ Import 3 → ]      │
                                                  └─────────────────────────────────────────────┘
```

Step 1 collapses to a single URL field; subpath + private-repo token sit behind
"Advanced". Step 2 lists discovered skills for multi-select; names that already
exist in the org are disabled (`skills_org_name_idx`).

### 7c. Skill editor (create + edit, same screen)

```
┌─ New skill ─────────────────────────────────────────────────────────┐
│  SKILL.md                                                            │
│ ┌──────────────────────────────────────────────────────────────────┐│
│ │ ---                                                              ││
│ │ name: pdf-processing                                             ││
│ │ description: Extract text and tables from PDF files.             ││
│ │ ---                                                              ││
│ │                                                                  ││
│ │ # PDF Processing                                                 ││
│ │ Use `pdftotext -layout` to…                                      ││
│ └──────────────────────────────────────────────────────────────────┘│
│  parsed:  name ✓   description ✓                                     │
│                                                                      │
│  ▸ Resource files (0)             references/ · scripts/ · assets/   │
│                                                                      │
│                                        [ Cancel ]   [ Save skill ]  │
└──────────────────────────────────────────────────────────────────────┘
```

`SKILL.md` is one textarea; its frontmatter drives `name`/`description`,
validated live (Save blocked until both parse). Resource files are a
progressive-disclosure section, **collapsed by default** — the common manual
skill is `SKILL.md` alone. Expanded, it is a flat list with an inline add-row:

```
│  ▾ Resource files (2)                                                │
│  ┌──────────────────────────────────────────────────────────────────┐│
│  │ references/FORMS.md        reference        [ open ]      [ ✕ ]  ││
│  │ scripts/fill_form.py       script           [ open ]      [ ✕ ]  ││
│  │ ⌨ references/new-file.md…                                [ add ] ││
│  └──────────────────────────────────────────────────────────────────┘│
```

`open` swaps the textarea above to that file (a breadcrumb switches back);
`kind` is derived read-only from the path prefix (`references/`/`scripts/`/
`assets/`). Detail view = the same editor.

---

## 8. API surface (`routes/skill.ts`)

- `GET /api/skills` — list (paginated)
- `POST /api/skills` — manual create
- `GET /api/skills/:id` — get (with files)
- `PUT /api/skills/:id` — update
- `DELETE /api/skills/:id` — delete
- `POST /api/skills/github/discover` — `{ repoUrl, path?, githubToken? }` → discovered list
- `POST /api/skills/github/import` — `{ repoUrl, path?, githubToken?, skillPaths[] }` → created skills

RBAC: reuse the existing **`agent`** resource (read/create/update/delete) — no new
RBAC resource enum entry. With no per-agent attachment in v1, `AgentModel` is
untouched.

---

## 9. Scope / phasing

**v1 (this work):** 2 tables + migration, types, models, `SKILL.md` parser,
GitHub import service, CRUD API, `activate_skill` + `read_skill_file` chat tools,
unit tests, UI per §7.

**Deferred:** per-agent skill attachment (`agent_skill` junction + endpoints),
skills.sh registry search, binary assets, context-compaction protection,
`scripts/` execution, `allowed-tools` frontmatter.

---

## 10. Open questions

**Resolved in the design-review session:**

- *Navigation* — Skills live at `/agents/skills`, a sidebar sub-item under
  "Agents" (sibling to Scheduled/Triggers).
- *Authoring UX* — raw `SKILL.md` paste + a flat, collapsible resource-file list;
  paths encode the folder structure, so no file-tree widget. See §7.
- *Per-agent attachment* — out of scope for v1; every skill is available to every
  agent. `agent_skill` junction + scoped attachment is the planned follow-up.
- *`compatibility` warnings (user-facing)* — surfaced in the UI as a `⚠ runtime`
  badge on the skill row and in the import dialog.

**Still open:**

1. Binary assets unsupported in v1 — OK?
2. `compatibility` warnings — should they also surface to the *model* at
   activation, not just the user?
3. Context-compaction protection — v1 or v1.1?
4. Any appetite for skills.sh search in v1, given the API-key friction?

---

## 11. Implementation status

v1 **implemented**. Summary of what landed:

- **Schema**: `skills` + `skill_files` tables registered in `schemas/index.ts`;
  migration `0242_common_whiplash.sql`. `agent-skill.ts` dropped (deferred §4).
- **Types**: `backend/src/types/skill.ts` (drizzle-zod + `SkillSourceType` /
  `SkillFileKind` enums).
- **Models**: `SkillModel` (CRUD + transactional `createWithFiles` /
  `updateWithFiles`) and `SkillFileModel`.
- **Services**: `backend/src/skills/parser.ts` (`SKILL.md` frontmatter parser)
  and `backend/src/skills/github-import.ts` (discover + snapshot import).
- **API**: `routes/skill.ts` — CRUD + `POST /api/skills/github/{discover,import}`,
  gated on the `agent` RBAC resource.
- **Chat**: `activate_skill` + `read_skill_file` are Archestra built-in tools
  (`archestra-mcp-server/skills.ts`), assigned to every agent by default — see
  the revised §6.
- **UI**: `/agents/skills` — list, GitHub import dialog, skill editor; sidebar
  sub-item under Agents.
- **Tests**: unit (parser), integration (CRUD routes), chat-tool tests — 25
  cases. **Not done**: Playwright e2e and a docs screenshot pass.
- **Docs**: `docs/pages/platform-agent-skills.md` (text; screenshot pending).
