-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=All constraints and indexes target the empty tables created in this migration. No existing application rows need deduplication or validation.
CREATE TABLE "openappa_embedded_peer_messages" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "openappa_embedded_peer_messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text NOT NULL,
	"root" text NOT NULL,
	"sender" text NOT NULL,
	"recipient" text NOT NULL,
	"pending_spawn" text,
	"dispatch" text NOT NULL,
	"digest" text NOT NULL,
	"label" jsonb NOT NULL,
	"body" text,
	"status" text NOT NULL,
	"read_call_id" text,
	"read_arguments" text,
	"decision" jsonb,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "openappa_embedded_peer_messages_id_unique" UNIQUE("id"),
	CONSTRAINT "openappa_embedded_peer_status" CHECK ("openappa_embedded_peer_messages"."status" IN ('held', 'direct', 'read'))
);
--> statement-breakpoint
CREATE TABLE "openappa_held_peer_messages" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "openappa_held_peer_messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text NOT NULL,
	"receiver" text NOT NULL,
	"digest" text NOT NULL,
	"label" jsonb NOT NULL,
	"body" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"notified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "openappa_held_peer_messages_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "openappa_embedded_peer_dispatch_uidx" ON "openappa_embedded_peer_messages" USING btree ("root","sender","dispatch");--> statement-breakpoint
CREATE INDEX "openappa_embedded_peer_recipient_idx" ON "openappa_embedded_peer_messages" USING btree ("root","recipient","status");--> statement-breakpoint
CREATE UNIQUE INDEX "openappa_embedded_peer_read_call_uidx" ON "openappa_embedded_peer_messages" USING btree ("root","recipient","read_call_id") WHERE "openappa_embedded_peer_messages"."read_call_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "openappa_held_peer_messages_receiver_idx" ON "openappa_held_peer_messages" USING btree ("receiver","seq");
