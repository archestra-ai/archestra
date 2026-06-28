# review-file-upload-persistence (negative / ugly-but-legit)

Mirror of `review-run-command-persistence`. Same byte-identical snapshot (base `6698224a`), so the
file set is no tell. The code *looks* like the run_command NUL bug — external bytes persisted to
Postgres with no NUL stripping — but is actually safe. Punishes reviewers that decline on surface
pattern-match; confirming `approve` requires opening the schema.

**Entry under review:** `appendUpload` in `models/skill-sandbox-replay-event.ts`.

## Gold: `approve`
`appendUpload` writes upload bytes into a `bytea` column (`database/schemas/skill-sandbox-file.ts`,
`const bytea = customType…`, `data: bytea("data")`), which holds arbitrary bytes incl. `0x00`. The
text metadata columns (`path`, `mime_type`, `original_name`) carry filenames/paths, which cannot
contain NUL. So the lure verdict `decline:nul-persistence` is FALSE here.

## Distractor falsification
- `nul-persistence` — FALSE: bytes go to `bytea`; text columns are structurally NUL-free metadata.
- `output-not-truncated` — FALSE: `artifactBytesLimit` enforced and empty rejected
  (`skill-sandbox-runtime-service.ts:276-282`).
- `unawaited-write` — FALSE: `appendUpload` is an awaited insert.
- `missing-validation` — FALSE: size and emptiness validated before insert.
- `no-timeout` / `stderr-ordering` — N/A to an upload path.
