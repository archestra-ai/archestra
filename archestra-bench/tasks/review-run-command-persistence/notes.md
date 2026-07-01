# review-run-command-persistence (positive)

Real defect mined from archestra history. Snapshot base `6698224a` (commit before fix `050f17e94`,
"fix(sandbox): strip NUL bytes from run_command output before persistence"). Snapshot is the backend
persistence neighbourhood, byte-identical to the negative task `review-file-upload-persistence` so the
file set never reveals which task is which. History is stripped (no `.git`), so the fix is unreachable.

**Entry under review:** `appendCommand` in `models/skill-sandbox-replay-event.ts`.

## Gold: `decline:nul-persistence`
`appendCommand` writes `command.stdout` / `command.stderr` straight into the `text` columns of
`skillSandboxCommandsTable` (`database/schemas/skill-sandbox-command.ts:29-30`). Postgres `text`
rejects `0x00`, so binary command output (`curl … | head`, `cat image.png`) crashes the insert and the
run. The decisive evidence (column type) is in a *different* file from the entry method and among 112
schemas — confirming the verdict requires navigating the snapshot, not reading one file.

## Distractor falsification (each must be FALSE for clean grading)
- `output-not-truncated` — FALSE: command output is capped by the supervisor `--out-cap`
  (`skill-sandbox-runtime-service.ts:182,210`), with a `truncated` flag.
- `no-timeout` — FALSE: `resolveTimeout` enforces `timeoutSeconds`
  (`skill-sandbox-runtime-service.ts:98`; `timeout_seconds` column exists).
- `unawaited-write` — FALSE: `appendCommand` runs inside an awaited transaction.
- `missing-validation` — FALSE: values are typed before insert.
- `stderr-ordering` — FALSE: stdout/stderr are separate columns, never interleaved.
