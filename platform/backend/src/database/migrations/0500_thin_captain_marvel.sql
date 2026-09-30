CREATE TABLE "openappa_withheld_arrivals" (
	"organization_id" text NOT NULL,
	"caller_id" text,
	"session_id" text NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openappa_withheld_arrivals_pk" PRIMARY KEY("organization_id","session_id","digest")
);
