import { SkillModel, SkillTeamModel } from "@/models";
import MemberModel from "@/models/member";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import skillRoutes from "./skill.routes";
import { MANIFEST, useSkillRouteTestApp } from "./skill.test-helpers";

/**
 * Sharing a skill with named people: user grants given at create, and edits
 * that must leave them alone.
 */
describe("per-user skill sharing", () => {
  const ctx = useSkillRouteTestApp(skillRoutes);

  test("creating a skill with a user grant shares it with that user", async ({
    makeUser,
    makeMember,
  }) => {
    const grantee = await makeUser({ email: "grantee@test.com" });
    await makeMember(grantee.id, ctx.organizationId);

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: MANIFEST,
        initialGrants: [shareWith(grantee.id)],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(await userGrantIds(response.json().id)).toEqual([grantee.id]);
  });

  test("a grantee reaches the skill the author kept personal", async ({
    makeUser,
    makeMember,
  }) => {
    const grantee = await makeUser({ email: "reader@test.com" });
    await makeMember(grantee.id, ctx.organizationId);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: MANIFEST,
        initialGrants: [shareWith(grantee.id)],
      },
    });
    const skillId = created.json().id;

    // The point of the grant: access without widening the scope.
    const skill = await SkillModel.findById(skillId);
    if (!skill) throw new Error("skill not found");
    expect(
      await SkillTeamModel.userHasSkillAccess({
        skill,
        userId: grantee.id,
        organizationId: ctx.organizationId,
      }),
    ).toBe(true);
  });

  test("retired userIds updates are ignored, leaving grants alone", async ({
    makeUser,
    makeMember,
  }) => {
    const first = await makeUser({ email: "first@test.com" });
    await makeMember(first.id, ctx.organizationId);
    const second = await makeUser({ email: "second@test.com" });
    await makeMember(second.id, ctx.organizationId);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: MANIFEST,
        initialGrants: [shareWith(first.id)],
      },
    });
    const skillId = created.json().id;

    // `userIds` left the update body with the rest of the legacy sharing
    // surface, so a caller still sending it changes nothing.
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${skillId}`,
      payload: { content: MANIFEST, userIds: [second.id] },
    });

    expect(response.statusCode).toBe(200);
    expect(await userGrantIds(skillId)).toEqual([first.id]);
  });

  test("a content-only edit leaves existing grants alone", async ({
    makeUser,
    makeMember,
  }) => {
    const grantee = await makeUser({ email: "kept@test.com" });
    await makeMember(grantee.id, ctx.organizationId);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: MANIFEST,
        initialGrants: [shareWith(grantee.id)],
      },
    });
    const skillId = created.json().id;

    // A content-only save must not quietly revoke everyone.
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${skillId}`,
      payload: { content: MANIFEST },
    });

    expect(response.statusCode).toBe(200);
    expect(await userGrantIds(skillId)).toEqual([grantee.id]);
  });

  test("retired visibility writes are ignored and preserve existing grants", async ({
    makeUser,
    makeMember,
  }) => {
    const grantee = await makeUser({ email: "dropped@test.com" });
    await makeMember(grantee.id, ctx.organizationId);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: MANIFEST,
        initialGrants: [shareWith(grantee.id)],
      },
    });
    const skillId = created.json().id;
    await MemberModel.updateRole(ctx.user.id, ctx.organizationId, "admin");

    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${skillId}`,
      payload: { content: MANIFEST, scope: "org" },
    });

    expect(response.statusCode).toBe(200);
    expect((await SkillModel.findById(skillId))?.scope).toBe("personal");
    expect(await userGrantIds(skillId)).toEqual([grantee.id]);
  });
});

/** A user grant at the `use` preset, as the create form sends it. */
function shareWith(userId: string) {
  return {
    subject: { type: "user" as const, id: userId },
    actions: ["read" as const, "use" as const],
  };
}

/** The users a skill's permission policy grants, other than its author. */
async function userGrantIds(skillId: string): Promise<string[]> {
  const skill = await SkillModel.findById(skillId);
  if (!skill) throw new Error("skill not found");
  const policy = await ResourcePermissionPolicyModel.find({
    organizationId: skill.organizationId,
    resource: "skill",
    scope: skillId,
  });
  return (policy?.grants ?? [])
    .filter(
      (grant) =>
        grant.subject.type === "user" && grant.subject.id !== skill.authorId,
    )
    .map((grant) => grant.subject.id);
}
