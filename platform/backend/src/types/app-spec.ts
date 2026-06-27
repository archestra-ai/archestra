import { z } from "zod";

/**
 * Consolidated, model-authored requirements for an MCP App, produced by the
 * refine step. Stored on the app row (mutable head, updated by re-refining) and
 * snapshotted onto the version an html build forks from, tying "what runs" to
 * "what it was built from". Grounds scaffolding/building in the user's real,
 * assigned MCP tools rather than hallucinated ones.
 *
 * Kept in its own module (no `@/database` import) so the schema files can
 * `$type` their jsonb columns against it without a cycle.
 */
export const AppSpecSchema = z
  .object({
    /** One-line summary of what the app is for. */
    summary: z.string(),
    /** Concrete capabilities the app should provide. */
    features: z.array(z.string()),
    /** What the app reads/persists via the App Data Store (free-form). */
    data: z.string().nullable().optional(),
    /** UI / style direction (free-form). */
    ui: z.string().nullable().optional(),
    /** Full names of the MCP tools the app calls through `window.archestra`. */
    tools: z.array(z.string()),
  })
  .strict();

export type AppSpec = z.infer<typeof AppSpecSchema>;
