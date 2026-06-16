import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { FolderModel } from "@/models";
import ConversationModel from "@/models/conversation";
import { projectService } from "@/services/project";
import { expect, test } from "@/test";
import { resolveProjectFileScope } from "./project-file-scope";
import { SkillSandboxError } from "./types";

test("resolveProjectFileScope returns the project's folder and project namespace", async ({
  makeUser,
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const project = await projectService.create({
    organizationId: org.id,
    userId: user.id,
    name: "scoped",
    description: null,
  });
  const folder = await FolderModel.findByProjectId(project.id);
  const conv = await ConversationModel.create({
    userId: user.id,
    organizationId: org.id,
    agentId: agent.id,
    projectId: project.id,
  });

  const scope = await resolveProjectFileScope(conv.id);
  expect(scope).toEqual({
    projectId: project.id,
    projectName: "scoped",
    folderId: folder?.id,
    folderName: "scoped",
    namespace: { kind: "project", projectId: project.id },
  });
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
  expect(await resolveProjectFileScope(conv.id)).toBeNull();
});

test("resolveProjectFileScope fails closed when the project's folder is gone", async ({
  makeUser,
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const project = await projectService.create({
    organizationId: org.id,
    userId: user.id,
    name: "folderless",
    description: null,
  });
  const conv = await ConversationModel.create({
    userId: user.id,
    organizationId: org.id,
    agentId: agent.id,
    projectId: project.id,
  });
  // remove the folder row out from under the project.
  await db
    .delete(schema.foldersTable)
    .where(eq(schema.foldersTable.projectId, project.id));

  await expect(resolveProjectFileScope(conv.id)).rejects.toBeInstanceOf(
    SkillSandboxError,
  );
});
