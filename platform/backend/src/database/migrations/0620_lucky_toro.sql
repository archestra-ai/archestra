ALTER TABLE "guardrails_deployment" ALTER COLUMN "human_approval_mode" SET DEFAULT 'block';--> statement-breakpoint
-- Break the glass keeps the pre-feature behaviour unless an administrator
-- opts in. 0619 added this column with the default "unattended", which every
-- existing row took on upgrade. No release shipped 0619, so a stored
-- "unattended" is that default, not a choice: restore the review.
UPDATE "guardrails_deployment" SET "human_approval_mode" = 'block' WHERE "human_approval_mode" = 'unattended';
