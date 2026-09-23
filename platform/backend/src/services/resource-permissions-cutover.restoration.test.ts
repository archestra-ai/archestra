// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import KnowledgeBaseModel from "@/models/knowledge-base";
import KnowledgeBaseConnectorModel from "@/models/knowledge-base-connector";
import ProjectModel from "@/models/project";
import { ResourcePermissions } from "@/services/resource-permissions";
import { expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

test("resources deleted before upgrade retain their audience when restored without restarting", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeTeam,
  makeTeamMember,
  makeKnowledgeBase,
  makeKnowledgeBaseConnector,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
  const owner = await makeUser();
  const teammate = await makeUser();
  const outsider = await makeUser();
  for (const user of [owner, teammate, outsider])
    await makeMember(user.id, org.id);
  const team = await makeTeam(org.id, owner.id);
  await makeTeamMember(team.id, teammate.id);
  const project = await ProjectModel.create({
    organizationId: org.id,
    userId: owner.id,
    name: "Restored project",
  });
  const kb = await makeKnowledgeBase(org.id, {
    legacy: { visibility: "team-scoped", teamIds: [team.id] },
  });
  const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
    legacy: { visibility: "team-scoped", teamIds: [team.id] },
  });
  await ProjectModel.delete(project.id);
  await KnowledgeBaseModel.delete(kb.id);
  await KnowledgeBaseConnectorModel.delete(connector.id);

  await runScopedResourcePermissionCutover();

  expect(
    await ProjectModel.restore({
      id: project.id,
      organizationId: org.id,
      name: project.name,
    }),
  ).toBe(true);
  expect(await KnowledgeBaseModel.restore(kb.id)).toBe(true);
  expect(await KnowledgeBaseConnectorModel.restore(connector.id)).toBe(true);
  for (const [resource, scope, allowedUserId] of [
    ["project", project.id, owner.id],
    ["knowledgeBase", kb.id, teammate.id],
    ["knowledgeConnector", connector.id, teammate.id],
  ] as const) {
    const access = {
      organizationId: org.id,
      resource,
      scope,
      action: "read" as const,
    };
    expect(
      await ResourcePermissions.allows({ ...access, userId: allowedUserId }),
      resource,
    ).toBe(true);
    expect(
      await ResourcePermissions.allows({ ...access, userId: outsider.id }),
      resource,
    ).toBe(false);
  }
});
