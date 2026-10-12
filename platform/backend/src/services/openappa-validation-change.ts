import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import {
  publishOpenAppaPolicyChange,
  refuseCredentialLines,
} from "@/services/openappa-policy-change";
import {
  getOpenAppaPolicyTests,
  inspectOpenAppaPolicyTests,
  replayOpenAppaValidationProposal,
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
  const policyContent = request.policyContent ?? root.content;
  const policyChanged =
    request.policyContent != null &&
    (root.revision === 0 || policyContent !== root.content);
  if (policyChanged)
    await refuseCredentialLines({
      organizationId,
      userId,
      before: root.content,
      after: policyContent,
    });
  const [replayed, inspection] = await Promise.all([
    replayOpenAppaValidationProposal(
      {
        organizationId,
        userId,
        files,
        sourceVersion: collection.version,
        directory: collection.directory,
        ...(policyChanged
          ? {
              proposedPolicy: {
                content: policyContent,
                expectedRevision: root.revision,
              },
            }
          : {}),
      },
      collection,
    ),
    request.changes.upsert.length
      ? inspectOpenAppaPolicyTests(request.changes.upsert)
      : { files: [] },
  ]);
  const parseErrors = inspection.files.flatMap((file) =>
    file.error === null ? [] : [file.error],
  );
  const tests = parseErrors.length
    ? {
        ...replayed,
        validation: {
          ...replayed.validation,
          valid: false,
          errors: [...replayed.validation.errors, ...parseErrors],
        },
      }
    : replayed;
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
  const counts = {
    passed: tests.files.filter((file) => file.status === "passed").length,
    failed: tests.files.filter((file) => file.status === "failed").length,
    cannotRun: tests.files.filter((file) => file.status === "cannot_run")
      .length,
  };
  return {
    request,
    root,
    collection,
    files,
    tests,
    counts,
    policyContent,
    policyChanged,
  };
}

export async function previewOpenAppaValidationChange(
  params: Caller & PreviewOpenAppaValidationChange,
) {
  const proposal = await prepare(params);
  return {
    stage: "preview" as const,
    delivery:
      proposal.collection.source === "github"
        ? ("pull_request" as const)
        : ("revision" as const),
    policy: {
      revision: proposal.root.revision,
      changed: proposal.policyChanged,
      ...(proposal.policyChanged
        ? {
            before: proposal.root.content,
            after: proposal.policyContent,
          }
        : {}),
    },
    changes: proposal.request.changes,
    tests: proposal.tests,
    counts: proposal.counts,
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
  if (!proposal.tests.validation.valid)
    throw new ApiError(400, proposal.tests.validation.errors.join("\n"));
  const testsChanged =
    request.changes.upsert.length > 0 || request.changes.delete.length > 0;
  if (!proposal.policyChanged && !testsChanged)
    throw new ApiError(400, "The proposal has no policy or validation changes");
  if (proposal.collection.source === "github") {
    const published = await publishOpenAppaPolicyChange({
      organizationId,
      userId,
      content: proposal.policyContent,
      expectedRevision: proposal.root.revision,
      title,
      summary,
      includePolicy: proposal.policyChanged,
      validationChanges: {
        ...request.changes,
        directory: proposal.collection.activeDirectory,
        expectedVersion: proposal.collection.version,
      },
    });
    return { ...published, tests: proposal.tests, counts: proposal.counts };
  }
  let revision = proposal.root.revision;
  let version: string;
  if (proposal.policyChanged) {
    const saved = await guardrailsPolicyService.update({
      organizationId,
      userId,
      content: proposal.policyContent,
      expectedRevision: proposal.root.revision,
      validation: {
        expectedVersion: proposal.collection.version,
        ...(testsChanged ? { files: proposal.files } : {}),
      },
    });
    revision = saved.revision;
    version = saved.validationVersion ?? proposal.collection.version;
  } else {
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
    version = saved.version;
  }
  return {
    delivery: "revision" as const,
    revision,
    version,
    policyChanged: proposal.policyChanged,
    tests: proposal.tests,
    counts: proposal.counts,
  };
}
