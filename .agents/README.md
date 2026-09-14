# Shared coding-agent configuration

Keep shared skills in the repository-root `.agents/skills/`. They cover the
platform, docs, catalog, benchmarks, and releases. Codex discovers this directory
when started in `platform/` or a deeper directory; no platform symlink is needed.

`AGENTS.md` files hold shared instructions. The adjacent `CLAUDE.md` files import
those instructions with `@AGENTS.md`, without duplicating their contents or using
instruction-file symlinks. Keep individual platform preferences in the ignored
`platform/CLAUDE_LOCAL.md` file.

Claude Code still discovers project skills through `.claude/skills/`. The single
root `.claude/skills` symlink points to `../.agents/skills`, so both clients read
the same files. Keep this compatibility link until Claude supports the shared
location directly. Both clients discover root skills when launched in
`platform/`; do not add another skills link there. Check out Git symlinks as
symlinks on systems that require explicit symlink support.

The root `.claude/settings.json` disables Claude attribution in commits and PRs.
`platform/.claude/settings.json` symlinks to it so the same setting applies when
Claude starts from `platform/`. Only the settings file is linked; skills continue
to be discovered from the root. Formatting checks remain in the existing Husky
pre-commit workflow.

The root `AGENTS.md` asks all agents, including Codex, to omit AI attribution from
commits and PRs. This is an instruction, not a client-enforced setting. There is
no Codex attribution key in the documented configuration reference, so no
`.codex/config.toml` is needed for this preference.

Other clients can read the skills as files using the routing instructions in
`AGENTS.md`; automatic discovery and slash commands depend on the client's
supported locations. This layout does not claim universal automatic discovery.

After changing this layout, start fresh sessions from the repository root and
from `platform/`. In Codex, check the skills selector and instruction sources.
In Claude Code, check `/skills` and `/context`. Confirm that shared skills appear
and that the relevant `AGENTS.md` instructions are imported.

References:

- [Codex skills discovery](https://learn.chatgpt.com/docs/build-skills)
- [Codex instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Claude Code skills discovery](https://code.claude.com/docs/en/skills)
- [Claude Code AGENTS.md imports](https://code.claude.com/docs/en/memory#agentsmd)

- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
