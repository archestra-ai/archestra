-- drizzle-migration-linter: reason=Both tables are brand-new and empty in this migration. Their cascade foreign keys express ownership by the Agent run, and the constraints are added NOT VALID and validated separately.
CREATE TABLE "agent_run_transcript_chunks" (
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"uncompressed_bytes" integer NOT NULL,
	"compressed_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "agent_run_transcript_chunks_pk" PRIMARY KEY("run_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "agent_run_transcripts" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"uncompressed_bytes" integer NOT NULL,
	"compressed_bytes" integer NOT NULL,
	"chunk_count" integer NOT NULL,
	"is_complete" boolean NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_transcript_chunks" ADD CONSTRAINT "agent_run_transcript_chunks_run_id_agent_run_transcripts_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run_transcripts"("run_id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_run_transcript_chunks" VALIDATE CONSTRAINT "agent_run_transcript_chunks_run_id_agent_run_transcripts_run_id_fk";--> statement-breakpoint
ALTER TABLE "agent_run_transcripts" ADD CONSTRAINT "agent_run_transcripts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_run_transcripts" VALIDATE CONSTRAINT "agent_run_transcripts_run_id_agent_runs_id_fk";
