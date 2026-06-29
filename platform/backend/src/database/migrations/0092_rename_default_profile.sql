-- Rename default profile from legacy names to 'Default Profile'
UPDATE "agents" 
SET "name" = 'Default Profile' 
WHERE "is_default" = true 
  AND "name" IN ('Default Agent', 'Default Agent with Archestra', 'Default Profile with Archestra');
