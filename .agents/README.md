# Shared coding-agent configuration

Keep shared instructions in `AGENTS.md` and shared skills in `.agents/skills/`.
Claude Code and Codex read `AGENTS.md` for repository instructions. Keep
individual platform preferences in the ignored
`platform/CLAUDE_LOCAL.md`; `platform/AGENTS.md` explicitly tells agents to read
it when present.

The root `.claude/skills` symlink points to `../.agents/skills` for Claude Code
discovery. Codex reads the shared location directly.

The root `.claude/settings.json` disables Claude attribution in commits and PRs.
`platform/.claude/settings.json` points to it. The root `AGENTS.md` also asks
agents to omit AI attribution.

The root `.codex/config.toml` raises `project_doc_max_bytes` to 64 KiB so the
platform instructions fit in Codex's project instruction budget. Codex loads
project configuration only in trusted projects.

Skill discovery does not guarantee invocation. Use a matching skill explicitly
when a workflow requires it. In fresh sessions from the repository root and
`platform/`, check Claude Code `/skills` and `/context` for shared skills and
`AGENTS.md` instructions.

References: [Claude Code project instructions](https://code.claude.com/docs/en/memory#agentsmd),
[Claude Code skills](https://code.claude.com/docs/en/skills),
[Codex skills](https://learn.chatgpt.com/docs/build-skills).
