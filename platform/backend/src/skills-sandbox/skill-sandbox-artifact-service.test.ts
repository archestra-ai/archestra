import { FileModel, SkillSandboxModel } from "@/models";
import { skillSandboxArtifactService } from "@/skills-sandbox/skill-sandbox-artifact-service";
import { describe, expect, test } from "@/test";

async function seed(params: {
  organizationId: string;
  userId: string;
  sandboxId: string;
  filename: string;
  conversationId?: string | null;
}) {
  return FileModel.create({
    organizationId: params.organizationId,
    userId: params.userId,
    namespace: { kind: "user", userId: params.userId },
    conversationId: params.conversationId ?? null,
    sandboxId: params.sandboxId,
    folderId: null,
    folderName: null,
    filename: params.filename,
    mimeType: "text/plain",
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
    await seed({
      organizationId: org.id,
      userId: user.id,
      sandboxId: sandbox.id,
      filename: "a.txt",
      conversationId: conv.id,
    });

    const items = await skillSandboxArtifactService.listForConversation({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv.id,
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ filename: "a.txt", downloadable: true });
    expect(items[0].id).toBeTruthy();
  });

  test("listAllForUser returns the user's files as downloadable items", async ({
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
    await seed({
      organizationId: org.id,
      userId: user.id,
      sandboxId: sandbox.id,
      filename: "out.txt",
    });

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

describe("skillSandboxArtifactService.resolveMyFileSource", () => {
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
    const artifact = await seed({
      organizationId: org.id,
      userId: user.id,
      sandboxId: sandbox.id,
      filename: "data.txt",
    });

    const resolved = await skillSandboxArtifactService.resolveMyFileSource({
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
    const denied = await skillSandboxArtifactService.resolveMyFileSource({
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
    await seed({
      organizationId: org.id,
      userId: user.id,
      sandboxId: sandbox.id,
      filename: "report.txt",
    });

    const byName = await skillSandboxArtifactService.resolveMyFileSource({
      organizationId: org.id,
      userId: user.id,
      filename: "report.txt",
    });
    expect("data" in byName && byName.data.toString()).toBe("abc");

    await seed({
      organizationId: org.id,
      userId: user.id,
      sandboxId: sandbox.id,
      filename: "report.txt",
    });
    const dup = await skillSandboxArtifactService.resolveMyFileSource({
      organizationId: org.id,
      userId: user.id,
      filename: "report.txt",
    });
    expect(dup).toEqual({ error: "ambiguous" });

    const missing = await skillSandboxArtifactService.resolveMyFileSource({
      organizationId: org.id,
      userId: user.id,
      filename: "nope.txt",
    });
    expect(missing).toEqual({ error: "not_found" });
  });
});
