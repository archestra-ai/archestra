-- Retire the action without granting new delete authority. Preserve resource
-- keys, empty arrays, every other action, and the original action ordering.
UPDATE "organization_role" AS role
SET "permission" = (
  SELECT jsonb_object_agg(resource.key, COALESCE((
    SELECT jsonb_agg(action.value ORDER BY action.position)
    FROM jsonb_array_elements(resource.value) WITH ORDINALITY AS action(value, position)
    WHERE action.value <> '"manage-deleted"'::jsonb
  ), '[]'::jsonb))::text
  FROM jsonb_each(role."permission"::jsonb) AS resource
)
WHERE EXISTS (
  SELECT 1
  FROM jsonb_each(role."permission"::jsonb) AS resource
  WHERE resource.value @> '["manage-deleted"]'::jsonb
);
--> statement-breakpoint
-- Convert retired wildcard log grants back to role-based organization-wide
-- visibility. Do not add Read: endpoint access still requires the existing
-- read action, and a scoped grant alone did not satisfy that gate.
-- Custom role recipients regain Admin directly. Other recipients receive an
-- Admin-only supplementary role, preserving their existing role assignments.
-- Organization and predefined-role grants preserve current assignments; future
-- direct role assignments should use the explicit log Admin action.
DO $$
DECLARE
  policy_record record;
  grant_record jsonb;
  subject_type text;
  subject_id text;
  custom_role_id text;
  supplemental_role text;
BEGIN
  FOR policy_record IN
    SELECT organization_id, resource, grants
    FROM resource_permission_policies
    WHERE resource IN ('log', 'auditLog') AND scope = '*'
  LOOP
    FOR grant_record IN SELECT value FROM jsonb_array_elements(policy_record.grants)
    LOOP
      IF NOT (grant_record->'actions' ? 'read') THEN CONTINUE; END IF;
      subject_type := grant_record->'subject'->>'type';
      subject_id := grant_record->'subject'->>'id';
      IF subject_type = 'role' AND subject_id = 'admin' THEN CONTINUE; END IF;

      custom_role_id := NULL;
      IF subject_type = 'role' THEN
        SELECT id INTO custom_role_id FROM organization_role
        WHERE organization_id = policy_record.organization_id AND id = subject_id;
      END IF;
      IF custom_role_id IS NOT NULL THEN
        UPDATE organization_role SET
          permission = jsonb_set(permission::jsonb, ARRAY[policy_record.resource],
            COALESCE(permission::jsonb->policy_record.resource, '[]'::jsonb) || '["admin"]'::jsonb)::text,
          updated_at = now()
        WHERE id = custom_role_id
          AND NOT (COALESCE(permission::jsonb->policy_record.resource, '[]'::jsonb) ? 'admin');
        CONTINUE;
      END IF;

      supplemental_role := 'migrated_log_access_' || md5(policy_record.organization_id || ':' || policy_record.resource);
      INSERT INTO organization_role (id, organization_id, role, name, description, permission)
      VALUES (supplemental_role, policy_record.organization_id, supplemental_role,
        CASE policy_record.resource WHEN 'log' THEN 'Migrated LLM & MCP log access' ELSE 'Migrated audit log access' END,
        'Preserves existing organization-wide log visibility. Also requires the corresponding Read permission.',
        jsonb_build_object(policy_record.resource, jsonb_build_array('admin'))::text)
      ON CONFLICT (id) DO NOTHING;

      UPDATE member SET role = concat_ws(',', NULLIF(role, ''), supplemental_role)
      WHERE organization_id = policy_record.organization_id
        AND NOT (supplemental_role = ANY(string_to_array(role, ',')))
        AND (subject_type = 'organization'
          OR (subject_type = 'user' AND user_id = subject_id)
          OR (subject_type = 'role' AND subject_id = ANY(string_to_array(role, ','))));

      UPDATE team SET roles = array_append(roles, supplemental_role), updated_at = now()
      WHERE organization_id = policy_record.organization_id
        AND NOT (supplemental_role = ANY(roles))
        AND (subject_type = 'organization'
          OR (subject_type = 'team' AND id = subject_id)
          OR (subject_type = 'role' AND subject_id = ANY(roles)));

      UPDATE service_accounts SET role = concat_ws(',', NULLIF(role, ''), supplemental_role), updated_at = now()
      WHERE organization_id = policy_record.organization_id
        AND NOT (supplemental_role = ANY(string_to_array(role, ',')))
        AND (subject_type = 'organization'
          OR (subject_type = 'serviceAccount' AND id::text = subject_id)
          OR (subject_type = 'role' AND subject_id = ANY(string_to_array(role, ','))));
    END LOOP;
  END LOOP;
  DELETE FROM resource_permission_policies WHERE resource IN ('log', 'auditLog');
END $$;
