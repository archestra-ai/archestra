import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { openappaExternalConsultsTable } from "@/database/schemas/openappa";

// The runtime's own serde names, as `openappa-rs/src/consults.rs` stores them.
export const ExternalConsultRoleSchema = z.enum([
  "authority",
  "sanitizer",
  "annotator",
  "audience_source",
  "input",
]);
export type ExternalConsultRole = z.infer<typeof ExternalConsultRoleSchema>;

export const ExternalConsultBackendSchema = z.enum([
  "url",
  "command",
  "module",
  "llm",
  "jev",
  "claude_code",
  "hitl",
]);
export type ExternalConsultBackend = z.infer<
  typeof ExternalConsultBackendSchema
>;

/** `answered`, or the class of a no-answer. */
export const ExternalConsultOutcomeSchema = z.enum([
  "answered",
  "unregistered",
  "unreachable",
  "dismissed",
  "non_success",
  "timeout",
  "transport",
  "malformed",
  "oversized",
  "unsupported_version",
  "module_error",
  "module_panicked",
]);
export type ExternalConsultOutcome = z.infer<
  typeof ExternalConsultOutcomeSchema
>;

export type ExternalConsult = typeof openappaExternalConsultsTable.$inferSelect;

/** A stored consult as the export serves it: byte columns as base64. */
export const ExternalConsultSchema = createSelectSchema(
  openappaExternalConsultsTable,
  {
    role: ExternalConsultRoleSchema,
    backend: ExternalConsultBackendSchema,
    outcome: ExternalConsultOutcomeSchema,
    request: z.unknown(),
    answer: z.unknown().nullable(),
    rawResponse: z.base64().nullable(),
    diagnostics: z.base64().nullable(),
  },
);
export type ExternalConsultExport = z.infer<typeof ExternalConsultSchema>;
