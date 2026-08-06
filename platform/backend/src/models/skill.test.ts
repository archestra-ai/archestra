import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { SkillModel, SkillUsageEventModel, SkillVersionModel } from "@/models";
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

  test("listForSkill is scoped to the skill's organization", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    const scoped = await SkillVersionModel.listForSkill({
      skillId: skill.id,
      organizationId: org.id,
      pagination: { limit: 10, offset: 0 },
    });
    expect(scoped.pagination.total).toBe(1);

    const foreign = await SkillVersionModel.listForSkill({
      skillId: skill.id,
      organizationId: otherOrg.id,
      pagination: { limit: 10, offset: 0 },
    });
    expect(foreign.pagination.total).toBe(0);
    expect(foreign.data).toEqual([]);
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

    SkillModel.recordUsage({ skillId: skill.id, userId: null });
    SkillModel.recordUsage({ skillId: skill.id, userId: null });
    await drainBackgroundWork();

    const used = await SkillModel.findById(skill.id);
    expect(used?.usageCount).toBe(2);
    expect(used?.lastUsedAt).not.toBeNull();
    // a usage tick is not an edit
    expect(used?.updatedAt).toEqual(skill.updatedAt);
  });

  test("appends one usage event per activation, attributed to the user", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "logged" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    SkillModel.recordUsage({ skillId: skill.id, userId: user.id });
    // token contexts without an attributable user still log the activation
    SkillModel.recordUsage({ skillId: skill.id, userId: null });
    await drainBackgroundWork();

    const events = await db
      .select()
      .from(schema.skillUsageEventsTable)
      .where(eq(schema.skillUsageEventsTable.skillId, skill.id));
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.userId).sort()).toEqual([user.id, null].sort());
  });

  test("getUsageStatistics buckets per user and day with resolved names", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const alice = await makeUser({ name: "Alice" });
    const bob = await makeUser({ name: "Bob" });
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "stats" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    SkillModel.recordUsage({ skillId: skill.id, userId: alice.id });
    SkillModel.recordUsage({ skillId: skill.id, userId: alice.id });
    SkillModel.recordUsage({ skillId: skill.id, userId: bob.id });
    // an id with no users row (e.g. a service-account token) keeps name null
    SkillModel.recordUsage({ skillId: skill.id, userId: "service-account:x" });
    await drainBackgroundWork();

    const stats = await SkillUsageEventModel.getUsageStatistics({
      skillId: skill.id,
      since: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    // most-used first; the two single-use entries tie in unspecified order
    expect(stats.users).toHaveLength(3);
    expect(stats.users[0]).toEqual({
      userId: alice.id,
      name: "Alice",
      total: 2,
    });
    expect(stats.users).toContainEqual({
      userId: bob.id,
      name: "Bob",
      total: 1,
    });
    expect(stats.users).toContainEqual({
      userId: "service-account:x",
      name: null,
      total: 1,
    });
    const today = new Date().toISOString().slice(0, 10);
    expect(stats.daily).toContainEqual({
      date: today,
      userId: alice.id,
      count: 2,
    });

    // events before the window are excluded
    const empty = await SkillUsageEventModel.getUsageStatistics({
      skillId: skill.id,
      since: new Date(Date.now() + 60_000),
    });
    expect(empty.users).toEqual([]);
    expect(empty.daily).toEqual([]);
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

    SkillModel.recordUsage({ skillId: skills[1].id, userId: null });
    SkillModel.recordUsage({ skillId: skills[1].id, userId: null });
    SkillModel.recordUsage({ skillId: skills[2].id, userId: null });
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

  test("excludes soft-deleted skills from the due scan", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        name: "deleted-synced",
        githubSyncInterval: "15m",
      }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    expect((await SkillModel.findDueGithubSyncs()).map((s) => s.id)).toContain(
      skill.id,
    );

    await SkillModel.delete(skill.id);

    expect(
      (await SkillModel.findDueGithubSyncs()).map((s) => s.id),
    ).not.toContain(skill.id);
  });
});

describe("SkillModel soft delete", () => {
  test("delete() hides the row from reads but keeps it in the table", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "doomed" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    expect(await SkillModel.delete(skill.id)).toBe(true);

    expect(await SkillModel.findById(skill.id)).toBeNull();
    expect(await SkillModel.findByIds([skill.id])).toEqual([]);
    expect(await SkillModel.findAllByName(org.id, "doomed")).toEqual([]);
    expect(
      (await SkillModel.findByOrganization({ organizationId: org.id })).map(
        (s) => s.id,
      ),
    ).not.toContain(skill.id);
    expect(
      await SkillModel.countByOrganization({ organizationId: org.id }),
    ).toBe(0);

    // the row itself survives, stamped with deletedAt.
    const [raw] = await db
      .select()
      .from(schema.skillsTable)
      .where(eq(schema.skillsTable.id, skill.id));
    expect(raw?.deletedAt).toBeInstanceOf(Date);
  });

  test("delete() is idempotent", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "once" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    expect(await SkillModel.delete(skill.id)).toBe(true);
    expect(await SkillModel.delete(skill.id)).toBe(false);
  });

  test("a deleted skill frees its name for re-use", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const first = await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        name: "notes",
        scope: "org",
      }),
      files: [],
    });
    if (!first) throw new Error("seed failed");
    await SkillModel.delete(first.id);

    // the freed name is no longer an import collision either.
    expect(
      await SkillModel.findImportNameCollisions({
        organizationId: org.id,
        userId: "any-user",
        names: ["notes"],
      }),
    ).toEqual(new Set());

    const second = await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        name: "notes",
        scope: "org",
      }),
      files: [],
    });
    expect(second).not.toBeNull();
  });

  test("updateWithFiles refuses a soft-deleted skill", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "frozen" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");
    await SkillModel.delete(skill.id);

    const updated = await SkillModel.updateWithFiles({
      id: skill.id,
      skill: { description: "new description" },
    });
    expect(updated).toBeNull();
  });

  test("findByIdForAudit still returns a soft-deleted skill", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "audited" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");
    await SkillModel.delete(skill.id);

    const audit = await SkillModel.findByIdForAudit(skill.id, org.id);
    expect(audit).not.toBeNull();
    expect(audit?.name).toBe("audited");
  });
});

describe("SkillModel restore + status filter", () => {
  test("restore() clears deletedAt and is idempotent", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "revivable" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");
    await SkillModel.delete(skill.id);
    expect(await SkillModel.findById(skill.id)).toBeNull();

    expect(await SkillModel.restore(skill.id)).toBe(true);
    expect((await SkillModel.findById(skill.id))?.id).toBe(skill.id);
    // already active → a second restore reports no transition
    expect(await SkillModel.restore(skill.id)).toBe(false);
  });

  test("findDeletedById returns only soft-deleted rows, scoped to the org", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "trashed" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    // an active row is invisible to the deleted lookup
    expect(await SkillModel.findDeletedById(skill.id, org.id)).toBeNull();

    await SkillModel.delete(skill.id);
    expect((await SkillModel.findDeletedById(skill.id, org.id))?.id).toBe(
      skill.id,
    );
    // wrong org does not see it
    expect(await SkillModel.findDeletedById(skill.id, "other-org")).toBeNull();
  });

  test("getRestoreConflictMessage flags a reclaimed name for shared and personal scopes", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();

    // shared (org/team) name reclaimed by another active shared skill
    const shared = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "dup", scope: "org" }),
      files: [],
    });
    if (!shared) throw new Error("seed failed");
    await SkillModel.delete(shared.id);
    const sharedDeleted = await SkillModel.findDeletedById(shared.id, org.id);
    if (!sharedDeleted) throw new Error("deleted lookup failed");
    // nothing has taken the name yet
    expect(
      await SkillModel.getRestoreConflictMessage(sharedDeleted),
    ).toBeNull();
    await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "dup", scope: "team" }),
      files: [],
    });
    expect(await SkillModel.getRestoreConflictMessage(sharedDeleted)).toContain(
      "shared skill",
    );

    // personal name reclaimed by the same author
    const personal = await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        name: "mine",
        scope: "personal",
        authorId: author.id,
      }),
      files: [],
    });
    if (!personal) throw new Error("seed failed");
    await SkillModel.delete(personal.id);
    const personalDeleted = await SkillModel.findDeletedById(
      personal.id,
      org.id,
    );
    if (!personalDeleted) throw new Error("deleted lookup failed");
    await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        name: "mine",
        scope: "personal",
        authorId: author.id,
      }),
      files: [],
    });
    expect(
      await SkillModel.getRestoreConflictMessage(personalDeleted),
    ).toContain("personal skill");
  });

  test("status=deleted lists only the trash and never leaks into source repos", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const active = await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        name: "kept",
        scope: "org",
        sourceRef: "acme/kept@main:SKILL.md",
      }),
      files: [],
    });
    const trashed = await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        name: "gone",
        scope: "org",
        sourceRef: "acme/gone@main:SKILL.md",
      }),
      files: [],
    });
    if (!active || !trashed) throw new Error("seed failed");
    await SkillModel.delete(trashed.id);

    // trash view: only the deleted skill
    expect(
      (
        await SkillModel.findByOrganization({
          organizationId: org.id,
          status: "deleted",
        })
      ).map((s) => s.id),
    ).toEqual([trashed.id]);
    expect(
      await SkillModel.countByOrganization({
        organizationId: org.id,
        status: "deleted",
      }),
    ).toBe(1);

    // default (active) view: only the surviving skill
    expect(
      (await SkillModel.findByOrganization({ organizationId: org.id })).map(
        (s) => s.id,
      ),
    ).toEqual([active.id]);

    // the source-repo filter must never enumerate a deleted skill's repo (C1)
    expect(
      await SkillModel.findDistinctSourceRepos({ organizationId: org.id }),
    ).toEqual(["acme/kept"]);
  });
});
