import { z } from "zod";
import { GuardrailsPolicyEditSchema } from "./guardrails-policy-proposal";

export const TunerKindSchema = z.enum(["sre", "appa"]);
export type TunerKind = z.infer<typeof TunerKindSchema>;

/** Ordered: a later entry outranks an earlier one when suppression is re-checked. */
export const TunerSeveritySchema = z.enum(["info", "warn", "critical"]);
export type TunerSeverity = z.infer<typeof TunerSeveritySchema>;

export const TunerSuggestionStatusSchema = z.enum([
  "open",
  "done",
  "rejected",
  "published",
  "effective",
  "resolved",
]);
export type TunerSuggestionStatus = z.infer<typeof TunerSuggestionStatusSchema>;

export const TunerCandidateSourceSchema = z.enum([
  "sre_oom_killed",
  "sre_restart_loop",
  "sre_pod_stuck",
  "sre_replicas_unavailable",
  "appa_hitl_approvals",
  "appa_hitl_denials",
  "appa_repeated_denials",
  "appa_unresolved_yell",
  "appa_observe_auto_approvals",
]);
export type TunerCandidateSource = z.infer<typeof TunerCandidateSourceSchema>;

/** Stable identity of one recurring issue; built only by candidate-source code. */
export const TunerFingerprintSchema = z
  .string()
  .min(1)
  .max(512)
  .brand<"TunerFingerprint">();
export type TunerFingerprint = z.infer<typeof TunerFingerprintSchema>;

export const K8sWorkloadKindSchema = z.enum([
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "Job",
  "CronJob",
]);
export type K8sWorkloadKind = z.infer<typeof K8sWorkloadKindSchema>;

export const TunerEvidenceRefSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("k8s_pod"),
    namespace: z.string(),
    name: z.string(),
  }),
  z.object({
    type: z.literal("k8s_workload"),
    namespace: z.string(),
    kind: K8sWorkloadKindSchema,
    name: z.string(),
  }),
  z.object({
    type: z.literal("openappa_operation"),
    sessionId: z.string(),
    operationId: z.string(),
  }),
  z.object({ type: z.literal("openappa_consult"), id: z.string().uuid() }),
  z.object({ type: z.literal("openappa_yell"), id: z.string().uuid() }),
]);
export type TunerEvidenceRef = z.infer<typeof TunerEvidenceRefSchema>;

export const TunerCandidateSchema = z.object({
  fingerprint: TunerFingerprintSchema,
  source: TunerCandidateSourceSchema,
  severity: TunerSeveritySchema,
  title: z.string(),
  /** What the source observed, in plain words; the agent reads it as data. */
  detail: z.string(),
  evidence: z.array(TunerEvidenceRefSchema),
});
export type TunerCandidate = z.infer<typeof TunerCandidateSchema>;

/**
 * A tuner's collected candidates. `complete` is false when a source hit its
 * read limit: candidates past it exist but are unknown.
 */
export type TunerCandidateScan = {
  candidates: TunerCandidate[];
  complete: boolean;
};

export const TunerRunOutcomeSchema = z.enum([
  "no_candidates",
  "all_suppressed",
  "agent_ran",
]);
export type TunerRunOutcome = z.infer<typeof TunerRunOutcomeSchema>;

/** Persisted on the schedule run; its presence is the run's scan claim. */
export const TunerRunRecordSchema = z.object({
  outcome: TunerRunOutcomeSchema,
  candidates: z.array(TunerCandidateSchema),
});
export type TunerRunRecord = z.infer<typeof TunerRunRecordSchema>;

export const TunerGateUnverifiedReasonSchema = z.enum([
  "no_saved_validations",
  "replay_unavailable",
  "validation_cannot_run",
]);
export type TunerGateUnverifiedReason = z.infer<
  typeof TunerGateUnverifiedReasonSchema
>;

export const TunerGateResultSchema = z.object({
  verification: z.enum(["verified", "unverified"]),
  reasons: z.array(TunerGateUnverifiedReasonSchema),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.enum(["passed", "cannot_run"]),
      error: z.string().nullable(),
    }),
  ),
  suiteVersion: z.string().nullable(),
});
export type TunerGateResult = z.infer<typeof TunerGateResultSchema>;

export const TunerPolicyPublicationSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  /** The Git sync repository the change request was opened in. */
  repo: z.string(),
});

export const TunerSuggestedActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("note") }),
  z.object({
    type: z.literal("policy_change"),
    expectedRevision: z.number().int().nonnegative(),
    edits: z.array(GuardrailsPolicyEditSchema).min(1).max(50),
    gate: TunerGateResultSchema,
    publication: TunerPolicyPublicationSchema.nullable(),
  }),
]);
export type TunerSuggestedAction = z.infer<typeof TunerSuggestedActionSchema>;

/** `<source>:<part>/<part>…`; parts identify the issue, never a moment in time. */
export function tunerFingerprint(
  source: TunerCandidateSource,
  ...parts: string[]
): TunerFingerprint {
  return TunerFingerprintSchema.parse(`${source}:${parts.join("/")}`);
}

export function severityRank(severity: TunerSeverity): number {
  return TunerSeveritySchema.options.indexOf(severity);
}
