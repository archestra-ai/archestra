---
title: Writing Skills
description: Create and edit SKILL.md skills in the UI or from chat
order: 1
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Write a skill on the **Skills** page, or ask an agent to write one for you in chat.

## Write a Skill

1. Go to **Skills**, click **Add new skill**, and pick **Blank template**.
2. Write the `SKILL.md`: frontmatter with a `name` and a `description`, then the instructions.
3. Add any resource files the instructions use.
4. Choose who can use the skill, and click **Create skill**.

The **description** decides when an agent loads the skill on its own, so say what the skill does and when to use it.

### What Goes in a Skill

Only `SKILL.md` is required. The other folders are optional:

```text
skill-name/
├── SKILL.md          # required: frontmatter + instructions
├── references/       # optional: docs the model reads on demand
├── scripts/          # optional: code, runnable in the code sandbox
└── assets/           # optional: templates, images, fonts
```

An example `SKILL.md`, with two resource files:

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

The agent sees the list of resource files and reads each one only when it needs it.

To tailor a skill to each person, add `templated: true` to its frontmatter. Its `SKILL.md` body can then use the same expressions as [prompt templates](/docs/agents#prompt-templates), such as `{{user.name}}`. Archestra fills them in for the person who uses the skill.

### Naming

- Use lowercase letters, digits, and single hyphens, such as `pdf-to-markdown`. A name like `Build App` works in Archestra, but a gateway cannot [publish it over MCP](/docs/mcp/gateway#publish-skills).
- A name is unique per author, so two people can each have a `refunds` skill.

### Compatibility

The optional `compatibility` field says what the skill needs to run, such as a Python version. Archestra shows it next to the skill's name, and the agent can tell you when your setup does not meet it.

<span id="editing-a-skill"></span>
<span id="authoring-skills-from-chat"></span>

## Write a Skill from Chat

Ask an agent to write a skill. It drafts the files and saves the skill, ready to use as a slash command.

- It is personal. To share it, open the skill's **Permissions** tab.
- It takes the agent's [environment](/docs/admin/environments).
- Ask for changes in chat, too. The agent edits the skill in place, or rewrites it.

The agent uses the [`create_skill`](/docs/reference/archestra-mcp-server#create_skill), [`edit_skill`](/docs/reference/archestra-mcp-server#edit_skill), and [`update_skill`](/docs/reference/archestra-mcp-server#update_skill) tools. Creating needs the [`skill:create`](/docs/reference/permissions#skill:create) permission. Changing a skill needs update access to it.
