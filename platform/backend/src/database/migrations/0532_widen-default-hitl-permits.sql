-- Widen the starting policy's human reviewer for organizations whose latest
-- revision still carries the unedited default block. A GitHub-synced policy
-- belongs to its repository and is left alone. Each write takes the same
-- advisory lock and re-reads under it, as every application policy write does.
DO $migration$
DECLARE
  old_block constant text := $old$# Review one exact call that explicitly requires human approval.
[[policy.authority]]
name = "hitl"
hint = "Ask the person running this session to approve this exact call."

[policy.authority.permits]
attention = ["human-approval"]
$old$;
  new_block constant text := $new$# Review one exact call for any attention mark, trust or audience gap.
[[policy.authority]]
name = "hitl"
hint = "Ask the person running this session to approve this exact call."

[policy.authority.permits]
trust_below = "trusted"
audience_missing = ["public"]
attention = ["*"]
$new$;
  candidate record;
  latest record;
  widened text;
BEGIN
  FOR candidate IN
    SELECT DISTINCT revision.organization_id
    FROM guardrails_policy_revisions AS revision
    WHERE strpos(revision.content, old_block) > 0
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('guardrails-policy:' || candidate.organization_id, 0)
    );
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM openappa_github_sync AS sync
      WHERE sync.organization_id = candidate.organization_id
        AND sync."interval" IS NOT NULL
    );
    SELECT revision.revision, revision.content INTO latest
    FROM guardrails_policy_revisions AS revision
    WHERE revision.organization_id = candidate.organization_id
    ORDER BY revision.revision DESC
    LIMIT 1;
    CONTINUE WHEN length(latest.content) - length(replace(latest.content, old_block, ''))
      <> length(old_block);
    widened := replace(latest.content, old_block, new_block);
    INSERT INTO guardrails_policy_revisions
      (organization_id, revision, content, content_hash, updated_by)
    VALUES (
      candidate.organization_id,
      latest.revision + 1,
      widened,
      encode(sha256(convert_to(widened, 'UTF8')), 'hex'),
      NULL
    );
  END LOOP;
END
$migration$;
