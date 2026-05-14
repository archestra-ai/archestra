CREATE OR REPLACE FUNCTION archestra_install_soft_delete(
  target_schema text,
  target_table text
) RETURNS void AS $$
DECLARE
  qualified_table text := format('%I.%I', target_schema, target_table);
BEGIN
  EXECUTE format(
    'ALTER TABLE %s ADD COLUMN IF NOT EXISTS deleted_at timestamp',
    qualified_table
  );

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %s (deleted_at)',
    target_table || '_deleted_at_idx',
    qualified_table
  );

  IF EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = qualified_table::regclass
      AND attisdropped
  ) THEN
    RETURN;
  END IF;

  EXECUTE format('DROP RULE IF EXISTS archestra_soft_delete ON %s', qualified_table);
  EXECUTE format(
    'CREATE RULE archestra_soft_delete AS ON DELETE TO %s DO INSTEAD
      UPDATE %s SET deleted_at = COALESCE(deleted_at, clock_timestamp())
      WHERE ctid = OLD.ctid
      RETURNING OLD.*',
    qualified_table,
    qualified_table
  );

  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', qualified_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', qualified_table);

  EXECUTE format(
    'DROP POLICY IF EXISTS archestra_select_not_deleted ON %s',
    qualified_table
  );
  EXECUTE format(
    'CREATE POLICY archestra_select_not_deleted ON %s
      FOR SELECT USING (deleted_at IS NULL)',
    qualified_table
  );

  EXECUTE format(
    'DROP POLICY IF EXISTS archestra_insert_all ON %s',
    qualified_table
  );
  EXECUTE format(
    'CREATE POLICY archestra_insert_all ON %s
      FOR INSERT WITH CHECK (true)',
    qualified_table
  );

  EXECUTE format(
    'DROP POLICY IF EXISTS archestra_update_all ON %s',
    qualified_table
  );
  EXECUTE format(
    'CREATE POLICY archestra_update_all ON %s
      FOR UPDATE USING (true) WITH CHECK (true)',
    qualified_table
  );

  EXECUTE format(
    'DROP POLICY IF EXISTS archestra_delete_all ON %s',
    qualified_table
  );
  EXECUTE format(
    'CREATE POLICY archestra_delete_all ON %s
      FOR DELETE USING (true)',
    qualified_table
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$
DECLARE
  table_record record;
BEGIN
  FOR table_record IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT LIKE 'drizzle_%'
      AND tablename <> 'keyv_cache'
  LOOP
    PERFORM archestra_install_soft_delete(
      table_record.schemaname,
      table_record.tablename
    );
  END LOOP;
END
$$;--> statement-breakpoint
DROP FUNCTION archestra_install_soft_delete(text, text);--> statement-breakpoint
CREATE OR REPLACE FUNCTION archestra_restore_soft_deleted(
  target_table regclass,
  target_id text
) RETURNS boolean AS $$
DECLARE
  restored_count integer;
BEGIN
  EXECUTE format(
    'UPDATE %s
      SET deleted_at = NULL
      WHERE id::text = $1
        AND deleted_at IS NOT NULL',
    target_table
  )
  USING target_id;

  GET DIAGNOSTICS restored_count = ROW_COUNT;
  RETURN restored_count > 0;
END;
$$ LANGUAGE plpgsql;
