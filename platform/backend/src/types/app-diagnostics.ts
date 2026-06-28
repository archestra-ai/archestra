import { z } from "zod";

/**
 * A single render-loop diagnostic from an owned MCP App: a runtime error or CSP
 * violation captured inside the (untrusted) sandbox iframe. Mirrors the chat
 * attachment shape (shared/chat.ts) and the frontend store. Kept in a leaf
 * module (no `@/database` import) so the Drizzle schema can reference the type
 * without a schema↔types cycle.
 */
export const AppRenderDiagnosticEntrySchema = z.object({
  type: z.string().max(32),
  message: z.string().max(1000),
});
export type AppRenderDiagnosticEntry = z.infer<
  typeof AppRenderDiagnosticEntrySchema
>;

/** Per-app entry cap and per-message truncation, shared store/read side. */
export const APP_RENDER_DIAGNOSTICS_MAX_ENTRIES = 20;
export const APP_RENDER_DIAGNOSTIC_MESSAGE_MAX_LENGTH = 500;

/** What `get_app_diagnostics` reports for the calling user's latest render. */
export type AppRenderStatus = "no_render_observed" | "clean" | "errors";
