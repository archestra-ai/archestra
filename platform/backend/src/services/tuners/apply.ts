import { userHasPermission } from "@/auth/utils";
import logger from "@/logging";
import { TunerSuggestionModel } from "@/models";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import {
  getOpenAppaPolicyChangeStatus,
  publishOpenAppaPolicyChange,
} from "@/services/openappa-policy-change";
import { ApiError } from "@/types";
import type { TunerSuggestion } from "@/types/tuner-suggestion";

/**
 * Applies a policy-change suggestion as the acting admin: a local policy saves
 * a revision (the suggestion is then effective), Git sync opens a change
 * request (published until it merges and syncs). The suggestion is claimed
 * first, so a second apply or a close loses; any failure returns it to open.
 */
export async function applyPolicySuggestion(params: {
  id: string;
  organizationId: string;
  userId: string;
}): Promise<TunerSuggestion> {
  const suggestion = await TunerSuggestionModel.findById(params);
  if (!suggestion) throw new ApiError(404, "Suggestion not found");
  const action = suggestion.action;
  if (action.type !== "policy_change") {
    throw new ApiError(400, "Only a policy change can be applied");
  }
  if (
    !(await userHasPermission(
      params.userId,
      params.organizationId,
      "guardrailsPolicy",
      "update",
    ))
  ) {
    throw new ApiError(
      403,
      "Applying a policy change needs guardrailsPolicy:update",
    );
  }
  const claimed = await TunerSuggestionModel.claimForApply(params);
  if (!claimed) throw new ApiError(409, "The suggestion is no longer open");

  let published: Awaited<ReturnType<typeof publishOpenAppaPolicyChange>>;
  try {
    published = await publishOpenAppaPolicyChange({
      organizationId: params.organizationId,
      userId: params.userId,
      expectedRevision: action.expectedRevision,
      edits: action.edits,
      title: suggestion.title,
      summary: suggestion.rationale,
    });
  } catch (error) {
    await TunerSuggestionModel.releaseClaim({ ...params, publication: null });
    throw error;
  }

  const settled = await (async () => {
    switch (published.delivery) {
      case "revision":
        return TunerSuggestionModel.markEffective({
          ...params,
          publication: null,
        });
      case "pull_request":
        return TunerSuggestionModel.recordPublication({
          ...params,
          action: {
            ...action,
            publication: {
              number: published.number,
              url: published.url,
              repo: published.repo,
            },
          },
        });
    }
  })();
  if (!settled)
    throw new ApiError(409, "The suggestion changed while applying");
  return settled;
}

/**
 * Moves a published change on once its change request settles: merged and
 * applied by Git sync → effective; closed unmerged → open again. A claim left
 * without a change request by an interrupted apply returns to open once it is
 * clearly abandoned.
 */
export async function refreshPolicySuggestion(params: {
  id: string;
  organizationId: string;
  userId: string;
}): Promise<TunerSuggestion> {
  const suggestion = await TunerSuggestionModel.findById(params);
  if (!suggestion) throw new ApiError(404, "Suggestion not found");
  if (
    suggestion.status !== "published" ||
    suggestion.action.type !== "policy_change"
  ) {
    return suggestion;
  }
  const publication = suggestion.action.publication;
  if (!publication) {
    const abandoned =
      Date.now() - suggestion.statusChangedAt.getTime() > ABANDONED_CLAIM_MS;
    return abandoned
      ? ((await TunerSuggestionModel.releaseClaim({
          id: params.id,
          organizationId: params.organizationId,
          publication: null,
        })) ?? suggestion)
      : suggestion;
  }
  const source = await OpenAppaGithubSyncModel.find(params.organizationId);
  if (source?.repo !== publication.repo) {
    logger.warn(
      { suggestionId: suggestion.id, repo: publication.repo },
      "Git sync no longer points at the repository of a published tuner change",
    );
    return suggestion;
  }

  const status = await getOpenAppaPolicyChangeStatus({
    organizationId: params.organizationId,
    userId: params.userId,
    number: publication.number,
  });
  const moved =
    status.state === "merged" && "applied" in status && status.applied
      ? await TunerSuggestionModel.markEffective({
          id: params.id,
          organizationId: params.organizationId,
          userId: null,
          publication: publication.number,
        })
      : status.state === "closed"
        ? await TunerSuggestionModel.releaseClaim({
            id: params.id,
            organizationId: params.organizationId,
            publication: publication.number,
          })
        : null;
  return moved ?? suggestion;
}

/** Refreshes every published change of the organization; one failure skips only that one. */
export async function refreshPublishedPolicyChanges(params: {
  organizationId: string;
  userId: string;
}): Promise<void> {
  const published = await TunerSuggestionModel.findPublishedPolicyChanges(
    params.organizationId,
  );
  for (const suggestion of published) {
    try {
      await refreshPolicySuggestion({ ...params, id: suggestion.id });
    } catch (error) {
      logger.warn(
        { suggestionId: suggestion.id, error },
        "Could not refresh a published tuner policy change",
      );
    }
  }
}

/** Far longer than any apply takes; an older claim without a change request was interrupted. */
const ABANDONED_CLAIM_MS = 15 * 60 * 1000;
