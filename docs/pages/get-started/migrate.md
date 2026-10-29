---
title: Migrate Your Agents
description: Turn a Claude Code project into a shared Archestra agent, with its skills, MCP servers, and hooks
order: 4
lastUpdated: 2026-10-06
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Turn the agent you built in a project folder into a shared Archestra agent. Its instructions, skills, MCP servers, and hooks become Archestra resources your team can use.

The migration kit is a skill. Run it in Claude Code, Cursor, OpenCode, or any agent that runs skills. It shows you a plan first, and creates only what you approve.

It reads Claude Code's project files: `CLAUDE.md`, the `.claude/` folder, `.mcp.json`, and Python tools under `tools/`. An OpenClaw config goes into the report for you to move by hand. Starting from scratch? Skip this page.

<span id="what-it-produces"></span>

## What Moves

| In your project | Becomes in Archestra |
| --- | --- |
| Instructions, such as `CLAUDE.md` | An [agent](/docs/agents) with those instructions |
| Skills, slash commands, and scripts | [Skills](/docs/agents/skills) with their bundled files |
| Subagent instructions | A skill, or a separate agent if you choose. Tool restrictions do not carry over. |
| MCP servers | [MCP catalog entries](/docs/mcp/servers). Local servers run in Archestra's Kubernetes environment. |
| `SessionStart`, `PreToolUse`, and `PostToolUse` hooks | [Hooks](/docs/agents/hooks), when compatible |
| Provider keys | [Model provider keys](/docs/llm-proxy/providers), only for secrets you supply |

Everything else, such as OpenClaw runtime settings and other hook events, goes into a follow-up report for you to move by hand.

<span id="install"></span>

## Run the Migration

You need a coding agent that runs skills and Python 3.10 or newer.

1. Install the skill:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/archestra-ai/archestra/main/migration-kit/install.py | python3
   ```

   It goes into the skills folder of each coding agent it finds: Claude Code, Cursor, and OpenCode. For another agent, add `- --dest <skills-folder>/migrate-to-archestra` after `python3`.

2. Open your coding agent in your project's directory and paste:

   ```text
   Use the migrate-to-archestra skill to migrate this project
   into http://localhost:9000. Show me the migration plan before applying it.
   ```

   Use your own Archestra API URL if it is not local (such as `https://archestra.example.com`). If your deployment requires authentication, create an API key under **Account → API Keys** and provide it when prompted.


3. Review the plan. Choose the agents, skills, and MCP servers to create, and who can see each one: you, a team, or the organization.
4. Approve. The skill creates what you approved and writes a report. It also turns on the organization's skill tools and adds sandbox tools to migrated agents.

Before you share migrated resources, read the report's warnings. The kit hides secrets it finds in config files, but secrets inside instructions or scripts stay there.

## Check the Result

1. Open the new agent under **Agents** and start a conversation.
2. Ask it to use one migrated skill.
3. Fix the report's failures and follow-up items.

Running the migration again skips resources that already exist. Hook tool matchers do not carry over. The [migration kit README](https://github.com/archestra-ai/archestra/tree/main/migration-kit) covers installer options and unsupported cases.
