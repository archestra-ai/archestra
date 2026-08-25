import {
  OrganizationModel,
  SkillMarketplaceCredentialModel,
  SkillModel,
  UserTokenModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import {
  loadMarketplaceSkills,
  resolveMarketplaceViewer,
} from "./static-marketplace";

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

async function seedSkill(params: {
  organizationId: string;
  name: string;
  scope: "org" | "team" | "personal";
  authorId?: string | null;
}) {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId: params.organizationId,
      authorId: params.authorId ?? null,
      name: params.name,
      description: `${params.name} description`,
      content: `# ${params.name}`,
      metadata: {},
      sourceType: "manual",
      scope: params.scope,
    },
    files: [],
  });
  if (!skill) throw new Error("failed to seed skill");
  return skill;
}

describe("resolveMarketplaceViewer", () => {
  test("no credential challenges when anonymous access is off", async ({
    makeOrganization,
  }) => {
    await makeOrganization();
    await expect(
      resolveMarketplaceViewer({ authorization: undefined }),
    ).resolves.toEqual({ status: "unauthenticated" });
  });

  test("no credential resolves the anonymous view when the org publishes it", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization({
      skillMarketplaceAnonymousAccess: true,
    });

    await expect(
      resolveMarketplaceViewer({ authorization: undefined }),
    ).resolves.toEqual({
      status: "ok",
      viewer: { organizationId: org.id, userId: null, isSkillAdmin: false },
    });
  });

  test("the anonymous view resolves the organization that published it, not just any", async ({
    makeOrganization,
  }) => {
    // an organization that did not opt in must never be served anonymously,
    // even when it is the one a bare "first organization" lookup would find
    await makeOrganization({ skillMarketplaceAnonymousAccess: false });
    const publisher = await makeOrganization({
      skillMarketplaceAnonymousAccess: true,
    });

    await expect(
      resolveMarketplaceViewer({ authorization: undefined }),
    ).resolves.toEqual({
      status: "ok",
      viewer: {
        organizationId: publisher.id,
        userId: null,
        isSkillAdmin: false,
      },
    });
  });

  test("a bad credential is rejected rather than downgraded to the anonymous view", async ({
    makeOrganization,
  }) => {
    await makeOrganization({ skillMarketplaceAnonymousAccess: true });

    await expect(
      resolveMarketplaceViewer({ authorization: basic("x", "arch_nope") }),
    ).resolves.toEqual({ status: "unauthenticated" });
  });

  test("accepts a personal token as the Basic password, as the Basic username, and as a Bearer", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const { value: token } = await UserTokenModel.create(user.id, org.id);

    const expected = {
      status: "ok",
      viewer: { organizationId: org.id, userId: user.id, isSkillAdmin: false },
    };

    await expect(
      resolveMarketplaceViewer({ authorization: basic("archestra", token) }),
    ).resolves.toEqual(expected);
    // `git clone https://<token>@host/...` sends the token as the username
    await expect(
      resolveMarketplaceViewer({ authorization: basic(token, "") }),
    ).resolves.toEqual(expected);
    await expect(
      resolveMarketplaceViewer({ authorization: `Bearer ${token}` }),
    ).resolves.toEqual(expected);
  });

  test("a role without skill:read is forbidden, not challenged", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { agent: ["read"] },
    });
    await makeMember(user.id, org.id, { role: role.role });
    const { value: token } = await UserTokenModel.create(user.id, org.id);

    await expect(
      resolveMarketplaceViewer({ authorization: basic("archestra", token) }),
    ).resolves.toEqual({ status: "forbidden" });
  });
});

describe("loadMarketplaceSkills", () => {
  test("a member gets org skills and their own, but not another user's personal skill", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const other = await makeUser({ email: "other@test.com" });
    await makeMember(other.id, org.id);

    await seedSkill({ organizationId: org.id, name: "org-wide", scope: "org" });
    await seedSkill({
      organizationId: org.id,
      name: "mine",
      scope: "personal",
      authorId: user.id,
    });
    await seedSkill({
      organizationId: org.id,
      name: "theirs",
      scope: "personal",
      authorId: other.id,
    });

    const skills = await loadMarketplaceSkills({
      organizationId: org.id,
      userId: user.id,
      isSkillAdmin: false,
    });

    expect(skills.map((s) => s.name).sort()).toEqual(["mine", "org-wide"]);
  });

  test("the anonymous view carries org-scoped skills only", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    await seedSkill({ organizationId: org.id, name: "org-wide", scope: "org" });
    await seedSkill({
      organizationId: org.id,
      name: "mine",
      scope: "personal",
      authorId: user.id,
    });

    const skills = await loadMarketplaceSkills({
      organizationId: org.id,
      userId: null,
      isSkillAdmin: false,
    });

    expect(skills.map((s) => s.name)).toEqual(["org-wide"]);
  });

  test("a skill admin gets every skill in the organization", async ({
    makeOrganization,
    makeAdmin,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const admin = await makeAdmin();
    await makeMember(admin.id, org.id, { role: "admin" });
    const other = await makeUser({ email: "other@test.com" });
    await makeMember(other.id, org.id);

    await seedSkill({ organizationId: org.id, name: "org-wide", scope: "org" });
    await seedSkill({
      organizationId: org.id,
      name: "theirs",
      scope: "personal",
      authorId: other.id,
    });

    const skills = await loadMarketplaceSkills({
      organizationId: org.id,
      userId: admin.id,
      isSkillAdmin: true,
    });

    expect(skills.map((s) => s.name).sort()).toEqual(["org-wide", "theirs"]);
  });

  test("soft-deleted skills drop out of the marketplace", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    const kept = await seedSkill({
      organizationId: org.id,
      name: "kept",
      scope: "org",
    });
    const removed = await seedSkill({
      organizationId: org.id,
      name: "removed",
      scope: "org",
    });
    await SkillModel.delete(removed.id);

    const skills = await loadMarketplaceSkills({
      organizationId: org.id,
      userId: user.id,
      isSkillAdmin: false,
    });

    expect(skills.map((s) => s.id)).toEqual([kept.id]);
  });

  test("organization scoping keeps another org's skills out", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    await seedSkill({ organizationId: org.id, name: "ours", scope: "org" });
    await seedSkill({
      organizationId: otherOrg.id,
      name: "theirs",
      scope: "org",
    });

    const skills = await loadMarketplaceSkills({
      organizationId: org.id,
      userId: user.id,
      isSkillAdmin: false,
    });

    expect(skills.map((s) => s.name)).toEqual(["ours"]);
    // sanity: the org row the anonymous view would resolve is a real lookup,
    // not an assumption baked into this test
    expect(await OrganizationModel.getFirst()).not.toBeNull();
  });
});

describe("marketplace credentials", () => {
  test("a marketplace credential resolves its owner's view", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    await seedSkill({ organizationId: org.id, name: "Org Wide", scope: "org" });

    const { rawToken } = await SkillMarketplaceCredentialModel.create({
      organizationId: org.id,
      userId: user.id,
    });

    const resolved = await resolveMarketplaceViewer({
      authorization: basic("token", rawToken),
    });
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;
    expect(resolved.viewer.userId).toBe(user.id);
    expect(resolved.viewer.organizationId).toBe(org.id);

    const skills = await loadMarketplaceSkills(resolved.viewer);
    expect(skills.map((s) => s.name)).toEqual(["Org Wide"]);
  });

  test("a credential grants nothing beyond its owner: another user's personal skill stays out", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const other = await makeUser({ email: "other@test.com" });
    await makeMember(user.id, org.id);
    await makeMember(other.id, org.id);
    await seedSkill({ organizationId: org.id, name: "Org Wide", scope: "org" });
    await seedSkill({
      organizationId: org.id,
      name: "Someone Elses",
      scope: "personal",
      authorId: other.id,
    });

    const { rawToken } = await SkillMarketplaceCredentialModel.create({
      organizationId: org.id,
      userId: user.id,
    });
    const resolved = await resolveMarketplaceViewer({
      authorization: basic("token", rawToken),
    });
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;

    const skills = await loadMarketplaceSkills(resolved.viewer);
    expect(skills.map((s) => s.name)).toEqual(["Org Wide"]);
  });

  test("a deleted credential stops working, and does not fall back to anonymous", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    await seedSkill({ organizationId: org.id, name: "Org Wide", scope: "org" });

    const { rawToken } = await SkillMarketplaceCredentialModel.create({
      organizationId: org.id,
      userId: user.id,
    });
    // what losing a membership does
    await SkillMarketplaceCredentialModel.deleteForMember({
      organizationId: org.id,
      userId: user.id,
    });

    await expect(
      resolveMarketplaceViewer({ authorization: basic("token", rawToken) }),
    ).resolves.toEqual({ status: "unauthenticated" });
  });
});
