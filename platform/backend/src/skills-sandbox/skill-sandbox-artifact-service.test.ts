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

describe("skillSandboxArtifactService.resolveXFileSource", () => {
  test("resolves by id, scoped to the owning user (db mode)", async ({
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
    const artifact = await seed(user.id, sandbox.id, "data.txt");

    const resolved = await skillSandboxArtifactService.resolveXFileSource({
      organizationId: org.id,
      userId: user.id,
      id: artifact.id,
    });
    expect(resolved).toMatchObject({
      mimeType: "text/plain",
      originalName: "data.txt",
    });
    expect("data" in resolved && resolved.data.toString()).toBe("abc");

    const stranger = await makeUser({ email: "xfile-stranger@test.com" });
    const denied = await skillSandboxArtifactService.resolveXFileSource({
      organizationId: org.id,
      userId: stranger.id,
      id: artifact.id,
    });
    expect(denied).toEqual({ error: "not_found" });
  });

  test("resolves by filename, reporting duplicates as ambiguous (db mode)", async ({
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
    await seed(user.id, sandbox.id, "report.txt");

    const byName = await skillSandboxArtifactService.resolveXFileSource({
      organizationId: org.id,
      userId: user.id,
      filename: "report.txt",
    });
    expect("data" in byName && byName.data.toString()).toBe("abc");

    await seed(user.id, sandbox.id, "report.txt");
    const dup = await skillSandboxArtifactService.resolveXFileSource({
      organizationId: org.id,
      userId: user.id,
      filename: "report.txt",
    });
    expect(dup).toEqual({ error: "ambiguous" });

    const missing = await skillSandboxArtifactService.resolveXFileSource({
      organizationId: org.id,
      userId: user.id,
      filename: "nope.txt",
    });
    expect(missing).toEqual({ error: "not_found" });
  });

  describe("filesystem mode", () => {
    const original = { ...config.skillsSandbox.fileStorage };
    let fsRoot: string;

    beforeEach(async () => {
      fsRoot = await mkdtemp(join(tmpdir(), "xfile-resolve-"));
      config.skillsSandbox.fileStorage.provider = "filesystem";
      config.skillsSandbox.fileStorage.path = fsRoot;
    });
    afterEach(async () => {
      config.skillsSandbox.fileStorage.provider = original.provider;
      config.skillsSandbox.fileStorage.path = original.path;
      await rm(fsRoot, { recursive: true, force: true });
    });

    test("resolves an orphan (hand-dropped file, no row) by filename + folder", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(fsRoot, user.id, "drop"), { recursive: true });
      await writeFile(join(fsRoot, user.id, "drop", "manual.csv"), "x,y\n1,2\n");

      const resolved = await skillSandboxArtifactService.resolveXFileSource({
        organizationId: org.id,
        userId: user.id,
        filename: "manual.csv",
        folder: "drop",
      });
      expect(resolved).toMatchObject({
        mimeType: "text/csv",
        originalName: "manual.csv",
      });
      expect("data" in resolved && resolved.data.toString()).toBe("x,y\n1,2\n");
    });
  });
});
