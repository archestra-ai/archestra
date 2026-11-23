-- Each column is added only where the catalog has none of its name. A release/1.4 database adds the same columns with these same statements in its one-time startup upgrade, and a column that exists needs no table ownership: the migration may run as another database user than the one that created the table. A constant default adds a column without rewriting the table, and no existing row is changed.
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_attribute
  WHERE attrelid = 'public.agent_runtime_user_accounts'::regclass
   AND attname = 'llm_api_key_chosen'
   AND NOT attisdropped
 ) THEN
  ALTER TABLE "agent_runtime_user_accounts" ADD COLUMN "llm_api_key_chosen" boolean DEFAULT false NOT NULL;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_attribute
  WHERE attrelid = 'public.agent_runtime_user_accounts'::regclass
   AND attname = 'model_chosen'
   AND NOT attisdropped
 ) THEN
  ALTER TABLE "agent_runtime_user_accounts" ADD COLUMN "model_chosen" boolean DEFAULT false NOT NULL;
 END IF;
END $$;
