---
title: Skills
category: Agents
order: 8
description: Reusable SKILL.md instruction sets that agents load on demand
lastUpdated: 2026-05-21
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

Agent Skills are markdown instruction sets an agent loads on demand. A skill is a `SKILL.md` file plus optional resource files, following the [Agent Skills specification](https://agentskills.io/specification).

This keeps specialized knowledge out of every system prompt. Write the steps for parsing a PDF or drafting a release note once; any agent in the org can pull it in mid-chat and pay the token cost only when the skill actually runs.

## Progressive disclosure via three tools

Skills are off until an admin enables them for the organization. Enabling assigns `list_skills`, `activate_skill`, and `read_skill_file` to every existing agent and to every agent created afterwards, and exposes the tools on each agent's MCP gateway so external clients see them too. Any tool can still be dropped from an individual agent's tool picker.

The three tools reveal a skill in three steps:

- `list_skills` returns the catalog — one line per skill (`name` + `description`).
- `activate_skill` with a name returns that skill's `SKILL.md` and the list of bundled resource paths.
- `read_skill_file` fetches one resource at a time.

> **No runtime in Archestra (yet).** Archestra only reads skill files — `read_skill_file` returns scripts as text and binaries as base64, never executes them. They are stored intact so external clients that have their own runtime (Claude Code, n8n, etc.) can pull them down and run them.

## Invoking a skill from chat

Progressive disclosure leaves the choice to the model. When the user already knows which skill they want, enable **skill slash commands** — a separate organization toggle on the Skills page — and every skill becomes a `/skill-name` command in the chat input.

Typing `/` lists the available skills. Picking one, for example `/pdf-to-markdown convert this report`, activates that skill and sends the rest of the line as the prompt. The prompt is optional — `/pdf-to-markdown` on its own activates a skill meant to run as-is. The skill's `SKILL.md` is injected directly into that turn, so the model follows it without first calling `activate_skill`. Slash commands build on the skill tools, so the toggle is locked until skills are enabled for the organization.

## Writing a skill

A skill is a `SKILL.md` plus optional resource files.

```text
skill-name/
├── SKILL.md          # required: frontmatter + instructions
├── references/       # optional: docs the model reads on demand
├── scripts/          # optional: code, served as readable text (not executed)
└── assets/           # optional: templates, images, fonts
```

Names have to be unique in the organization — that is the key `activate_skill` looks up.

```markdown
---
name: pdf-to-markdown
description: Extract text from a PDF and convert it to clean markdown.
compatibility: Requires python 3.10+ with pdfplumber installed.
---

# PDF to Markdown

When the user asks to convert a PDF:

1. Read `references/HEURISTICS.md` for column-detection rules.
2. Run `scripts/extract.py <path>` to get the raw text.
3. Apply the cleanup steps below before returning the result.
```

Paired with that you would upload `references/HEURISTICS.md` and `scripts/extract.py` as resource files; both show up in the `<skill_resources>` list when the skill is activated and load on demand through `read_skill_file`.

## Authoring skills from chat

Skills do not have to be written in the UI. The `create_skill` and `update_skill` tools let an agent author them during a conversation: describe the skill you want, the model drafts the `SKILL.md` and any bundled files, then persists it. The result is immediately in the catalog and usable as a slash command.

A skill created from chat is **personal** to its author — sharing it with a team or the whole organization stays a deliberate action in the skill editor. `create_skill` needs `skill:create`; `update_skill` needs `skill:update` and only applies to skills the user is allowed to manage, keeping the skill's current scope. `update_skill` replaces a skill's entire bundled file set in one call — there is no per-file patch, so changing one resource file means re-sending all of them.

## Importing from GitHub

Paste a repository URL. Any of these work: `owner/repo`, a full https URL, or a `tree/<branch>/<path>` deep link. For private repos, paste a token — it is used for the request and never stored.

For anything bigger than a small repo, narrow the scan with the `path` field and supply a GitHub token. Archestra walks the whole tree by default, and anonymous GitHub calls share a 60-requests/hour limit — discovery on a large monorepo is slow without a path and will rate-limit without a token.

Every directory with a `SKILL.md` shows up in the result; pick which ones to import — it is not all-or-nothing. Importing many skills at once, or skills with many resource files, can take a while: each file is fetched sequentially.

The visibility **scope** chosen in the dialog applies to every skill in the batch; it defaults to **personal**, so an import is never silently published org-wide.

Each import records the source (`owner/repo@ref:path`) and the resolved commit SHA, so you can later filter the catalog by repo and see exactly which revision landed.

A few behaviors worth knowing:

- **Duplicates are skipped.** Importing a skill whose name already exists leaves the local copy alone — no silent overwrite.
- **One snapshot per session.** The repo tree is cached for five minutes, so what you previewed is what you import even if upstream moves in between.
- **Per-file 10 MB cap, 500 files per skill.** Binary assets are preserved (base64-encoded), so images and fonts round-trip.
- **No background sync.** Re-import to pull in upstream changes; your edits are never overwritten.

## Permissions and scope

Skills are a first-class RBAC resource — the `skill` resource, with `read`, `create`, `update`, `delete`, `team-admin`, and `admin` actions. They are not tied to the `agent` resource: a role can be granted skill access without agent access, and vice versa.

Every skill carries a visibility **scope**, set in the skill editor or the GitHub import dialog, exactly like agents:

- **Personal** — only the author can see, use, or manage the skill.
- **Team** — members of the assigned teams can see and use it; `skill:team-admin` (in one of those teams) or `skill:admin` can manage it.
- **Organization** — everyone in the org can see and use it; only `skill:admin` can manage it.

`skill:read` governs *using* a skill — listing it, activating it, or invoking its slash command in chat. A user only ever sees skills inside their scope (org-wide skills, their own personal skills, and skills in their teams); `list_skills`, `activate_skill`, and the `/skill-name` slash commands are all filtered the same way. `skill:admin` bypasses scope and sees every skill.

Creating an org-scoped skill requires `skill:admin`; creating a team-scoped skill requires `skill:team-admin` and membership in the teams it is assigned to. By default the predefined roles grant: **admin** — full control; **editor** — create/update/delete plus team sharing; **member** — create and manage their own personal skills, and read everything in scope.

## Compatibility

Some skills only work in specific environments — a Python interpreter, a particular OS, a tool that has to be installed first. The spec captures that as a `compatibility` field in the frontmatter. Archestra shows it as a **compatibility** badge in the skill list and import dialog, and includes the value in the `activate_skill` response so the model can tell the user when the environment cannot meet the requirement instead of failing halfway through the task.

## Distribution to External Clients

The two skill tools are plain MCP tools. Any external client — Claude Code, Cursor, Codex, n8n — that connects to an agent's MCP gateway sees them alongside the rest of that agent's tools and gets the same progressive-disclosure flow. A skill authored once in Archestra is reachable from everywhere the agent is plugged in, with no SKILL.md copies to keep in sync.

## Skills vs agents vs routing

| Primitive        | What it is                                                                              | When to use                                  |
| ---------------- | --------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Agent**        | System prompt + tools + knowledge                                                       | Default building block                       |
| **Sub-agent**    | Agent called by another agent as a helper                                               | Compose specialists under one orchestrator   |
| **Router agent** | Default agent that hands off via `swap_agent` and returns via `swap_to_default_agent`   | Pick the right specialist at runtime         |
| **Skill**        | Markdown loaded on demand via `activate_skill` / `read_skill_file`                      | Keep agents generic; attach many specializations      |
