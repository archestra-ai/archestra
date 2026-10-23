import { createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

const SelectAgentRunAttentionNoticeSchema = createSelectSchema(
  schema.agentRunAttentionNoticesTable,
);
export type AgentRunAttentionNotice = z.infer<
  typeof SelectAgentRunAttentionNoticeSchema
>;
