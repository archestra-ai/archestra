CREATE TABLE "tool_search_texts" (
	"definition_hash" text PRIMARY KEY NOT NULL,
	"search_text" text,
	"status" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"generator" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
