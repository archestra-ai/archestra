-- Create roles table for custom organization roles
CREATE TABLE IF NOT EXISTS "role" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "description" text,
  "permissions" text[] NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- Create unique constraint on role name per organization
CREATE UNIQUE INDEX IF NOT EXISTS "role_org_id_name_unique" ON "role"("organization_id", "name");

-- Create user_role_assignment table for role assignments to users
CREATE TABLE IF NOT EXISTS "user_role_assignment" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "role_id" text NOT NULL REFERENCES "role"("id") ON DELETE cascade,
  "assigned_at" timestamp NOT NULL DEFAULT now()
);

-- Create composite unique constraint to prevent duplicate assignments
CREATE UNIQUE INDEX IF NOT EXISTS "user_role_assignment_user_id_role_id_unique" ON "user_role_assignment"("user_id", "role_id");

-- Create index for faster lookups by user_id
CREATE INDEX IF NOT EXISTS "user_role_assignment_user_id_idx" ON "user_role_assignment"("user_id");

-- Create index for faster lookups by role_id
CREATE INDEX IF NOT EXISTS "user_role_assignment_role_id_idx" ON "user_role_assignment"("role_id");
