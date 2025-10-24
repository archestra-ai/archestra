-- Mark existing "Default Agent with Archestra" as the default agent
UPDATE "agents" SET "is_default" = true WHERE "name" = 'Default Agent with Archestra';
