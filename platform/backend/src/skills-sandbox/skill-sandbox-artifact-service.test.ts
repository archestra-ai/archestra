import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config from "@/config";
import { SkillSandboxFileModel, SkillSandboxModel } from "@/models";
import { skillSandboxArtifactService } from "@/skills-sandbox/skill-sandbox-artifact-service";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

async function seed(userId: string, sandboxId: string, filename: string) {
  return SkillSandboxFileModel.createArtifact({
    sandboxId,
    userId,
    path: `/s/${filename}`,
    mimeType: "text/plain",
    originalName: null,
    sizeBytes: 3,
    data: Buffer.from("abc"),
  });
}

describe("skillSandboxArtifactService", () => {
  test("listForConversation returns only that conversation's artifacts, all downloadable", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeConversation,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const conv = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });
    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv.id,
      defaultCwd: "/sandbox",
    });
    await seed(user.id, sandbox.id, "a.txt");

    const items = await skillSandboxArtifactService.listForConversation({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv.id,
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ filename: "a.txt", downloadable: true });
    expect(items[0].id).toBeTruthy();
  });

  describe("listAllForUser (filesystem mode)", () => {
    const original = { ...config.skillsSandbox.fileStorage };
    let fsRoot: string;
    beforeEach(async () => {
      fsRoot = await mkdtemp(join(tmpdir(), "xfiles-svc-"));
      config.skillsSandbox.fileStorage.provider = "filesystem";
      config.skillsSandbox.fileStorage.path = fsRoot;
    });
    afterEach(async () => {
      config.skillsSandbox.fileStorage.provider = original.provider;
      config.skillsSandbox.fileStorage.path = original.path;
      await rm(fsRoot, { recursive: true, force: true });
    });

    test("returns the user's on-disk artifacts as downloadable items", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const sandbox = await SkillSandboxModel.create({
        organizationId: org.id,
        userId: user.id,
        conversationId: null,
        defaultCwd: "/sandbox",
      });
      await seed(user.id, sandbox.id, "out.txt");

      const { folders, files } = await skillSandboxArtifactService.listAllForUser(
        {
          organizationId: org.id,
          userId: user.id,
        },
      );

      expect(folders).toEqual([]);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        filename: "out.txt",
        downloadable: true,
        folder: null,
      });
    });
  });
});
