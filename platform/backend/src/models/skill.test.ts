import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { SkillModel, SkillVersionModel } from "@/models";
import { describe, expect, test } from "@/test";
import type { InsertSkill } from "@/types";
import type { ResourceVisibilityScope } from "@/types/visibility";
import { drainBackgroundWork } from "@/utils/background-work";

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

describe("SkillModel immutable versioning", () => {
  test("createWithFiles writes version 1 with the body and files", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, content: "# v1 body" }),
      files: [{ path: "references/a.md", content: "# A", kind: "reference" }],
    });
    if (!skill) throw new Error("seed failed");

    expect(skill.latestVersion).toBe(1);
    const v1 = await SkillVersionModel.findBySkillAndVersion(skill.id, 1);
    expect(v1?.content).toBe("# v1 body");
    const files = await SkillVersionModel.findFiles(v1?.id ?? "");
    expect(files.map((f) => f.path)).toEqual(["references/a.md"]);
  });

  test("updateWithFiles forks a new version only when the payload changes", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, content: "# original" }),
      files: [{ path: "references/a.md", content: "# A", kind: "reference" }],
    });
    if (!skill) throw new Error("seed failed");

    // metadata-only edit with the identical body + files: no new version.
    const unchanged = await SkillModel.updateWithFiles({
      id: skill.id,
      skill: { description: "new description", content: "# original" },
      files: [{ path: "references/a.md", content: "# A", kind: "reference" }],
    });
    expect(unchanged?.latestVersion).toBe(1);

    // a body change forks version 2.
    const edited = await SkillModel.updateWithFiles({
      id: skill.id,
      skill: { content: "# edited" },
    });
    expect(edited?.latestVersion).toBe(2);
    const v2 = await SkillVersionModel.findBySkillAndVersion(skill.id, 2);
    expect(v2?.content).toBe("# edited");
    // version 1 is immutable and still readable.
    const v1 = await SkillVersionModel.findBySkillAndVersion(skill.id, 1);
    expect(v1?.content).toBe("# original");
  });

  test("updateWithFiles forks when only the resource files change", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, content: "# body" }),
      files: [{ path: "references/a.md", content: "# A", kind: "reference" }],
    });
    if (!skill) throw new Error("seed failed");

    const edited = await SkillModel.updateWithFiles({
      id: skill.id,
      skill: { content: "# body" },
      files: [
        { path: "references/a.md", content: "# A v2", kind: "reference" },
      ],
    });
    expect(edited?.latestVersion).toBe(2);
    const v2 = await SkillVersionModel.findBySkillAndVersion(skill.id, 2);
    const files = await SkillVersionModel.findFiles(v2?.id ?? "");
    expect(files.map((f) => f.content)).toEqual(["# A v2"]);
  });
});

describe("SkillModel.recordUsage", () => {
  test("increments usageCount and stamps lastUsedAt without touching updatedAt", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "counted" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");
    expect(skill.usageCount).toBe(0);
    expect(skill.lastUsedAt).toBeNull();

    SkillModel.recordUsage(skill.id);
    SkillModel.recordUsage(skill.id);
    await drainBackgroundWork();

    const used = await SkillModel.findById(skill.id);
    expect(used?.usageCount).toBe(2);
    expect(used?.lastUsedAt).not.toBeNull();
    // a usage tick is not an edit
    expect(used?.updatedAt).toEqual(skill.updatedAt);
  });

  test("default list order is most-used first", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const names = ["alpha", "beta", "gamma"];
    const skills = [];
    for (const name of names) {
      const skill = await SkillModel.createWithFiles({
        skill: skillInput({ organizationId: org.id, name }),
        files: [],
      });
      if (!skill) throw new Error("seed failed");
      skills.push(skill);
    }

    SkillModel.recordUsage(skills[1].id);
    SkillModel.recordUsage(skills[1].id);
    SkillModel.recordUsage(skills[2].id);
    await drainBackgroundWork();

    const byUsage = await SkillModel.findByOrganization({
      organizationId: org.id,
    });
    // never-used skills tie on 0 and fall back to newest-first
    expect(byUsage.map((s) => s.name)).toEqual(["beta", "gamma", "alpha"]);

    const byName = await SkillModel.findByOrganization({
      organizationId: org.id,
      sorting: { sortBy: "name", sortDirection: "asc" },
    });
    expect(byName.map((s) => s.name)).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("SkillModel.findDueGithubSyncs", () => {
  test("returns synced skills past their interval; never-synced are always due", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const seed = (name: string, overrides: Partial<InsertSkill>) =>
      SkillModel.createWithFiles({
        skill: skillInput({ organizationId: org.id, name, ...overrides }),
        files: [],
      });

    const neverSynced = await seed("never-synced", {
      githubSyncInterval: "15m",
    });
    const overdue = await seed("overdue", { githubSyncInterval: "15m" });
    const fresh = await seed("fresh", { githubSyncInterval: "1d" });
    await seed("disconnected", {});
    if (!neverSynced || !overdue || !fresh) throw new Error("seed failed");

    // overdue: last synced an hour ago with a 15m interval; fresh: just now.
    await SkillModel.markGithubSyncResult(overdue.id, null);
    await db
      .update(schema.skillsTable)
      .set({ lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(schema.skillsTable.id, overdue.id));
    await SkillModel.markGithubSyncResult(fresh.id, null);

    const due = await SkillModel.findDueGithubSyncs();
    expect(due.map((s) => s.name).sort()).toEqual(["never-synced", "overdue"]);
  });

  test("setGithubSync(null) disconnects and clears sync fields", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        name: "to-disconnect",
        githubSyncInterval: "1h",
        githubSyncRef: "main",
      }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");
    await SkillModel.markGithubSyncResult(skill.id, "boom");

    const changed = await SkillModel.setGithubSync(skill.id, {
      interval: "15m",
    });
    expect(changed?.githubSyncInterval).toBe("15m");

    const disconnected = await SkillModel.setGithubSync(skill.id, null);
    expect(disconnected?.githubSyncInterval).toBeNull();
    expect(disconnected?.githubSyncRef).toBeNull();
    expect(disconnected?.githubAppConfigId).toBeNull();
    expect(disconnected?.githubPatId).toBeNull();
    expect(disconnected?.lastSyncError).toBeNull();
  });
});
