import logger from "@/logging";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { resolveProposedPolicy } from "@/services/guardrails-policy-proposal";
import { refuseCredentialLines } from "@/services/openappa-policy-change";
import {
  getOpenAppaPolicyTests,
  replayOpenAppaDraft,
} from "@/services/openappa-policy-tests";
import { ApiError } from "@/types";
import type { GuardrailsPolicyEdit } from "@/types/guardrails-policy-proposal";
import type { PolicyTestCollection } from "@/types/openappa-policy-tests";
import type { TunerGateResult, TunerGateUnverifiedReason } from "@/types/tuner";

export type PolicyGateOutcome =
  | { type: "accepted"; gate: TunerGateResult; draft: string }
  | { type: "rejected"; reason: PolicyGateRejection; message: string };

/**
 * The light gate a tuner's policy change passes before it is stored, in the
 * order preview_guardrails_policy_change checks it. It saves nothing and
 * records no validation run. `userId` is whom the change is checked for: the
 * tuner trigger's actor.
 */
export async function checkPolicyChange(params: {
  organizationId: string;
  userId: string;
  expectedRevision: number;
  edits: GuardrailsPolicyEdit[];
}): Promise<PolicyGateOutcome> {
  const { organizationId, userId } = params;
  const before = await guardrailsPolicyService.get(organizationId);
  if (before.revision !== params.expectedRevision)
    return rejected(
      "stale_revision",
      `The policy is at revision ${before.revision}, not ${params.expectedRevision}.`,
    );

  const draft = await refusalOf(async () =>
    resolveProposedPolicy({
      current: before,
      proposal: { edits: params.edits },
    }),
  );
  if (draft.type === "refused")
    return rejected("edit_not_applicable", draft.message);

  const credentials = await refusalOf(() =>
    refuseCredentialLines({
      organizationId,
      userId,
      before: before.content,
      after: draft.value,
    }),
  );
  if (credentials.type === "refused")
    return rejected("credential_line", credentials.message);

  const validation = await guardrailsPolicyService.validate(draft.value, {
    organizationId,
    previous: before.content,
  });
  if (!validation.valid)
    return rejected("invalid_policy", validation.errors.join("\n"));

  const replay = await replaySuite({
    organizationId,
    userId,
    proposedPolicy: { content: draft.value, expectedRevision: before.revision },
  });
  switch (replay.type) {
    case "failed":
      return rejected(
        "validation_failed",
        `Saved validations fail against the proposed policy: ${replay.paths.join(", ")}`,
      );
    case "replayed":
      return { type: "accepted", gate: replay.gate, draft: draft.value };
  }
}

// ===

type PolicyGateRejection =
  | "stale_revision"
  | "edit_not_applicable"
  | "credential_line"
  | "invalid_policy"
  | "validation_failed";

type Refusable<T> =
  | { type: "ok"; value: T }
  | { type: "refused"; message: string };

type SuiteReplay =
  | { type: "replayed"; gate: TunerGateResult }
  | { type: "failed"; paths: string[] };

function rejected(
  reason: PolicyGateRejection,
  message: string,
): PolicyGateOutcome {
  return { type: "rejected", reason, message };
}

/** An ApiError the step throws is its refusal; anything else propagates. */
async function refusalOf<T>(run: () => Promise<T>): Promise<Refusable<T>> {
  try {
    return { type: "ok", value: await run() };
  } catch (error) {
    if (error instanceof ApiError)
      return { type: "refused", message: error.message };
    throw error;
  }
}

/**
 * Replays the saved suite against the draft. Unlike replaySavedValidations,
 * which folds every reason it could not replay into null, each outcome here
 * stays distinct: only a failing file refuses the change.
 */
async function replaySuite(params: {
  organizationId: string;
  userId: string;
  proposedPolicy: { content: string; expectedRevision: number };
}): Promise<SuiteReplay> {
  let collection: PolicyTestCollection;
  try {
    collection = await getOpenAppaPolicyTests(
      params.organizationId,
      params.userId,
    );
  } catch (error) {
    logger.warn(
      { err: error, organizationId: params.organizationId },
      "Tuner policy gate could not load the saved validations",
    );
    return unverified("replay_unavailable", null);
  }
  if (collection.error) return unverified("replay_unavailable", null);
  if (collection.files.length === 0)
    return unverified("no_saved_validations", collection.version);

  let files: Awaited<ReturnType<typeof replayOpenAppaDraft>>;
  try {
    files = await replayOpenAppaDraft(
      {
        ...params,
        files: collection.files,
        sourceVersion: collection.version,
        directory: collection.directory,
      },
      collection,
    );
  } catch (error) {
    logger.warn(
      { err: error, organizationId: params.organizationId },
      "Tuner policy gate could not replay the saved validations",
    );
    return unverified("replay_unavailable", collection.version);
  }

  const failed: string[] = [];
  const checked: TunerGateResult["files"] = [];
  for (const file of files)
    switch (file.status) {
      case "failed":
        failed.push(file.path);
        break;
      case "passed":
      case "cannot_run":
        checked.push({
          path: file.path,
          status: file.status,
          error: file.error ?? null,
        });
        break;
    }
  if (failed.length > 0) return { type: "failed", paths: failed };
  const cannotRun = checked.some((file) => file.status === "cannot_run");
  return {
    type: "replayed",
    gate: {
      verification: cannotRun ? "unverified" : "verified",
      reasons: cannotRun ? ["validation_cannot_run"] : [],
      files: checked,
      suiteVersion: collection.version,
    },
  };
}

function unverified(
  reason: TunerGateUnverifiedReason,
  suiteVersion: string | null,
): SuiteReplay {
  return {
    type: "replayed",
    gate: {
      verification: "unverified",
      reasons: [reason],
      files: [],
      suiteVersion,
    },
  };
}
