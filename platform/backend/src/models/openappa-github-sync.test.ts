import { createHash, randomUUID } from "node:crypto";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
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
  });

  test("a hold takes the revision with it, so a pull that read the old one records nothing", async ({
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
        revision,
        ...heldPull,
        reasons: [...heldPull.reasons],
      }),
    ).toBe(true);
    const rotated = mustExist(
      await OpenAppaGithubSyncModel.find(organizationId),
    );
    expect(rotated.revision).not.toBe(revision);

    // A second download read the row before the hold landed.
    expect(
      await OpenAppaGithubSyncModel.finish({
        organizationId,
        revision,
        outcome: {
          content: "[policy]\nversion = 2\n# raced\n",
          contentHash: "hash-raced",
          sourceCommit: "d".repeat(40),
        },
      }),
    ).toBe(false);
    expect(
      mustExist(await OpenAppaGithubSyncModel.find(organizationId)),
    ).toMatchObject({
      content: null,
      heldContent: heldPull.content,
      heldContentHash: heldPull.contentHash,
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
      revision: mustExist(await OpenAppaGithubSyncModel.find(organizationId))
        .revision,
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

  test("finish answers whether the pull it recorded was still the expected one", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    await OpenAppaGithubSyncModel.save(organizationId, { ...source });
    const { revision } = mustExist(
      await OpenAppaGithubSyncModel.find(organizationId),
    );
    const outcome = {
      content: "[policy]\nversion = 2\n# pulled\n",
      contentHash: "hash-c",
      sourceCommit: "c".repeat(40),
    };
    expect(
      await OpenAppaGithubSyncModel.finish({
        organizationId,
        revision: randomUUID(),
        outcome,
      }),
    ).toBe(false);
    expect(
      mustExist(await OpenAppaGithubSyncModel.find(organizationId)),
    ).toMatchObject({ content: null });
    expect(
      await OpenAppaGithubSyncModel.finish({
        organizationId,
        revision,
        outcome,
      }),
    ).toBe(true);
  });

  test("changing the schedule drops the held pull, and publishing needs the bytes that were held", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    await OpenAppaGithubSyncModel.save(organizationId, { ...source });
    const hold = async () => {
      const { revision } = mustExist(
        await OpenAppaGithubSyncModel.find(organizationId),
      );
      await OpenAppaGithubSyncModel.hold({
        organizationId,
        revision,
        ...heldPull,
        reasons: [...heldPull.reasons],
      });
    };
    await hold();

    // Bytes held under a schedule may not outlive it.
    await OpenAppaGithubSyncModel.setInterval(organizationId, null);
    expect(
      mustExist(await OpenAppaGithubSyncModel.find(organizationId)),
    ).toMatchObject({ heldContent: null, heldReasons: [] });
    expect(
      await OpenAppaGithubSyncModel.publishHeld({
        organizationId,
        userId,
        heldContentHash: heldPull.contentHash,
      }),
    ).toBeNull();

    await OpenAppaGithubSyncModel.setInterval(organizationId, "1h");
    await hold();
    // A newer pull replaced what the accepting user read.
    expect(
      await OpenAppaGithubSyncModel.publishHeld({
        organizationId,
        userId,
        heldContentHash: "hash-of-an-older-pull",
      }),
    ).toBeNull();
    expect(
      await OpenAppaGithubSyncModel.publishHeld({
        organizationId,
        userId,
        heldContentHash: heldPull.contentHash,
      }),
    ).toMatchObject({ contentHash: heldPull.contentHash });
  });
});

describe("declaration revisions and the pending-publish flag", () => {
  const declared =
    'include = ["batteries/github/appa.toml"]\n\n[policy]\nversion = 2\n';

  test("the migration's revision and its flag are one write", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toBeNull();

    const saved = await GuardrailsPolicyModel.saveDeclarationMigration({
      organizationId,
      content: declared,
      contentHash: createHash("sha256").update(declared).digest("hex"),
      expectedRevision: 0,
    });

    expect(mustExist(saved).revision).toBe(1);
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

    await OpenAppaGithubSyncModel.setDeclarationsPendingPublish(
      organizationId,
      false,
    );
    expect(
      mustExist(await OpenAppaGithubSyncModel.find(organizationId))
        .declarationsPendingPublish,
    ).toBe(false);
  });

  test("a revision that lost its race flags nothing", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    await GuardrailsPolicyModel.saveDeclarationMigration({
      organizationId,
      content: declared,
      contentHash: createHash("sha256").update(declared).digest("hex"),
      expectedRevision: 0,
    });
    await OpenAppaGithubSyncModel.setDeclarationsPendingPublish(
      organizationId,
      false,
    );

    expect(
      await GuardrailsPolicyModel.saveDeclarationMigration({
        organizationId,
        content: `${declared}# again\n`,
        contentHash: createHash("sha256")
          .update(`${declared}# again\n`)
          .digest("hex"),
        expectedRevision: 0,
      }),
    ).toBeNull();
    expect(
      mustExist(await OpenAppaGithubSyncModel.find(organizationId))
        .declarationsPendingPublish,
    ).toBe(false);
  });
});
