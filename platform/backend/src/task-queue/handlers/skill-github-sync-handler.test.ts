import { vi } from "vitest";
import { SkillModel, SkillVersionModel } from "@/models";
import { createGithubPat } from "@/services/github-pat";
import { afterEach, expect, test } from "@/test";
import {
  STUB_COMMIT_SHA,
  stubGithub,
  stubSkillManifest,
} from "@/test/github-skills-stub";
import type { InsertSkill, Skill } from "@/types";
import { handleSkillGithubSync } from "./skill-github-sync-handler";

afterEach(() => {
  vi.unstubAllGlobals();
});

// The github-import module caches repo snapshots process-wide (5-minute LRU),
// so every test stubs a repo under a distinct owner.
async function seedSyncedSkill(params: {
  organizationId: string;
  owner: string;
  name: string;
  sourceCommit: string;
  overrides?: Partial<InsertSkill>;
}): Promise<Skill> {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId: params.organizationId,
      authorId: null,
      name: params.name,
      description: `${params.name} does things.`,
      content: "# old body",
      metadata: {},
      sourceType: "github",
      sourceRef: `${params.owner}/skills@main:${params.name}`,
      sourceCommit: params.sourceCommit,
      scope: "org",
      githubSyncInterval: "1d",
      githubSyncRef: "main",
      ...params.overrides,
    },
    files: [{ path: "references/a.md", content: "# A v1", kind: "reference" }],
  });
  if (!skill) throw new Error("seed failed");
  return skill;
}

test("pulls new content when the source commit moved", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const skill = await seedSyncedSkill({
    organizationId: org.id,
    owner: "sync-moved",
    name: "pdf",
    sourceCommit: "old-commit",
  });
  stubGithub([
    {
      owner: "sync-moved",
      repo: "skills",
      files: {
        "pdf/SKILL.md": `${stubSkillManifest("pdf")}\n\n# new body`,
        "pdf/references/a.md": "# A v2",
      },
    },
  ]);

  await handleSkillGithubSync({ skillId: skill.id });

  const synced = await SkillModel.findById(skill.id);
  expect(synced?.content).toContain("# new body");
  expect(synced?.sourceCommit).toBe(STUB_COMMIT_SHA);
  expect(synced?.latestVersion).toBe(2);
  expect(synced?.lastSyncedAt).not.toBeNull();
  expect(synced?.lastSyncError).toBeNull();
  // Archestra-side management is never touched by a sync.
  expect(synced?.scope).toBe("org");
  expect(synced?.githubSyncInterval).toBe("1d");
  const v2 = await SkillVersionModel.findBySkillAndVersion(skill.id, 2);
  const files = await SkillVersionModel.findFiles(v2?.id ?? "");
  expect(files.map((f) => f.content)).toEqual(["# A v2"]);
});

test("stamps lastSyncedAt without forking when the commit is unchanged", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const skill = await seedSyncedSkill({
    organizationId: org.id,
    owner: "sync-same",
    name: "pdf",
    sourceCommit: STUB_COMMIT_SHA,
  });
  stubGithub([
    {
      owner: "sync-same",
      repo: "skills",
      files: { "pdf/SKILL.md": stubSkillManifest("pdf") },
    },
  ]);

  await handleSkillGithubSync({ skillId: skill.id });

  const synced = await SkillModel.findById(skill.id);
  expect(synced?.latestVersion).toBe(1);
  expect(synced?.content).toBe("# old body");
  expect(synced?.lastSyncedAt).not.toBeNull();
  expect(synced?.lastSyncError).toBeNull();
  // the bookkeeping stamp is not an edit
  expect(synced?.updatedAt).toEqual(skill.updatedAt);
});

test("records the failure and keeps content when the source is gone", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const skill = await seedSyncedSkill({
    organizationId: org.id,
    owner: "sync-gone",
    name: "pdf",
    sourceCommit: "old-commit",
  });
  // no repo stubbed for this owner — the pull 404s
  stubGithub([]);

  await handleSkillGithubSync({ skillId: skill.id });

  const synced = await SkillModel.findById(skill.id);
  expect(synced?.content).toBe("# old body");
  expect(synced?.latestVersion).toBe(1);
  expect(synced?.lastSyncedAt).not.toBeNull();
  expect(synced?.lastSyncError).toBeTruthy();
});

test("is a no-op for a skill disconnected while queued", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const skill = await seedSyncedSkill({
    organizationId: org.id,
    owner: "sync-off",
    name: "pdf",
    sourceCommit: "old-commit",
    overrides: { githubSyncInterval: null, githubSyncRef: null },
  });
  const fetchMock = stubGithub([]);

  await handleSkillGithubSync({ skillId: skill.id });

  expect(fetchMock).not.toHaveBeenCalled();
  const after = await SkillModel.findById(skill.id);
  expect(after?.lastSyncedAt).toBeNull();
});

test("authenticates the pull with a stored PAT", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const pat = await createGithubPat({
    organizationId: org.id,
    data: { name: "sync token", token: "ghp_sync_token" },
  });
  const skill = await seedSyncedSkill({
    organizationId: org.id,
    owner: "sync-pat",
    name: "pdf",
    sourceCommit: "old-commit",
    overrides: { githubPatId: pat.id },
  });
  const fetchMock = stubGithub([
    {
      owner: "sync-pat",
      repo: "skills",
      files: { "pdf/SKILL.md": stubSkillManifest("pdf") },
    },
  ]);

  await handleSkillGithubSync({ skillId: skill.id });

  const synced = await SkillModel.findById(skill.id);
  expect(synced?.lastSyncError).toBeNull();
  expect(synced?.sourceCommit).toBe(STUB_COMMIT_SHA);
  const sawToken = fetchMock.mock.calls.some(([, init]) =>
    JSON.stringify(
      (init as { headers?: unknown } | undefined)?.headers ?? {},
    ).includes("ghp_sync_token"),
  );
  expect(sawToken).toBe(true);
});

test("records an error when the stored PAT was deleted", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const skill = await seedSyncedSkill({
    organizationId: org.id,
    owner: "sync-pat-gone",
    name: "pdf",
    sourceCommit: "old-commit",
    // dangling reference: the PAT row no longer exists (FK set-null covers
    // real deletes; a random uuid simulates the not-found path)
    overrides: { githubPatId: undefined },
  });
  // simulate FK set-null aftermath: interval kept, credential gone but the
  // repo is private (not stubbed) so the unauthenticated pull fails
  stubGithub([]);

  await handleSkillGithubSync({ skillId: skill.id });

  const synced = await SkillModel.findById(skill.id);
  expect(synced?.lastSyncError).toBeTruthy();
  expect(synced?.content).toBe("# old body");
});
