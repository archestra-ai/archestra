CREATE TABLE "openappa_dispatch_leases" (
	"root" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"event_seq" bigint NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "openappa_dispatch_leases_attempt" CHECK ("openappa_dispatch_leases"."attempt" >= 1)
);
