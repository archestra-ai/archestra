import { SkillModel } from "@/models";
import { describe, expect, test } from "@/test";
import type { InsertSkill } from "@/types";
import type { ResourceVisibilityScope } from "@/types/visibility";

function skillInput(overrides: Partial<InsertSkill>): InsertSkill {
  return {
    organizationId: "org",
    authorId: null,
    name: "skill",
    description: "desc",
    content: "# body",
    metadata: {},
    sourceType: "manual",
    scope: "personal" as ResourceVisibilityScope,
    ...overrides,
  };
}

describe("SkillModel name uniqueness by scope", () => {
  test("two users can each own a personal skill with the same name", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const userA = await makeUser();
    const userB = await makeUser();

    const a = await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        authorId: userA.id,
        name: "notes",
        scope: "personal",
      }),
      files: [],
    });
    const b = await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        authorId: userB.id,
        name: "notes",
        scope: "personal",
      }),
      files: [],
    });

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  test("the same author cannot reuse a personal skill name", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();

    const first = await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        authorId: author.id,
        name: "notes",
        scope: "personal",
      }),
      files: [],
    });
    const second = await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        authorId: author.id,
        name: "notes",
        scope: "personal",
      }),
      files: [],
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test("a shared (org) name is unique across the organization", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const userA = await makeUser();
    const userB = await makeUser();

    const a = await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        authorId: userA.id,
        name: "shared",
        scope: "org",
      }),
      files: [],
    });
    const b = await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        authorId: userB.id,
        name: "shared",
        scope: "org",
      }),
      files: [],
    });

    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  test("a personal name and a shared name can coexist", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();

    const personal = await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        authorId: author.id,
        name: "dup",
        scope: "personal",
      }),
      files: [],
    });
    const org_ = await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        authorId: author.id,
        name: "dup",
        scope: "org",
      }),
      files: [],
    });

    expect(personal).not.toBeNull();
    expect(org_).not.toBeNull();
  });
});

describe("SkillModel.updateWithFiles team sync atomicity", () => {
  test("rolls back the scope change when a team assignment fails", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();

    const skill = await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        authorId: author.id,
        name: "to-promote",
        scope: "personal",
      }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    // moving to team scope with a non-existent team must fail the whole update
    await expect(
      SkillModel.updateWithFiles({
        id: skill.id,
        skill: { scope: "team" as ResourceVisibilityScope },
        teamIds: ["00000000-0000-0000-0000-000000000000"],
      }),
    ).rejects.toThrow();

    const after = await SkillModel.findById(skill.id);
    expect(after?.scope).toBe("personal");
  });
});

describe("SkillModel.findImportNameCollisions", () => {
  test("another user's personal skill of the same name is not a collision", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const importer = await makeUser();

    await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        authorId: owner.id,
        name: "notes",
        scope: "personal",
      }),
      files: [],
    });

    const collisions = await SkillModel.findImportNameCollisions({
      organizationId: org.id,
      userId: importer.id,
      names: ["notes"],
    });

    expect(collisions.has("notes")).toBe(false);
  });

  test("the importer's own personal skill of the same name is a collision", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const importer = await makeUser();

    await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        authorId: importer.id,
        name: "notes",
        scope: "personal",
      }),
      files: [],
    });

    const collisions = await SkillModel.findImportNameCollisions({
      organizationId: org.id,
      userId: importer.id,
      names: ["notes"],
    });

    expect(collisions.has("notes")).toBe(true);
  });

  test("a shared (org) skill is a collision regardless of who owns it", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const importer = await makeUser();

    await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        authorId: owner.id,
        name: "shared",
        scope: "org",
      }),
      files: [],
    });

    const collisions = await SkillModel.findImportNameCollisions({
      organizationId: org.id,
      userId: importer.id,
      names: ["shared"],
    });

    expect(collisions.has("shared")).toBe(true);
  });
});
