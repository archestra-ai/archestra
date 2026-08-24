-- Parent/child (multi-granularity) chunk indexing: a chunk's link to the
-- passage it was sliced out of.
--
-- Cheap on an existing corpus by construction. The column is nullable with no
-- default, so the ALTER is metadata-only and rewrites nothing. The index is
-- PARTIAL on `parent_index IS NOT NULL`, which no existing row satisfies —
-- every chunk written before this feature is single-pass — so the build
-- inspects the heap once and writes an empty index rather than one entry per
-- chunk. kb_chunks is a corpus table written by scheduled connector syncs
-- rather than on the request path, so the brief write lock lands on ingestion,
-- not on user queries.
ALTER TABLE "kb_chunks" ADD COLUMN "parent_index" integer;--> statement-breakpoint
CREATE INDEX "kb_chunks_document_id_parent_index_idx" ON "kb_chunks" USING btree ("document_id","parent_index") WHERE "kb_chunks"."parent_index" IS NOT NULL;