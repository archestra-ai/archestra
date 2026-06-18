-- Remove the knowledge-base "File Upload" connector type. Delete its connectors
-- first (cascades to their kb_documents and kb_chunks), then drop the table that
-- stored the uploaded file bytes/metadata.
DELETE FROM "knowledge_base_connectors" WHERE "connector_type" = 'file_upload';
--> statement-breakpoint
DROP TABLE "kb_uploaded_files" CASCADE;
