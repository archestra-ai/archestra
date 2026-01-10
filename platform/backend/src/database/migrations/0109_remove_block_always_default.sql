DELETE FROM "trusted_data_policies"
WHERE "action" = 'block_always'
  AND ("conditions" = '[]'::jsonb OR "conditions"::text = '[]');
