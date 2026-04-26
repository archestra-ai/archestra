CREATE TYPE "public"."memory_scope_type" AS ENUM('user', 'team', 'org');

CREATE TABLE "agent_memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scope_type" "memory_scope_type" NOT NULL,
  "scope_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "key" text NOT NULL,
  "value" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX "agent_memories_scope_idx" ON "agent_memories" ("organization_id", "scope_type", "scope_id");
CREATE UNIQUE INDEX "agent_memories_unique_key_idx" ON "agent_memories" ("organization_id", "scope_type", "scope_id", "key");
