/**
 * The statements that create the table of each person's Agent Runtime account
 * choice: the bytes of migration 0659_agent_runtime_user_accounts on main,
 * where version 1.5 creates the table. This branch takes no migration, so a
 * one-time startup upgrade runs these statements instead; 0659 then finds the
 * table and creates nothing. Change neither copy alone.
 *
 * @public — the test database creates the table from this text, as the
 * migrations would on main.
 */
export const AGENT_RUNTIME_USER_ACCOUNTS_SQL = `-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Every constraint and index here targets agent_runtime_user_accounts, a table created empty in this same migration (mirrors agent_pins): validating the foreign keys scans no existing rows, and CONCURRENTLY is unnecessary on a brand-new empty table. Each ADD CONSTRAINT ... FOREIGN KEY takes a SHARE ROW EXCLUSIVE lock on its referenced table (agents, user, chat_api_keys and models), and those four locks are held until the transaction that runs this migration batch commits: writes to those tables wait for the rest of the batch, not for this DDL alone. ON DELETE cascade on agent_id and user_id is intentional because a person's account choice is meaningless without its agent or its user; llm_api_key_id and model_id are ON DELETE SET NULL so a removed connection or model keeps the row: the person stays on the account they chose, and their runs are refused until they choose again instead of being moved silently to another connection or model. No existing row is read or changed: what agents and runtimes already store keeps its meaning. Every statement is idempotent: a release/1.4 database creates the same table with these same statements in a one-time startup upgrade, so this migration creates only what is missing there. A foreign key or an index is created only where the catalog has none of its name, so one that exists needs no table ownership: the migration may run as another database user than the one that created the table.
CREATE TABLE IF NOT EXISTS "agent_runtime_user_accounts" (
	"agent_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"authentication" text NOT NULL,
	"llm_api_key_id" uuid,
	"model_id" uuid,
	"claude_model" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runtime_user_accounts_agent_id_user_id_pk" PRIMARY KEY("agent_id","user_id"),
	CONSTRAINT "agent_runtime_user_accounts_authentication_check" CHECK ("agent_runtime_user_accounts"."authentication" in ('provider', 'subscription'))
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid = 'public.agent_runtime_user_accounts'::regclass
   AND conname = 'agent_runtime_user_accounts_agent_id_agents_id_fk'
 ) THEN
  ALTER TABLE "agent_runtime_user_accounts" ADD CONSTRAINT "agent_runtime_user_accounts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid = 'public.agent_runtime_user_accounts'::regclass
   AND conname = 'agent_runtime_user_accounts_user_id_user_id_fk'
 ) THEN
  ALTER TABLE "agent_runtime_user_accounts" ADD CONSTRAINT "agent_runtime_user_accounts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid = 'public.agent_runtime_user_accounts'::regclass
   AND conname = 'agent_runtime_user_accounts_llm_api_key_id_chat_api_keys_id_fk'
 ) THEN
  ALTER TABLE "agent_runtime_user_accounts" ADD CONSTRAINT "agent_runtime_user_accounts_llm_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("llm_api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid = 'public.agent_runtime_user_accounts'::regclass
   AND conname = 'agent_runtime_user_accounts_model_id_models_id_fk'
 ) THEN
  ALTER TABLE "agent_runtime_user_accounts" ADD CONSTRAINT "agent_runtime_user_accounts_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF to_regclass('public.agent_runtime_user_accounts_user_id_idx') IS NULL THEN
  CREATE INDEX "agent_runtime_user_accounts_user_id_idx" ON "agent_runtime_user_accounts" USING btree ("user_id");
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF to_regclass('public.agent_runtime_user_accounts_llm_api_key_id_idx') IS NULL THEN
  CREATE INDEX "agent_runtime_user_accounts_llm_api_key_id_idx" ON "agent_runtime_user_accounts" USING btree ("llm_api_key_id");
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF to_regclass('public.agent_runtime_user_accounts_model_id_idx') IS NULL THEN
  CREATE INDEX "agent_runtime_user_accounts_model_id_idx" ON "agent_runtime_user_accounts" USING btree ("model_id");
 END IF;
END $$;
`;

/** The statements of AGENT_RUNTIME_USER_ACCOUNTS_SQL, in order. */
export const AGENT_RUNTIME_USER_ACCOUNTS_STATEMENTS =
  AGENT_RUNTIME_USER_ACCOUNTS_SQL.split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
