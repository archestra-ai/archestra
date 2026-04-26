CREATE TABLE "chatops_approval_request" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token"               varchar(128) NOT NULL UNIQUE,
  "provider"            varchar(32) NOT NULL,
  "channel_id"          varchar(256) NOT NULL,
  "workspace_id"        varchar(256),
  "thread_id"           varchar(256),
  "approval_message_ts" varchar(64),
  "agent_id"            uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "user_id"             text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "tool_name"           varchar(512) NOT NULL,
  "tool_args"           jsonb NOT NULL,
  "execution_context"   jsonb NOT NULL,
  "original_message"    jsonb NOT NULL,
  "status"              varchar(32) DEFAULT 'pending' NOT NULL,
  "created_at"          timestamp DEFAULT now() NOT NULL,
  "expires_at"          timestamp NOT NULL,
  "resolved_at"         timestamp
);

CREATE INDEX "chatops_approval_request_token_idx"      ON "chatops_approval_request" ("token");
CREATE INDEX "chatops_approval_request_status_idx"     ON "chatops_approval_request" ("status");
CREATE INDEX "chatops_approval_request_expires_at_idx" ON "chatops_approval_request" ("expires_at");
CREATE INDEX "chatops_approval_request_agent_id_idx"   ON "chatops_approval_request" ("agent_id");
