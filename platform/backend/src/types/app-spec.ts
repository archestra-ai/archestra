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
    summary: z.string().describe("One-line summary of what the app is for."),
    features: z
      .array(z.string())
      .describe("Concrete capabilities the app should provide."),
    data: z
      .string()
      .nullable()
      .optional()
      .describe(
        "What the app reads/persists via the App Data Store — a free-form prose string, not a structured object.",
      ),
    ui: z
      .string()
      .nullable()
      .optional()
      .describe(
        "UI / style direction as a free-form prose string, not a structured object.",
      ),
    tools: z
      .array(z.string())
      .describe(
        "Full names of the MCP tools the app calls through window.archestra.",
      ),
  })
  .strict();

export type AppSpec = z.infer<typeof AppSpecSchema>;
