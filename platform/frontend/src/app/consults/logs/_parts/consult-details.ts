import { z } from "zod";
import type { ExternalConsult } from "@/lib/openappa/external-consults.query";

export type JevChoiceLabel = z.infer<typeof ChoiceLabelSchema>;
export type JevCutoffLabel = z.infer<typeof CutoffLabelSchema>;
export type JevDiagnostics = z.infer<typeof JevDiagnosticsSchema>;

export type ConsultDiagnostics =
  | { kind: "none" }
  | { kind: "jev"; jev: JevDiagnostics }
  | { kind: "json"; value: unknown }
  | { kind: "text"; text: string };

export type ConsultToolCall = { name: string; arguments: unknown };

/** A consult with its opaque payloads decoded for display. */
export type ConsultView = {
  consult: ExternalConsult;
  toolCall: ConsultToolCall | null;
  /** What an authority was asked to approve; empty for any other consult. */
  requirements: unknown[];
  diagnostics: ConsultDiagnostics;
  rawResponse: string | null;
};

export function toConsultView(consult: ExternalConsult): ConsultView {
  return {
    consult,
    toolCall: toolCallOf(consult.request),
    requirements: requirementsOf(consult.request),
    diagnostics: decodeDiagnostics(consult.diagnostics),
    rawResponse: consult.rawResponse ? base64ToText(consult.rawResponse) : null,
  };
}

function decodeDiagnostics(base64: string | null): ConsultDiagnostics {
  if (base64 === null) return { kind: "none" };
  const text = base64ToText(base64);
  const json = parseJson(text);
  if (json === undefined) return { kind: "text", text };
  const jev = DiagnosticsLineSchema.safeParse(json);
  return jev.success
    ? { kind: "jev", jev: jev.data.jev_diagnostics }
    : { kind: "json", value: json };
}

// === Internal helpers ===

// Mirrors `appa-runtime/src/jev.rs` `DiagnosticsLine`. Jev may answer a label
// with junk probabilities, so values that are not numbers are dropped rather
// than failing the whole parse.
const ProbabilitiesSchema = z
  .record(z.string(), z.unknown())
  .transform((entries) =>
    Object.entries(entries).flatMap(([option, value]) =>
      typeof value === "number" ? [{ option, probability: value }] : [],
    ),
  )
  .catch([]);

const ChoiceLabelSchema = z.object({
  probabilities: ProbabilitiesSchema,
  decision: z.string().optional(),
});

const CutoffLabelSchema = z.object({
  probability: z.number().nullable().catch(null),
  threshold: z.number(),
  decision: z.boolean().optional(),
});

const JevDiagnosticsSchema = z.object({
  version: z.number(),
  model: z.string(),
  attempts: z.array(z.string()),
  labels: z.object({
    delta_audience: ChoiceLabelSchema.optional(),
    delta_trust: ChoiceLabelSchema.optional(),
    requires_audience: ChoiceLabelSchema.optional(),
    requires_trusted: CutoffLabelSchema.optional(),
  }),
  error: z.string().optional(),
  elapsed_ms: z.number(),
});

const DiagnosticsLineSchema = z.object({
  jev_diagnostics: JevDiagnosticsSchema,
});

// An annotation consult carries the proposed call as `artifact.args`.
const AnnotationRequestSchema = z.object({
  artifact: z.object({
    args: z.object({ name: z.string(), arguments: z.unknown() }),
  }),
});

// An authority consult carries the call it rules on as `artifact.tool` and
// `artifact.arguments`, beside the requirements it was asked to approve.
const AuthorityRequestSchema = z.object({
  artifact: z.object({
    tool: z.string(),
    arguments: z.unknown(),
    requirements: z.array(z.unknown()),
  }),
});

function toolCallOf(request: unknown): ConsultToolCall | null {
  const annotation = AnnotationRequestSchema.safeParse(request);
  if (annotation.success) {
    return annotation.data.artifact.args;
  }
  const authority = AuthorityRequestSchema.safeParse(request);
  return authority.success
    ? {
        name: authority.data.artifact.tool,
        arguments: authority.data.artifact.arguments,
      }
    : null;
}

function requirementsOf(request: unknown): unknown[] {
  const authority = AuthorityRequestSchema.safeParse(request);
  return authority.success ? authority.data.artifact.requirements : [];
}

function base64ToText(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
