CREATE TABLE "tool_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "name" varchar(255) NOT NULL,
  "tool_id" uuid NOT NULL,
  "organization_id" text NOT NULL,
  "allow_usage_when_untrusted_data_is_present" boolean NOT NULL DEFAULT false,
  "tool_result_treatment" varchar(50) NOT NULL DEFAULT 'untrusted',
  "response_modifier_template" text,
  CONSTRAINT "tool_policies_name_unique" UNIQUE("name"),
  CONSTRAINT "tool_policies_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE CASCADE,
  CONSTRAINT "tool_policies_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE
);

ALTER TABLE "agent_tools" ADD COLUMN "tool_policy_id" uuid;
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_tool_policy_id_tool_policies_id_fk" FOREIGN KEY ("tool_policy_id") REFERENCES "tool_policies"("id") ON DELETE SET NULL;
