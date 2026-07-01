import { ProjectModel } from "@/models";
import ConversationModel from "@/models/conversation";
import { projectService } from "@/services/project";
import { expect, test } from "@/test";
import { resolveProjectFileScope } from "./project-file-scope";
import { SkillSandboxError } from "./types";

test("resolveProjectFileScope returns the project's id and name", async ({
  makeUser,
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const project = await ProjectModel.create({
    organizationId: org.id,
    userId: user.id,
    name: "scoped",
    description: null,
  });
  const conv = await ConversationModel.create({
    userId: user.id,
    organizationId: org.id,
    agentId: agent.id,
    projectId: project.id,
  });

  const scope = await resolveProjectFileScope({
    conversationId: conv.id,
    userId: user.id,
    organizationId: org.id,
  });
  expect(scope).toEqual({ projectId: project.id, projectName: "scoped" });
});

test("resolveProjectFileScope is null for a non-project chat", async ({
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
  expect(
    await resolveProjectFileScope({
      conversationId: conv.id,
      userId: user.id,
      organizationId: org.id,
    }),
  ).toBeNull();
});

test("resolveProjectFileScope fails closed for a caller without project access", async ({
  makeUser,
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const owner = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const project = await ProjectModel.create({
    organizationId: org.id,
    userId: owner.id,
    name: "private-project",
    description: null,
  });
  const conv = await ConversationModel.create({
    userId: owner.id,
    organizationId: org.id,
    agentId: agent.id,
    projectId: project.id,
  });

  const stranger = await makeUser({ email: "no-project-access@test.com" });
  await expect(
    resolveProjectFileScope({
      conversationId: conv.id,
      userId: stranger.id,
      organizationId: org.id,
    }),
  ).rejects.toBeInstanceOf(SkillSandboxError);
});

test("resolveProjectFileScope resolves for a member of an org-shared project", async ({
  makeUser,
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const owner = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const project = await ProjectModel.create({
    organizationId: org.id,
    userId: owner.id,
    name: "shared-project",
    description: null,
  });
  await projectService.setShare({
    id: project.id,
    organizationId: org.id,
    userId: owner.id,
    visibility: "organization",
    teamIds: [],
  });
  const conv = await ConversationModel.create({
    userId: owner.id,
    organizationId: org.id,
    agentId: agent.id,
    projectId: project.id,
  });

  const member = await makeUser({ email: "org-share-member@test.com" });
  const scope = await resolveProjectFileScope({
    conversationId: conv.id,
    userId: member.id,
    organizationId: org.id,
  });
  expect(scope?.projectId).toBe(project.id);
});
