-- Rename default profile from 'Default Agent' or 'Default Agent with Archestra' to 'Default Profile'
UPDATE "agents" 
SET "name" = 'Default Profile' 
WHERE "is_default" = true 
  AND ("name" = 'Default Agent' OR "name" = 'Default Agent with Archestra');
