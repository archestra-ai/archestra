-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=kb_connector_document_counts is created empty in this same migration, so its validating FK cannot fail existing rows, and the cascade only removes a deleted connector's count row, which is the intended cleanup. Locks held until commit: SHARE ROW EXCLUSIVE on knowledge_base_connectors (FK) and on kb_documents (CREATE TRIGGER). Document writes wait for the backfill, one grouped scan of kb_documents, while reads are not blocked. Holding that lock through the backfill is what keeps the stored counts exact.
CREATE TABLE "kb_connector_document_counts" (
	"connector_id" uuid PRIMARY KEY NOT NULL,
	"document_count" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_connector_document_counts" ADD CONSTRAINT "kb_connector_document_counts_connector_id_knowledge_base_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."knowledge_base_connectors"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- Stored per-connector document counts. The knowledge base listing used to
-- count every kb_documents row of every connector on the page; it now sums
-- these rows instead. The counts are maintained here, by triggers, so every
-- writer of kb_documents (model methods, FK cascades, raw SQL) stays in step.
--
-- INSERT/DELETE use statement-level triggers with transition tables: one
-- grouped write per statement rather than one per row, which keeps bulk sync
-- deletes cheap. Postgres forbids transition tables on column-list UPDATE
-- triggers, and a statement-level UPDATE trigger would fire on every
-- embedding-status write, so moves between connectors use a row-level trigger
-- guarded by WHEN.
--
-- Count rows are written in connector_id order so concurrent multi-connector
-- statements take their row locks in the same order and cannot deadlock.
CREATE FUNCTION kb_documents_count_inserted() RETURNS trigger AS $$
BEGIN
  INSERT INTO kb_connector_document_counts (connector_id, document_count)
  SELECT connector_id, count(*) FROM inserted
  GROUP BY connector_id
  ORDER BY connector_id
  ON CONFLICT (connector_id) DO UPDATE
    SET document_count =
      kb_connector_document_counts.document_count + excluded.document_count;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER kb_documents_count_inserted
  AFTER INSERT ON kb_documents
  REFERENCING NEW TABLE AS inserted
  FOR EACH STATEMENT EXECUTE FUNCTION kb_documents_count_inserted();
--> statement-breakpoint
-- An UPDATE ... FROM locks its rows in join order, so lock them explicitly in
-- connector_id order first. When the connector itself is being deleted its
-- count row may already be gone (FK cascade); updating nothing is correct.
CREATE FUNCTION kb_documents_count_deleted() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM kb_connector_document_counts
  WHERE connector_id IN (SELECT connector_id FROM deleted)
  ORDER BY connector_id
  FOR UPDATE;

  UPDATE kb_connector_document_counts c
  SET document_count = c.document_count - d.n
  FROM (
    SELECT connector_id, count(*) AS n FROM deleted GROUP BY connector_id
  ) d
  WHERE c.connector_id = d.connector_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER kb_documents_count_deleted
  AFTER DELETE ON kb_documents
  REFERENCING OLD TABLE AS deleted
  FOR EACH STATEMENT EXECUTE FUNCTION kb_documents_count_deleted();
--> statement-breakpoint
-- Make sure the destination row exists, then lock both rows in connector_id
-- order before moving one document's worth of count between them.
CREATE FUNCTION kb_documents_count_moved() RETURNS trigger AS $$
BEGIN
  INSERT INTO kb_connector_document_counts (connector_id, document_count)
  VALUES (NEW.connector_id, 0)
  ON CONFLICT (connector_id) DO NOTHING;

  PERFORM 1 FROM kb_connector_document_counts
  WHERE connector_id IN (OLD.connector_id, NEW.connector_id)
  ORDER BY connector_id
  FOR UPDATE;

  UPDATE kb_connector_document_counts
  SET document_count = document_count - 1
  WHERE connector_id = OLD.connector_id;

  UPDATE kb_connector_document_counts
  SET document_count = document_count + 1
  WHERE connector_id = NEW.connector_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER kb_documents_count_moved
  AFTER UPDATE OF connector_id ON kb_documents
  FOR EACH ROW
  WHEN (OLD.connector_id IS DISTINCT FROM NEW.connector_id)
  EXECUTE FUNCTION kb_documents_count_moved();
--> statement-breakpoint
CREATE FUNCTION kb_documents_count_truncated() RETURNS trigger AS $$
BEGIN
  DELETE FROM kb_connector_document_counts;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER kb_documents_count_truncated
  AFTER TRUNCATE ON kb_documents
  FOR EACH STATEMENT EXECUTE FUNCTION kb_documents_count_truncated();
--> statement-breakpoint
-- Backfill last. Each CREATE TRIGGER above holds SHARE ROW EXCLUSIVE on
-- kb_documents until this migration's transaction commits, so no document
-- write can land between the triggers going live and this snapshot count.
INSERT INTO kb_connector_document_counts (connector_id, document_count)
SELECT connector_id, count(*) FROM kb_documents GROUP BY connector_id;
