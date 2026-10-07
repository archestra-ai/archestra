-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The foreign keys and index target the empty table created in this migration, so no existing rows are checked and no existing writer waits on them.
CREATE TABLE "openappa_yell_conversations" (
	"yell_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openappa_yell_conversations_yell_id_conversation_id_pk" PRIMARY KEY("yell_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "openappa_yell_conversations" ADD CONSTRAINT "openappa_yell_conversations_yell_id_openappa_yells_id_fk" FOREIGN KEY ("yell_id") REFERENCES "public"."openappa_yells"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openappa_yell_conversations" ADD CONSTRAINT "openappa_yell_conversations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "openappa_yell_conversations_conversation_id_idx" ON "openappa_yell_conversations" USING btree ("conversation_id");