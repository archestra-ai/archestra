UPDATE internal_mcp_catalog
SET icon = 'logo:playwright'
WHERE id = '00000000-0000-4000-8000-000000000002'
  AND icon IS NULL;
