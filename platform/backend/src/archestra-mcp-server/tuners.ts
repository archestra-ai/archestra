import { TOOL_PROPOSE_TUNER_SUGGESTION_SHORT_NAME } from "@archestra/shared";
import { z } from "zod";
import { TunerSuggestionModel } from "@/models";
import { hasTunerAccess } from "@/services/tuners/access";
import { checkPolicyChange } from "@/services/tuners/policy-gate";
import { findTunerRun } from "@/services/tuners/tuner-run";
import { GuardrailsPolicyEditSchema } from "@/types/guardrails-policy-proposal";
import type { TunerKind, TunerSuggestedAction } from "@/types/tuner";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";

const ProposeArgsSchema = z.strictObject({
  fingerprint: z
    .string()
    .describe("The fingerprint of one candidate listed in this run's message."),
  rationale: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      "Why this matters and what the admin should do, in a few sentences. Plain text.",
    ),
  policy_change: z
    .strictObject({
      expected_revision: z
        .number()
        .int()
        .nonnegative()
        .describe("The revision get_guardrails_policy returned."),
      edits: z
        .array(GuardrailsPolicyEditSchema)
        .min(1)
        .max(50)
        .describe(
          "Exact-text replacements applied in order to the current policy.",
        ),
    })
    .nullish()
    .describe(
      "Only for the APPA tuner: a guardrails policy change that resolves the candidate. Leave empty for a note.",
    ),
});

const ProposeOutputSchema = z.object({
  status: z.enum(["created", "suppressed"]),
  suggestionId: z.string().nullable(),
  verification: z.enum(["verified", "unverified"]).nullable(),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_PROPOSE_TUNER_SUGGESTION_SHORT_NAME,
    title: "Propose Tuner Suggestion",
    description:
      "File a suggestion for one candidate of this tuner run into the admin inbox. Each candidate takes at most one suggestion; an admin decides what happens to it.",
    schema: ProposeArgsSchema,
    outputSchema: ProposeOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
    async handler({ args, context }) {
      const run = await findTunerRun(context.scheduleTriggerRunId);
      if (
        !run ||
        run.status !== "running" ||
        run.organizationId !== context.organizationId ||
        run.agentId !== context.agent.id
      ) {
        return errorResult(
          "propose_tuner_suggestion works only inside this agent's own running tuner run.",
        );
      }
      // The user the run executes as; the trigger's actor may have moved since.
      const userId = context.userId;
      if (
        !userId ||
        !(await hasTunerAccess({
          userId,
          organizationId: run.organizationId,
          access: "update",
        }))
      ) {
        return errorResult(
          "The user this tuner runs as no longer holds tuner:update and log:admin.",
        );
      }
      const candidate = run.record?.candidates.find(
        (c) => c.fingerprint === args.fingerprint,
      );
      if (!candidate) {
        return errorResult(
          `No candidate with fingerprint "${args.fingerprint}" in this run.`,
        );
      }

      let action: TunerSuggestedAction = { type: "note" };
      if (args.policy_change) {
        if (!allowsPolicyChange(run.tunerKind)) {
          return errorResult(
            "This tuner files notes only; leave policy_change empty.",
          );
        }
        const gate = await checkPolicyChange({
          organizationId: run.organizationId,
          userId,
          expectedRevision: args.policy_change.expected_revision,
          edits: args.policy_change.edits,
        });
        switch (gate.type) {
          case "rejected":
            return errorResult(
              `The policy change was not filed (${gate.reason}): ${gate.message} Fix it, or propose a note instead.`,
            );
          case "accepted":
            action = {
              type: "policy_change",
              expectedRevision: args.policy_change.expected_revision,
              edits: args.policy_change.edits,
              gate: gate.gate,
              publication: null,
            };
        }
      }

      const result = await TunerSuggestionModel.propose({
        organizationId: run.organizationId,
        tunerKind: run.tunerKind,
        candidate,
        rationale: args.rationale,
        action,
        scheduleTriggerRunId: run.runId,
        now: new Date(),
      });
      switch (result.type) {
        case "suppressed":
          return structuredSuccessResult(
            { status: "suppressed", suggestionId: null, verification: null },
            `Not filed: this candidate is already covered (${result.reason}).`,
          );
        case "created":
          return structuredSuccessResult(
            {
              status: "created",
              suggestionId: result.suggestion.id,
              verification:
                result.suggestion.action.type === "policy_change"
                  ? result.suggestion.action.gate.verification
                  : null,
            },
            `Filed suggestion ${result.suggestion.id}.`,
          );
      }
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

function allowsPolicyChange(kind: TunerKind): boolean {
  switch (kind) {
    case "appa":
      return true;
    case "sre":
      return false;
  }
}
