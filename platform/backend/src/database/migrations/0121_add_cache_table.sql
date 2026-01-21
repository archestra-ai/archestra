-- Cache table for distributed caching across multiple pods
-- Stores ephemeral data with TTL support (OAuth state, SSO groups, rate limits, etc.)
CREATE TABLE IF NOT EXISTS "cache" (
  "key" TEXT PRIMARY KEY,
  "value" JSONB NOT NULL,
  "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cache_expires_at_idx" ON "cache" ("expires_at");
