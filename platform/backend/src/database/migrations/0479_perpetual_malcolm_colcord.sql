CREATE TABLE "openappa_host_keys" (
	"key" text NOT NULL,
	"root" text NOT NULL,
	CONSTRAINT "openappa_host_keys_key_root_pk" PRIMARY KEY("key","root")
);
--> statement-breakpoint
CREATE TABLE "openappa_offer_owners" (
	"organization_id" text NOT NULL,
	"caller_id" text,
	"session_id" text NOT NULL,
	"binding" text NOT NULL,
	"offer_id" text NOT NULL,
	"root" text NOT NULL,
	"parent_id" text,
	"arguments" text,
	"tool" text,
	"spelling" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openappa_offer_owners_pk" PRIMARY KEY("organization_id","offer_id")
);
--> statement-breakpoint
CREATE INDEX "openappa_host_keys_root_idx" ON "openappa_host_keys" USING btree ("root");--> statement-breakpoint
CREATE INDEX "openappa_offer_owners_session_idx" ON "openappa_offer_owners" USING btree ("organization_id","session_id","caller_id");--> statement-breakpoint
CREATE INDEX "openappa_offer_owners_root_idx" ON "openappa_offer_owners" USING btree ("root");--> statement-breakpoint
CREATE INDEX "openappa_offer_owners_created_at_idx" ON "openappa_offer_owners" USING btree ("created_at");
