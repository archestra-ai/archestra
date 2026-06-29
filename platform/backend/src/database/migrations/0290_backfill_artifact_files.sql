-- Backfill legacy persistent `download_file` outputs into the `files` table.
--
-- A prior refactor moved persistent outputs out of `skill_sandbox_files`
-- (rows with `kind = 'artifact'`) into the new `files` table (migration 0289),
-- but no backfill was written on the assumption the feature was undeployed.
-- Any legacy artifact rows that DO exist would otherwise 404 on their
-- `/api/skill-sandbox/artifacts/:id` URLs and vanish from the chat Files panel.
--
-- 1. Copy artifact rows into `files`, reusing the id so existing references hold:
--      - `filename` mirrors the app's `storageFilename(originalName ?? basename(path))`:
--        prefer `original_name`, fall back to the basename of `path`, else 'file'.
--      - `project_id` is NULL (artifacts predate projects).
--      - org/user/conversation come from the producing sandbox.
--      - storage is Postgres bytes (`storage_provider = 'db'`, `data` set,
--        `object_key` NULL) which satisfies `files_storage_payload_chk`;
--        `skill_sandbox_files.data` is NOT NULL so this always holds.
--      - the inner JOIN is safe (artifact rows cannot be orphaned — the FK on
--        `sandbox_id` cascades from `skill_sandboxes`).
--      - ON CONFLICT keeps the migration idempotent.
INSERT INTO "files" (
  "id", "organization_id", "user_id", "project_id", "conversation_id",
  "sandbox_id", "filename", "mime_type", "size_bytes",
  "storage_provider", "data", "object_key", "created_at"
)
SELECT
  sf."id",
  sb."organization_id",
  sb."user_id",
  NULL,
  sb."conversation_id",
  sf."sandbox_id",
  COALESCE(
    NULLIF(sf."original_name", ''),
    NULLIF(regexp_replace(sf."path", '^.*/', ''), ''),
    'file'
  ),
  sf."mime_type",
  sf."size_bytes",
  'db',
  sf."data",
  NULL,
  sf."created_at"
FROM "skill_sandbox_files" sf
JOIN "skill_sandboxes" sb ON sb."id" = sf."sandbox_id"
WHERE sf."kind" = 'artifact'
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- 2. Delete the copied artifact rows, guarded so only rows confirmed present in
--    `files` are removed (the safety net regardless of the JOIN above).
DELETE FROM "skill_sandbox_files" sf
WHERE sf."kind" = 'artifact'
  AND EXISTS (SELECT 1 FROM "files" f WHERE f."id" = sf."id");
