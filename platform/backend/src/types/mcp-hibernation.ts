import { z } from "zod";

/**
 * Per-install idle-hibernation override. "inherit" follows the organization's
 * toggle; "disabled" keeps this install (and every multitenant sibling sharing
 * its deployment) awake even while the organization has hibernation on;
 * "enabled" is an explicit opt-in that currently resolves identically to
 * "inherit" — kept as a distinct value so an install can pin its intent ahead
 * of any future default flip, never as a way to escape an org-level off.
 *
 * Lives in its own module because both the mcp-server and mcp-catalog type
 * modules need it, and those two already import each other — a definition in
 * either would evaluate as undefined on one side of the cycle.
 */
export const McpServerHibernationModeSchema = z.enum([
  "inherit",
  "enabled",
  "disabled",
]);

export type McpServerHibernationMode = z.infer<
  typeof McpServerHibernationModeSchema
>;
