import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";
import {
  AgentRunActorKindSchema,
  AgentRuntimeBackendSchema,
  AgentWorkspaceStateSchema,
} from "./agent-runtime";

const selectSchema = createSelectSchema(schema.agentWorkspacesTable).extend({
  actorKind: AgentRunActorKindSchema,
  backend: AgentRuntimeBackendSchema,
  state: AgentWorkspaceStateSchema,
});
const insertSchema = createInsertSchema(schema.agentWorkspacesTable).extend({
  actorKind: AgentRunActorKindSchema,
  backend: AgentRuntimeBackendSchema,
  state: AgentWorkspaceStateSchema.optional(),
});
export type AgentWorkspace = z.infer<typeof selectSchema>;
export type InsertAgentWorkspace = z.infer<typeof insertSchema>;
