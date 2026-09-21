import { randomUUID } from "node:crypto";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import { describe, expect, mustExist, test } from "@/test";

const source = {
  repo: "acme/policies",
  ref: null,
  path: "appa.toml",
  interval: "1h",
  githubPatId: null,
  githubAppConfigId: null,
} as const;

const heldPull = {
  content: "[policy]\nversion = 2\n",
  contentHash: "hash-a",
  sourceCommit: "a".repeat(40),
  reasons: ["changes_credentials"] as const,
  error: "The repository text changes a credential binding",
};

describe("OpenAppaGithubSyncModel held pulls", () => {
  test("hold records the pull only under the current revision", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    await OpenAppaGithubSyncModel.save(organizationId, { ...source });
    const { revision } = mustExist(
      await OpenAppaGithubSyncModel.find(organizationId),
    );

    expect(
      await OpenAppaGithubSyncModel.hold({
        organizationId,
        revision: randomUUID(),
        ...heldPull,
        reasons: [...heldPull.reasons],
      }),
    ).toBe(false);
    expect(
      mustExist(await OpenAppaGithubSyncModel.find(organizationId)),
    ).toMatchObject({ heldContent: null, heldReasons: [] });

    expect(
      await OpenAppaGithubSyncModel.hold({
        organizationId,
        revision,
        ...heldPull,
        reasons: [...heldPull.reasons],
      }),
    ).toBe(true);
    const held = mustExist(await OpenAppaGithubSyncModel.find(organizationId));
    expect(held).toMatchObject({
      heldContent: heldPull.content,
      heldContentHash: heldPull.contentHash,
      heldSourceCommit: heldPull.sourceCommit,
      heldReasons: ["changes_credentials"],
      lastSyncError: heldPull.error,
      // Held bytes are not accepted bytes.
      content: null,
      sourceCommit: null,
    });
    expect(held.lastSyncedAt).toBeInstanceOf(Date);

    await OpenAppaGithubSyncModel.clearHold(organizationId);
    expect(
      mustExist(await OpenAppaGithubSyncModel.find(organizationId)),
    ).toMatchObject({
      heldContent: null,
      heldContentHash: null,
      heldSourceCommit: null,
      heldReasons: [],
    });
  });

  test("a published pull supersedes a held one", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    await OpenAppaGithubSyncModel.save(organizationId, { ...source });
    const { revision } = mustExist(
      await OpenAppaGithubSyncModel.find(organizationId),
    );
    await OpenAppaGithubSyncModel.hold({
      organizationId,
      revision,
      ...heldPull,
      reasons: [...heldPull.reasons],
    });

    await OpenAppaGithubSyncModel.finish({
      organizationId,
      revision,
      outcome: {
        content: "[policy]\nversion = 2\n# published\n",
        contentHash: "hash-b",
        sourceCommit: "b".repeat(40),
      },
    });

    expect(
      mustExist(await OpenAppaGithubSyncModel.find(organizationId)),
    ).toMatchObject({
      content: "[policy]\nversion = 2\n# published\n",
      heldContent: null,
      heldReasons: [],
      lastSyncError: null,
    });
  });
});

describe("OpenAppaGithubSyncModel.ensureRow", () => {
  test("carries the pending flag for an organization with no source", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toBeNull();

    await OpenAppaGithubSyncModel.ensureRow(organizationId);
    await OpenAppaGithubSyncModel.setDeclarationsPendingPublish(
      organizationId,
      true,
    );
    const row = mustExist(await OpenAppaGithubSyncModel.find(organizationId));
    expect(row).toMatchObject({
      repo: null,
      path: null,
      interval: null,
      declarationsPendingPublish: true,
    });
    // A row without a source is never due for a download.
    expect(
      (await OpenAppaGithubSyncModel.findDue()).map(
        (due) => due.organizationId,
      ),
    ).not.toContain(organizationId);

    await OpenAppaGithubSyncModel.ensureRow(organizationId);
    expect(
      mustExist(await OpenAppaGithubSyncModel.find(organizationId)),
    ).toMatchObject({ declarationsPendingPublish: true });

    await OpenAppaGithubSyncModel.setDeclarationsPendingPublish(
      organizationId,
      false,
    );
    expect(
      mustExist(await OpenAppaGithubSyncModel.find(organizationId))
        .declarationsPendingPublish,
    ).toBe(false);
  });
});
