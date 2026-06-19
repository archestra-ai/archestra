-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=This migration's purpose is to remove the Knowledge > Files connector: the kb_uploaded_files table and its data are being permanently retired along with all code that reads them in this same change, so the destructive DROP TABLE (and its CASCADE) is intentional and there is no old code left to break.
-- Remove the knowledge-base "File Upload" connector type. Delete its connectors
-- first (cascades to their kb_documents and kb_chunks), then drop the table that
-- stored the uploaded file bytes/metadata.
DELETE FROM "knowledge_base_connectors" WHERE "connector_type" = 'file_upload';
--> statement-breakpoint
DROP TABLE "kb_uploaded_files" CASCADE;
--> statement-breakpoint
-- Retire the now-unused `knowledgeFile` RBAC resource: strip its grants from any
-- existing custom organization roles so the stored permission JSON no longer
-- carries a dead resource key.
UPDATE "organization_role"
SET "permission" = ("permission"::jsonb - 'knowledgeFile')::text,
    "updated_at" = NOW()
WHERE ("permission"::jsonb) ? 'knowledgeFile';
