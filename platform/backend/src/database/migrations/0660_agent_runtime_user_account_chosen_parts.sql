-- Each column and the check are added only where the catalog has none of its name, and the check is validated only while it is not. A release/1.4 database adds them with these same statements in its one-time startup upgrade, and what exists needs no table ownership: the migration may run as another database user than the one that created the table. A constant default adds a column without rewriting the table. Where a column is added, the rows saved before it record the id they store as picked, so a connection or model deleted later still stops their runs; what anyone runs on does not change.
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_attribute
  WHERE attrelid = 'public.agent_runtime_user_accounts'::regclass
   AND attname = 'llm_api_key_chosen'
   AND NOT attisdropped
 ) THEN
  ALTER TABLE "agent_runtime_user_accounts" ADD COLUMN "llm_api_key_chosen" boolean DEFAULT false NOT NULL;
  UPDATE "agent_runtime_user_accounts" SET "llm_api_key_chosen" = true WHERE "llm_api_key_id" IS NOT NULL;
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
  UPDATE "agent_runtime_user_accounts" SET "model_chosen" = true WHERE "model_id" IS NOT NULL;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid = 'public.agent_runtime_user_accounts'::regclass
   AND conname = 'agent_runtime_user_accounts_chosen_check'
 ) THEN
  ALTER TABLE "agent_runtime_user_accounts" ADD CONSTRAINT "agent_runtime_user_accounts_chosen_check" CHECK (("agent_runtime_user_accounts"."llm_api_key_id" is null or "agent_runtime_user_accounts"."llm_api_key_chosen") and ("agent_runtime_user_accounts"."model_id" is null or "agent_runtime_user_accounts"."model_chosen")) NOT VALID;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid = 'public.agent_runtime_user_accounts'::regclass
   AND conname = 'agent_runtime_user_accounts_chosen_check'
   AND NOT convalidated
 ) THEN
  ALTER TABLE "agent_runtime_user_accounts" VALIDATE CONSTRAINT "agent_runtime_user_accounts_chosen_check";
 END IF;
END $$;
