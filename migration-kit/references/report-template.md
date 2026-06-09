# Migration report template

Use this structure for `report.md` after `apply.py` writes `migration_result.json`. Keep it practical:
the reader is deciding whether the existing PoC/pilot is now usable in Archestra, not reviewing an
exhaustive command transcript.

## Summary

- Source setup: `<path>`
- Archestra instance: `<base_url>`
- Scope used by default: `<personal|team|org>`
- Overall result: `<ready to try|ready with follow-up|blocked>`
- Created: `<n>`
- Skipped because already present: `<n>`
- Failed: `<n>`
- Manual follow-up items: `<n>`

## Ready to try in Archestra

| Kind | Name | Scope | Archestra id | Notes |
| --- | --- | --- | --- | --- |
| agent | `<name>` | `<scope>` | `<id>` | `<notes>` |

## Already present

| Kind | Name | Scope | Reason |
| --- | --- | --- | --- |
| skill | `<name>` | `<scope>` | `<detail from result>` |

## Failed

| Kind | Name | Error | Next step |
| --- | --- | --- | --- |
| mcp_install | `<name>` | `<verbatim error>` | `<specific retry/fix>` |

## Manual follow-up

| Source | Why manual | Recommended action |
| --- | --- | --- |
| `<path or source_id>` | `<no direct Archestra equivalent>` | `<specific action>` |

For unresolved guard hooks, include the exact policy JSON that should be created once the target
Archestra tool exists.

```json
{
  "toolId": "<fill once tool exists>",
  "conditions": [
    { "key": "command", "operator": "regex", "value": "<pattern>" }
  ],
  "action": "block_always",
  "reason": "<why this guard existed in the source setup>"
}
```

## Behavior differences

List only the differences that apply to this migration.

- Subagent instructions moved, but Claude Code-style isolation and tool allowlists are not enforced by
  an Archestra skill.
- Local stdio MCP servers are registered in the private catalog, but run only after install.
- Passive hooks such as logging, banners, or context injection have no direct Archestra equivalent.
- Tool policies only enforce when the organization tool policy mode is restrictive.
- Prompt-only filename or artifact conventions migrated as instructions, not hard runtime checks.
- Telemetry: any source telemetry (OTEL env, observability hooks/scripts) is reported, not migrated —
  Archestra emits OTEL spans + Prometheus metrics natively. To keep an existing collector/Grafana,
  set `ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT` on the instance (see `entity-mapping.md`).

## Secrets and safety notes

- Structured secrets redacted from `inventory.json`: `<n>`
- User-supplied replacement secrets entered during migration: `<providers or env names, never values>`
- Possible secrets left inside migrated prose/code bodies: `<warnings from inventory>`

## Suggested first test

Write one short scenario the pilot owner can run immediately in Archestra to verify the migrated agent,
skills, and MCP servers work together.
