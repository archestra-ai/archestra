ALTER TABLE "agents" ADD COLUMN "slug" text;

-- Populate slugs for existing mcp_gateway agents: lowercase, strip non-alnum to hyphens, trim
UPDATE agents SET slug = trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'))
WHERE agent_type = 'mcp_gateway';

-- Fix any that ended up empty (symbol-only names)
UPDATE agents SET slug = 'gateway' WHERE agent_type = 'mcp_gateway' AND (slug IS NULL OR slug = '');

-- Deduplicate: append short random suffix to collisions (keep oldest row as-is)
WITH ranked AS (
  SELECT id, slug, ROW_NUMBER() OVER (PARTITION BY slug ORDER BY created_at) AS rn
  FROM agents
  WHERE slug IS NOT NULL
)
UPDATE agents SET slug = agents.slug || '-' || substr(gen_random_uuid()::text, 1, 6)
FROM ranked
WHERE agents.id = ranked.id AND ranked.rn > 1;

--> statement-breakpoint
CREATE UNIQUE INDEX "agents_slug_idx" ON "agents" USING btree ("slug") WHERE "agents"."slug" IS NOT NULL;