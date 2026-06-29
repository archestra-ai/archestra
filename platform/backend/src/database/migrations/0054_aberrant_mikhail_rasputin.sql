-- Remove all tools that start with 'archestra__'
-- We renamed some tools from agent -> profile, so need to remove tools and have them auto re-generated
DELETE FROM "tools" WHERE "name" LIKE 'archestra__%';
