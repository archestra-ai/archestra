import { FileModel, ProjectModel } from "@/models";
import ConversationModel from "@/models/conversation";
import { projectService } from "@/services/project";
import { skillSandboxArtifactService } from "@/skills-sandbox/skill-sandbox-artifact-service";
import { describe, expect, test } from "@/test";

async function seed(params: {
  organizationId: string;
  userId: string;
  filename: string;
  projectId?: string | null;
  conversationId?: string | null;
}) {
  return FileModel.create({
    organizationId: params.organizationId,
    userId: params.userId,
    projectId: params.projectId ?? null,
    conversationId: params.conversationId ?? null,
    filename: params.filename,
    mimeType: "text/plain",
    sizeBytes: 3,
    data: Buffer.from("abc"),
  });
}

describe("skillSandboxArtifactService listing", () => {
  test("listForConversation returns that conversation's files, downloadable", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conv = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
    });
    await seed({
      organizationId: org.id,
      userId: user.id,
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

  test("listAllForUser returns the user's own files, excluding project files", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: user.id,
      name: "p",
      description: null,
    });
    await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "own.txt",
    });
    await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "proj.txt",
      projectId: project.id,
    });

    const files = await skillSandboxArtifactService.listAllForUser({
      organizationId: org.id,
      userId: user.id,
    });
    expect(files.map((f) => f.filename)).toEqual(["own.txt"]);
    expect(files[0].projectId).toBeNull();
  });
});

describe("getArtifactForUser access", () => {
  test("author sees own personal file; a stranger does not", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const file = await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "secret.txt",
    });

    const seen = await skillSandboxArtifactService.getArtifactForUser({
      artifactId: file.id,
      organizationId: org.id,
      userId: user.id,
    });
    expect(seen?.id).toBe(file.id);

    const stranger = await makeUser({ email: "stranger@test.com" });
    expect(
      await skillSandboxArtifactService.getArtifactForUser({
        artifactId: file.id,
        organizationId: org.id,
        userId: stranger.id,
      }),
    ).toBeNull();
  });

  test("project file: a member is allowed, a cross-org user is denied", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: owner.id,
      name: "shared",
      description: null,
    });
    await projectService.setShare({
      id: project.id,
      organizationId: org.id,
      userId: owner.id,
      visibility: "organization",
      teamIds: [],
    });
    const file = await seed({
      organizationId: org.id,
      userId: owner.id,
      filename: "r.txt",
      projectId: project.id,
    });

    const member = await makeUser({ email: "proj-member@test.com" });
    const seen = await skillSandboxArtifactService.getArtifactForUser({
      artifactId: file.id,
      organizationId: org.id,
      userId: member.id,
    });
    expect(seen?.id).toBe(file.id);

    const otherOrg = await makeOrganization();
    const outsider = await makeUser({ email: "cross-org@test.com" });
    expect(
      await skillSandboxArtifactService.getArtifactForUser({
        artifactId: file.id,
        organizationId: otherOrg.id,
        userId: outsider.id,
      }),
    ).toBeNull();
  });

  test("project file: a user with no project access is denied; the owner is allowed", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    // owner-only project: no share row at all
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: owner.id,
      name: "owner-only",
      description: null,
    });
    const file = await seed({
      organizationId: org.id,
      userId: owner.id,
      filename: "r.txt",
      projectId: project.id,
    });

    const nonMember = await makeUser({ email: "non-member@test.com" });
    expect(
      await skillSandboxArtifactService.getArtifactForUser({
        artifactId: file.id,
        organizationId: org.id,
        userId: nonMember.id,
      }),
    ).toBeNull();

    const seenByOwner = await skillSandboxArtifactService.getArtifactForUser({
      artifactId: file.id,
      organizationId: org.id,
      userId: owner.id,
    });
    expect(seenByOwner?.id).toBe(file.id);
  });
});

describe("resolveMyFileSource", () => {
  test("resolves a personal file by id; rejects a stranger and a project file", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const file = await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "data.txt",
    });

    const ok = await skillSandboxArtifactService.resolveMyFileSource({
      organizationId: org.id,
      userId: user.id,
      id: file.id,
    });
    expect("data" in ok && ok.data.toString()).toBe("abc");
    expect("originalName" in ok && ok.originalName).toBe("data.txt");

    const stranger = await makeUser({ email: "rs-stranger@test.com" });
    expect(
      await skillSandboxArtifactService.resolveMyFileSource({
        organizationId: org.id,
        userId: stranger.id,
        id: file.id,
      }),
    ).toEqual({ error: "not_found" });

    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: user.id,
      name: "pp",
      description: null,
    });
    const projFile = await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "p.txt",
      projectId: project.id,
    });
    expect(
      await skillSandboxArtifactService.resolveMyFileSource({
        organizationId: org.id,
        userId: user.id,
        id: projFile.id,
      }),
    ).toEqual({ error: "not_found" });
  });

  test("resolves by filename and reports duplicates as ambiguous", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await seed({
      organizationId: org.id,
      userId: user.id,
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
      filename: "report.txt",
    });
    expect(
      await skillSandboxArtifactService.resolveMyFileSource({
        organizationId: org.id,
        userId: user.id,
        filename: "report.txt",
      }),
    ).toEqual({ error: "ambiguous" });

    expect(
      await skillSandboxArtifactService.resolveMyFileSource({
        organizationId: org.id,
        userId: user.id,
        filename: "nope.txt",
      }),
    ).toEqual({ error: "not_found" });
  });

  test("project scope: a file outside the project is rejected by id", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: owner.id,
      name: "scope-proj",
      description: null,
    });
    const inProj = await seed({
      organizationId: org.id,
      userId: owner.id,
      filename: "in.txt",
      projectId: project.id,
    });
    const personal = await seed({
      organizationId: org.id,
      userId: owner.id,
      filename: "out.txt",
    });

    const ok = await skillSandboxArtifactService.resolveMyFileSource({
      organizationId: org.id,
      userId: owner.id,
      id: inProj.id,
      scope: { projectId: project.id },
    });
    expect("data" in ok && ok.data.toString()).toBe("abc");

    expect(
      await skillSandboxArtifactService.resolveMyFileSource({
        organizationId: org.id,
        userId: owner.id,
        id: personal.id,
        scope: { projectId: project.id },
      }),
    ).toEqual({ error: "outside_project" });
  });
});
