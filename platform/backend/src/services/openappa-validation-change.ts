import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { publishOpenAppaPolicyChange } from "@/services/openappa-policy-change";
import {
  getOpenAppaPolicyTests,
  inspectOpenAppaPolicyTests,
  replayOpenAppaDraft,
} from "@/services/openappa-policy-tests";
import { ApiError } from "@/types";
import { PolicyTestFilesSchema } from "@/types/openappa-policy-tests";
import {
  type PreviewOpenAppaValidationChange,
  PreviewOpenAppaValidationChangeSchema,
  type PublishOpenAppaValidationChange,
  PublishOpenAppaValidationChangeSchema,
} from "@/types/openappa-validation-change";

type Caller = { organizationId: string; userId: string };

async function prepare(params: Caller & PreviewOpenAppaValidationChange) {
  const { organizationId, userId, ...input } = params;
  const request = PreviewOpenAppaValidationChangeSchema.parse(input);
  const [root, collection, source] = await Promise.all([
    guardrailsPolicyService.get(organizationId),
    getOpenAppaPolicyTests(organizationId, userId),
    OpenAppaGithubSyncModel.find(organizationId),
  ]);
  if (
    root.revision !== request.expectedRevision ||
    collection.version !== request.expectedVersion
  )
    throw new ApiError(
      409,
      "Policy or validation files changed; read both again before proposing changes",
    );
  if (collection.error) throw new ApiError(409, collection.error);
  if (collection.source === "github" && !collection.activeDirectory)
    throw new ApiError(
      409,
      "Set a validation directory in GitHub source settings before proposing validations",
    );
  const filesByPath = new Map(
    collection.files.map((file) => [file.path, file]),
  );
  for (const path of request.changes.delete) {
    if (!filesByPath.has(path))
      throw new ApiError(
        400,
        "A validation selected for deletion does not exist",
      );
    filesByPath.delete(path);
  }
  for (const file of request.changes.upsert) filesByPath.set(file.path, file);
  if (collection.source === "github") {
    for (const path of [
      ...request.changes.upsert.map((file) => file.path),
      ...request.changes.delete,
    ])
      if (
        !path.startsWith(`${collection.activeDirectory}/`) ||
        path.slice(collection.activeDirectory.length + 1).includes("/") ||
        path === source?.path
      )
        throw new ApiError(
          400,
          "Change only direct .appa files in the configured validation directory",
        );
  }
  const files = PolicyTestFilesSchema.parse(
    [...filesByPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
  );
  // Preview and update both check syntax; only preview replays.
  const inspection = request.changes.upsert.length
    ? await inspectOpenAppaPolicyTests(request.changes.upsert)
    : { files: [] };
  const errors = inspection.files.flatMap((file) =>
    file.error === null ? [] : [`${file.path}: ${file.error}`],
  );
  const validation = { valid: errors.length === 0, errors };
  const [currentRoot, currentSource, currentSuite] = await Promise.all([
    guardrailsPolicyService.get(organizationId),
    OpenAppaGithubSyncModel.find(organizationId),
    OpenAppaPolicyTestsModel.find(organizationId),
  ]);
  if (
    currentRoot.revision !== root.revision ||
    currentSource?.revision !== source?.revision ||
    (collection.source === "local" &&
      (currentSuite?.version ?? "empty") !== collection.version)
  )
    throw new ApiError(
      409,
      "Policy or validation source changed during preview; read both again",
    );
  return {
    request,
    root,
    collection,
    files,
    validation,
    inspected: inspection.files,
  };
}

export async function previewOpenAppaValidationChange(
  params: Caller & PreviewOpenAppaValidationChange,
) {
  const proposal = await prepare(params);
  // Replay only the added or edited files against the saved policy; nothing
  // is recorded. Null when a syntax check failed or no file was upserted.
  const upserted = proposal.request.changes.upsert;
  const tests =
    proposal.validation.valid && upserted.length
      ? await replayOpenAppaDraft(
          {
            organizationId: params.organizationId,
            userId: params.userId,
            files: upserted,
            sourceVersion: proposal.collection.version,
            directory: proposal.collection.directory,
          },
          proposal.collection,
        )
      : null;
  return {
    stage: "preview" as const,
    delivery:
      proposal.collection.source === "github"
        ? ("pull_request" as const)
        : ("revision" as const),
    policyRevision: proposal.root.revision,
    changes: proposal.request.changes,
    validation: proposal.validation,
    files: proposal.inspected,
    tests,
    directory: proposal.collection.activeDirectory,
    sourceCommit: proposal.collection.sourceCommit,
  };
}

export async function publishOpenAppaValidationChange(
  params: Caller & PublishOpenAppaValidationChange,
) {
  const { organizationId, userId, ...input } = params;
  const { title, summary, ...request } =
    PublishOpenAppaValidationChangeSchema.parse(input);
  const proposal = await prepare({ organizationId, userId, ...request });
  if (!proposal.validation.valid)
    throw new ApiError(400, proposal.validation.errors.join("\n"));
  if (!request.changes.upsert.length && !request.changes.delete.length)
    throw new ApiError(400, "The proposal has no validation changes");
  if (proposal.collection.source === "github") {
    const published = await publishOpenAppaPolicyChange({
      organizationId,
      userId,
      content: proposal.root.content,
      expectedRevision: proposal.root.revision,
      title,
      summary,
      includePolicy: false,
      validationChanges: {
        ...request.changes,
        directory: proposal.collection.activeDirectory,
        expectedVersion: proposal.collection.version,
      },
    });
    return { ...published, validation: proposal.validation };
  }
  const saved = await OpenAppaPolicyTestsModel.saveLocal({
    organizationId,
    files: proposal.files,
    expectedVersion: proposal.collection.version,
    expectedPolicyRevision: proposal.root.revision,
  });
  if (!saved)
    throw new ApiError(
      409,
      "Policy or validations changed, or Git sync was enabled; read both again",
    );
  return {
    delivery: "revision" as const,
    revision: proposal.root.revision,
    version: saved.version,
    validation: proposal.validation,
  };
}
