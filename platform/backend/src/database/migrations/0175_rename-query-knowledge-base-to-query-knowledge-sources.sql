-- Rename legacy tool: query_knowledge_base → query_knowledge_sources
UPDATE "tools"
SET "name" = 'archestra__query_knowledge_sources'
WHERE "name" = 'archestra__query_knowledge_base';
