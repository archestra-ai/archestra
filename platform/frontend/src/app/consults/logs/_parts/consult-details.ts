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
  diagnostics: ConsultDiagnostics;
  rawResponse: string | null;
};

export function toConsultView(consult: ExternalConsult): ConsultView {
  return {
    consult,
    toolCall: toolCallOf(consult.request),
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
const ToolCallRequestSchema = z.object({
  artifact: z.object({
    args: z.object({ name: z.string(), arguments: z.unknown() }),
  }),
});

function toolCallOf(request: unknown): ConsultToolCall | null {
  const parsed = ToolCallRequestSchema.safeParse(request);
  return parsed.success ? parsed.data.artifact.args : null;
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
