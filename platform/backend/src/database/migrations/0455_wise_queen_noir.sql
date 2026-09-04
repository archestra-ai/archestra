CREATE TABLE "agent_run_readable_transcript_chunks" (
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"uncompressed_bytes" integer NOT NULL,
	"compressed_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "agent_run_readable_transcript_chunks_pk" PRIMARY KEY("run_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "agent_run_readable_transcripts" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"version" integer NOT NULL,
	"uncompressed_bytes" integer NOT NULL,
	"compressed_bytes" integer NOT NULL,
	"chunk_count" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_readable_transcript_chunks" ADD CONSTRAINT "agent_run_readable_transcript_chunks_run_id_agent_run_readable_transcripts_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run_readable_transcripts"("run_id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_run_readable_transcript_chunks" VALIDATE CONSTRAINT "agent_run_readable_transcript_chunks_run_id_agent_run_readable_transcripts_run_id_fk";--> statement-breakpoint
ALTER TABLE "agent_run_readable_transcripts" ADD CONSTRAINT "agent_run_readable_transcripts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_run_readable_transcripts" VALIDATE CONSTRAINT "agent_run_readable_transcripts_run_id_agent_runs_id_fk";
