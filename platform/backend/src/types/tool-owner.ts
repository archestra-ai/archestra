import { z } from "zod";
import type { ResourceVisibilityScope } from "./visibility";

/**
 * A tool attachment, an upstream MCP connection, and an audited tool call all
 * belong to an *owner*. Historically the only owner was an agent; apps are the
 * second owner type. `ToolOwner` is the discriminated handle threaded through
 * the execution path; `ToolOwnerContext` is the scope/membership the assignment
 * rules evaluate (identical shape for both owner types).
 */
export const ToolOwnerTypeSchema = z.enum(["agent", "app"]);
export type ToolOwnerType = z.infer<typeof ToolOwnerTypeSchema>;

export const ToolOwnerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent"), id: z.string().uuid() }),
  z.object({ type: z.literal("app"), id: z.string().uuid() }),
]);
export type ToolOwner = z.infer<typeof ToolOwnerSchema>;

export interface ToolOwnerContext {
  organizationId: string;
  scope: ResourceVisibilityScope;
  authorId: string | null;
  teamIds: string[];
}

/** Convenience constructors keep call sites readable. */
export const agentOwner = (id: string): ToolOwner => ({ type: "agent", id });
export const appOwner = (id: string): ToolOwner => ({ type: "app", id });
