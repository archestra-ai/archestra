CREATE TABLE "openappa_superyelled_sessions" (
	"organization_id" text NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openappa_superyelled_sessions_organization_id_session_id_pk" PRIMARY KEY("organization_id","session_id")
);
