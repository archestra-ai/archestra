CREATE TABLE "openappa_rewrite_groups" (
	"organization_id" text NOT NULL,
	"group_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"protocol_version" integer NOT NULL,
	"status" text NOT NULL,
	"idle_ttl_ms" integer NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"touched_at" timestamp (3) with time zone NOT NULL,
	"expired_at" timestamp (3) with time zone,
	"payload_swept_at" timestamp (3) with time zone,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"byte_count" integer DEFAULT 0 NOT NULL,
	"max_entries" integer NOT NULL,
	"max_bytes" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openappa_rewrite_groups_organization_id_group_id_pk" PRIMARY KEY("organization_id","group_id"),
	CONSTRAINT "openappa_rewrite_groups_status_chk" CHECK ("openappa_rewrite_groups"."status" in ('live', 'expired')),
	CONSTRAINT "openappa_rewrite_groups_epoch_chk" CHECK ("openappa_rewrite_groups"."epoch" >= 1),
	CONSTRAINT "openappa_rewrite_groups_ttl_chk" CHECK ("openappa_rewrite_groups"."idle_ttl_ms" >= 1 AND "openappa_rewrite_groups"."protocol_version" >= 1),
	CONSTRAINT "openappa_rewrite_groups_counts_chk" CHECK ("openappa_rewrite_groups"."entry_count" >= 0 AND "openappa_rewrite_groups"."byte_count" >= 0 AND "openappa_rewrite_groups"."max_entries" >= 1 AND "openappa_rewrite_groups"."max_bytes" >= 1)
);
--> statement-breakpoint
CREATE TABLE "openappa_rewrite_heads" (
	"organization_id" text NOT NULL,
	"group_id" text NOT NULL,
	"session_id" text NOT NULL,
	"wire" text NOT NULL,
	"revision" integer NOT NULL,
	"state" "bytea" NOT NULL,
	"state_digest" text NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "openappa_rewrite_heads_organization_id_group_id_session_id_wire_pk" PRIMARY KEY("organization_id","group_id","session_id","wire"),
	CONSTRAINT "openappa_rewrite_heads_revision_chk" CHECK ("openappa_rewrite_heads"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "openappa_rewrite_pairs" (
	"organization_id" text NOT NULL,
	"group_id" text NOT NULL,
	"session_id" text NOT NULL,
	"fragment_key" text NOT NULL,
	"original" "bytea" NOT NULL,
	"original_digest" text NOT NULL,
	"rewritten" "bytea" NOT NULL,
	"rewritten_digest" text NOT NULL,
	"byte_len" integer NOT NULL,
	"reservation_id" text,
	"reserved_bytes" integer DEFAULT 0 NOT NULL,
	"reservation_expires_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openappa_rewrite_pairs_organization_id_group_id_session_id_fragment_key_pk" PRIMARY KEY("organization_id","group_id","session_id","fragment_key"),
	CONSTRAINT "openappa_rewrite_pairs_len_chk" CHECK ("openappa_rewrite_pairs"."byte_len" >= 0),
	CONSTRAINT "openappa_rewrite_pairs_reservation_chk" CHECK ("openappa_rewrite_pairs"."reserved_bytes" >= 0 AND (
        ("openappa_rewrite_pairs"."reservation_expires_at" IS NULL AND "openappa_rewrite_pairs"."reserved_bytes" = 0)
        OR ("openappa_rewrite_pairs"."reservation_expires_at" IS NOT NULL AND "openappa_rewrite_pairs"."reservation_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "openappa_rewrite_roots" (
	"organization_id" text NOT NULL,
	"native_root" text NOT NULL,
	"group_id" text NOT NULL,
	CONSTRAINT "openappa_rewrite_roots_organization_id_native_root_pk" PRIMARY KEY("organization_id","native_root")
);
--> statement-breakpoint
CREATE INDEX "openappa_rewrite_groups_expiry_idx" ON "openappa_rewrite_groups" USING btree ("expires_at") WHERE "openappa_rewrite_groups"."status" = 'live';--> statement-breakpoint
CREATE INDEX "openappa_rewrite_groups_unswept_idx" ON "openappa_rewrite_groups" USING btree ("expired_at") WHERE "openappa_rewrite_groups"."status" = 'expired' AND "openappa_rewrite_groups"."payload_swept_at" IS NULL;--> statement-breakpoint
CREATE INDEX "openappa_rewrite_pairs_reservation_idx" ON "openappa_rewrite_pairs" USING btree ("organization_id","group_id","reservation_expires_at") WHERE "openappa_rewrite_pairs"."reservation_expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "openappa_rewrite_roots_group_idx" ON "openappa_rewrite_roots" USING btree ("organization_id","group_id");