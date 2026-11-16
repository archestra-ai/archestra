CREATE TABLE "sites" (
	"name" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"internal_url" text,
	"version" text NOT NULL,
	"capabilities" jsonb DEFAULT '{"keylessProviders":[]}'::jsonb NOT NULL,
	"draining" boolean DEFAULT false NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL
);
