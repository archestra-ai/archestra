import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { expect, test } from "@/test";

test("fixture access writes the stated audience through the create path", async ({
  makeOrganization,
  makeUser,
  makeTeam,
  makeAgent,
  makeSkill,
}) => {
  const org = await makeOrganization();
  const author = await makeUser();
  const reader = await makeUser();
  const team = await makeTeam(org.id, author.id);

  const audienceOf = async (resource: "agent" | "skill", scope: string) =>
    (
      await ResourcePermissionPolicyModel.findAudience({
        organizationId: org.id,
        resource,
        scope,
      })
    ).audience;

  const orgAgent = await makeAgent({
    agentType: "agent",
    organizationId: org.id,
    authorId: author.id,
    access: "org",
  });
  const teamAgent = await makeAgent({
    agentType: "agent",
    organizationId: org.id,
    authorId: author.id,
    access: { teams: [team.id] },
  });
  const ownSkill = await makeSkill(org.id, { authorId: author.id });
  const sharedSkill = await makeSkill(org.id, {
    authorId: author.id,
    access: { users: [reader.id], preset: "view" },
  });

  expect(await audienceOf("agent", orgAgent.id)).toBe("org");
  expect(await audienceOf("agent", teamAgent.id)).toBe("team");
  expect(await audienceOf("skill", ownSkill.id)).toBe("personal");
  const policy = await ResourcePermissionPolicyModel.find({
    organizationId: org.id,
    resource: "skill",
    scope: sharedSkill.id,
  });
  expect(policy?.grants).toContainEqual({
    subject: { type: "user", id: reader.id },
    actions: ["read"],
  });
});
