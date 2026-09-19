CREATE TABLE "openappa_context_anchors" (
	"organization_id" text NOT NULL,
	"caller_id" text NOT NULL,
	"digest" text NOT NULL,
	"session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openappa_context_anchors_pk" PRIMARY KEY("organization_id","caller_id","digest","session_id")
);
