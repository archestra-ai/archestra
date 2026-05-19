---
title: Skills
category: Agents
order: 8
description: Reusable SKILL.md instruction sets that agents load on demand
lastUpdated: 2026-05-18
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

Skills are reusable instruction sets — a `SKILL.md` file plus optional resource files — that an agent loads only when a task needs them. They follow the open [Agent Skills specification](https://agentskills.io/specification).

A skill keeps specialized knowledge out of every system prompt. Instead of pasting PDF-extraction steps into one agent and Slack-digest steps into another, you author each as a skill once. Every agent in the organization can then load any skill mid-conversation, paying its token cost only when it is actually used.

## Skill tools

Skills are reached through two Archestra built-in tools, `activate_skill` and `read_skill_file`. They are assigned to every agent by default — including newly created agents — and, like any tool, can be deselected per agent in the agent's tool picker.

The tools disclose skill content progressively, so a chat pays only for what it uses:

1. **Catalog** — calling `activate_skill` with no arguments lists every skill's `name` and `description` for the organization.
2. **Instructions** — calling `activate_skill` with a skill name returns the full `SKILL.md` body.
3. **Resources** — bundled files under `references/`, `scripts/`, and `assets/` are listed on activation and loaded individually, on demand, via `read_skill_file`.

Scripts are returned as readable text — Archestra is cloud-hosted and does not execute them.

## Authoring a skill

Open **Agents → Skills** and choose **New Skill**. A skill is authored as a raw `SKILL.md`: YAML frontmatter (`name` and `description` are required; `license`, `compatibility`, and `metadata` are optional) followed by markdown instructions. Resource files are added as a flat list of paths — the `references/`, `scripts/`, or `assets/` prefix sets each file's role.

The skill name must be unique within the organization.

## Importing from GitHub

**Import from GitHub** discovers skills in any repository — every directory containing a `SKILL.md` is a skill. Enter a repository URL, optionally restrict the scan to a subpath, and supply a token for private repositories. The token is used for that single request and never stored.

Import is a one-time snapshot: the files are copied into Archestra, which then owns the editable copy. There is no background sync — to pick up upstream changes, delete the skill and import it again. Binary assets are not imported.

## Compatibility warnings

If a skill's frontmatter declares a `compatibility` requirement (for example, a runtime it expects), the skill list and the import dialog show a **runtime** badge. The requirement is also surfaced to the model on activation so it can tell the user when the environment cannot meet it.
