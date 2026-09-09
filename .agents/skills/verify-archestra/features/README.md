# Archestra verification feature map

This index is the source of truth for the currently mapped Archestra agent and chat behavior. It is a focused starter map, not a claim of complete product coverage.

## Shared baseline

- Run commands from `platform/` with Node 24 through `mise x node@24 --`.
- Prefer the isolated lite stack. When adopting a live Tilt stack, record its checkout and do not run stateful recipes unless that shared-state use is authorized.
- Use a unique marker containing the run ID in every created agent name and chat prompt.
- Drive the browser with Playwright fixtures and semantic locators. Do not count API-only setup or assertions as browser entry-point coverage.
- Put durable evidence and the run report in `.artifacts/verify-archestra/<UTC-run-id>/`.
- One driver owns an instance. Parallel feature runs need separate databases and ports.
- Cleanup owns only agents, conversations, provider fixtures, and processes created by the run.

## Mapped features

| Feature ID | Feature | Entry points | Map |
| --- | --- | --- | --- |
| `AGENT-CONFIG` | Create and configure an agent | Agents list, agent detail, legacy edit deep link | [Agent configuration](agent-configuration.md) |
| `AGENT-CHAT` | Start and continue a browser chat with an agent | New Chat, agent Chat action, persisted conversation URL | [Chat with an agent](chat-with-agent.md) |
| `A2A-OUTBOUND-CONFIG` | Connect and configure an external A2A agent | External Agents list, create, and detail pages | [External A2A agent configuration](external-a2a-agent-configuration.md) |

Every feature file appears exactly once above. Every run report must include feature/sub-feature ID, entry-point ID, status, observed result, evidence path, and revision/build.

## Known user surfaces not yet mapped

- Agent import, export, clone, version-history restore, trash restore, permanent delete, bulk visibility, pin-as-default, conversion to skill, and fully configured messaging-channel delivery.
- External A2A credential variants, live remote-agent interoperability beyond the deterministic fixture, disabled-connection behavior, and exhaustive visibility/RBAC matrices.
- MCP Gateway configuration and connection behavior.
- Chat attachments, voice input, locked chats, apps, browser panel, tool approval, message queue, context compaction, projects, sharing, feedback, fork, delete/restore, and external ChatOps/email/A2A entry points.
- RBAC matrices beyond the prerequisite permissions stated in each recipe, multi-browser coverage, mobile behavior, and provider parity beyond the existing provider-loop tests.
