-- Update conversations that use the decommissioned Groq model llama-3.1-70b-versatile
-- Replace with groq/compound which is the recommended replacement
UPDATE "conversations"
SET "selected_model" = 'groq/compound'
WHERE "selected_model" = 'llama-3.1-70b-versatile';
