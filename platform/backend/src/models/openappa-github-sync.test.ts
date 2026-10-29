import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
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

describe("OpenAppaGithubSyncModel.finish", () => {
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
});

describe("OpenAppaGithubSyncModel.findDue", () => {
  const checkedAgo = async (organizationId: string, minutes: number) => {
    await db
      .update(schema.openappaGithubSyncTable)
      .set({ lastSyncedAt: new Date(Date.now() - minutes * 60_000) })
      .where(eq(schema.openappaGithubSyncTable.organizationId, organizationId));
  };
  const due = async () =>
    (await OpenAppaGithubSyncModel.findDue()).map((row) => row.organizationId);

  test("a pending setup pull request is checked every minute, not every interval", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    await OpenAppaGithubSyncModel.save(organizationId, {
      ...source,
      setupPullRequestNumber: 7,
    });
    // Never checked: due at once, like any fresh source.
    expect(await due()).toContain(organizationId);

    await checkedAgo(organizationId, 0.5);
    expect(await due()).not.toContain(organizationId);

    // Two minutes is well inside the hourly interval, but the merge is waited on.
    await checkedAgo(organizationId, 2);
    expect(await due()).toContain(organizationId);
  });

  test("a connected source keeps its interval once the setup pull request is gone", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    await OpenAppaGithubSyncModel.save(organizationId, { ...source });
    await checkedAgo(organizationId, 2);
    expect(await due()).not.toContain(organizationId);

    await checkedAgo(organizationId, 61);
    expect(await due()).toContain(organizationId);
  });
});
