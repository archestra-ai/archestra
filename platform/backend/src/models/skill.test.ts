import {
  isSpecCompliantSkillCompatibility,
  isSpecCompliantSkillDescription,
  isSpecCompliantSkillName,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  ServiceAccountModel,
  SkillFileModel,
  SkillModel,
  SkillUsageEventModel,
  SkillVersionModel,
  UserModel,
} from "@/models";
import { computeFileDigest } from "@/skills/skill-manifest-serializer";
import {
  hasPublishableFilePathSet,
  isPublishableSkillFilePath,
} from "@/skills/validation";
import { describe, expect, test } from "@/test";
import type { InsertSkill, Skill } from "@/types";
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

    // an identical re-save — same frontmatter, body, and files: no new version.
    const unchanged = await SkillModel.updateWithFiles({
      id: skill.id,
      skill: { description: skill.description, content: "# original" },
      files: [{ path: "references/a.md", content: "# A", kind: "reference" }],
    });
    expect(unchanged?.latestVersion).toBe(1);

    // a frontmatter-only edit forks nothing: versions snapshot the body and
    // files, and neither moved. It does refresh what the gateway publishes,
    // which lives on the skill row itself.
    const redescribed = await SkillModel.updateWithFiles({
      id: skill.id,
      skill: { description: "new description" },
    });
    expect(redescribed?.latestVersion).toBe(1);
    expect(redescribed?.frontmatterBlob).toContain("new description");
    expect(redescribed?.digest).not.toBe(skill.digest);

    // a body change forks.
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

  test("records the session and injected context size that make an activation costable", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "costable" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    SkillModel.recordUsage({
      skillId: skill.id,
      userId: user.id,
      sessionId: "conversation-7",
      contextTokens: 1_234,
    });
    // A caller that cannot measure the block still records the activation.
    SkillModel.recordUsage({ skillId: skill.id, userId: user.id });
    await drainBackgroundWork();

    const events = await db
      .select()
      .from(schema.skillUsageEventsTable)
      .where(eq(schema.skillUsageEventsTable.skillId, skill.id));
    expect(events).toHaveLength(2);
    const measured = events.find((e) => e.contextTokens !== null);
    expect(measured?.sessionId).toBe("conversation-7");
    expect(measured?.contextTokens).toBe(1_234);
    const unmeasured = events.find((e) => e.contextTokens === null);
    expect(unmeasured?.sessionId).toBeNull();
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
    await drainBackgroundWork();

    const stats = await SkillUsageEventModel.getUsageStatistics({
      skillId: skill.id,
      since: new Date(Date.now() - 24 * 60 * 60 * 1000),
      organizationId: org.id,
    });

    expect(stats.users).toHaveLength(2);
    expect(stats.users[0]).toEqual({
      userId: alice.id,
      name: "Alice",
      kind: "user",
      total: 2,
    });
    expect(stats.users).toContainEqual({
      userId: bob.id,
      name: "Bob",
      kind: "user",
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
      organizationId: org.id,
    });
    expect(empty.users).toEqual([]);
    expect(empty.daily).toEqual([]);
  });

  test("getUsageStatistics resolves service accounts and keeps deleted ids tellable apart", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const ghost = await makeUser({ name: "Ghost" });
    const serviceAccount = await ServiceAccountModel.create({
      organizationId: org.id,
      name: "Nightly sync",
      role: MEMBER_ROLE_NAME,
      createdBy: null,
    });
    const foreign = await ServiceAccountModel.create({
      organizationId: other.id,
      name: "Someone else's runner",
      role: MEMBER_ROLE_NAME,
      createdBy: null,
    });
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "kinds" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    SkillModel.recordUsage({
      skillId: skill.id,
      userId: `service-account:${serviceAccount.id}`,
    });
    // another organization's account must not leak its name in here
    SkillModel.recordUsage({
      skillId: skill.id,
      userId: `service-account:${foreign.id}`,
    });
    // a synthetic id whose suffix is not a uuid must not blow up the lookup
    SkillModel.recordUsage({ skillId: skill.id, userId: "service-account:x" });
    SkillModel.recordUsage({ skillId: skill.id, userId: ghost.id });
    SkillModel.recordUsage({ skillId: skill.id, userId: null });
    await drainBackgroundWork();
    await UserModel.delete(ghost.id);

    const stats = await SkillUsageEventModel.getUsageStatistics({
      skillId: skill.id,
      since: new Date(Date.now() - 24 * 60 * 60 * 1000),
      organizationId: org.id,
    });

    const byId = new Map(stats.users.map((row) => [row.userId, row]));
    expect(byId.get(`service-account:${serviceAccount.id}`)).toEqual({
      userId: `service-account:${serviceAccount.id}`,
      name: "Nightly sync",
      kind: "service_account",
      total: 1,
    });
    // an unresolvable id still reports what it addressed, so the caller can say
    // "deleted service account" rather than a bare "unknown"
    expect(byId.get(`service-account:${foreign.id}`)).toEqual({
      userId: `service-account:${foreign.id}`,
      name: null,
      kind: "service_account",
      total: 1,
    });
    expect(byId.get("service-account:x")).toEqual({
      userId: "service-account:x",
      name: null,
      kind: "service_account",
      total: 1,
    });
    expect(byId.get(ghost.id)).toEqual({
      userId: ghost.id,
      name: null,
      kind: "user",
      total: 1,
    });
    expect(byId.get(null)).toEqual({
      userId: null,
      name: null,
      kind: "unattributed",
      total: 1,
    });
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

describe("publication artifact fills", () => {
  test("fills a whole batch of legacy rows without touching updatedAt", async ({
    makeOrganization,
  }) => {
    // Filling a derived column is not an edit, so `updatedAt` must survive it —
    // otherwise the first gateway listing would reorder every skill in the UI's
    // recently-changed views.
    const org = await makeOrganization();
    const skills: Skill[] = [];
    for (const name of ["alpha", "bravo", "charlie"]) {
      const skill = await SkillModel.createWithFiles({
        skill: skillInput({ organizationId: org.id, name }),
        files: [],
      });
      if (!skill) throw new Error("seed failed");
      skills.push(skill);
    }
    await db
      .update(schema.skillsTable)
      .set({ frontmatterBlob: null, digest: null })
      .where(eq(schema.skillsTable.organizationId, org.id));
    // Baseline read after that update, which stamps `updatedAt` itself — the
    // fill is what must not.
    const updatedAtBefore = new Map(
      (
        await db
          .select()
          .from(schema.skillsTable)
          .where(eq(schema.skillsTable.organizationId, org.id))
      ).map((row) => [row.id, row.updatedAt]),
    );

    await SkillModel.fillPublicationArtifacts(
      skills.map((skill) => ({
        id: skill.id,
        frontmatterBlob: `name: "${skill.name}"\n`,
        digest: `sha256:${"0".repeat(63)}${skills.indexOf(skill)}`,
      })),
    );

    const rows = await db
      .select()
      .from(schema.skillsTable)
      .where(eq(schema.skillsTable.organizationId, org.id));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const seeded = skills.find((skill) => skill.id === row.id);
      if (!seeded) throw new Error("row vanished");
      expect(row.frontmatterBlob).toBe(`name: "${seeded.name}"\n`);
      expect(row.digest).toMatch(/^sha256:0{63}\d$/);
      expect(row.updatedAt).toEqual(updatedAtBefore.get(row.id));
    }
  });

  test("leaves a digest an edit wrote in between alone", async ({
    makeOrganization,
  }) => {
    // The fill races an ordinary edit: whoever wrote a digest already covered
    // bytes this caller may no longer be holding, so the IS NULL guard has to
    // make the fill a no-op rather than publish a stale hash.
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "raced" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    await SkillModel.fillPublicationArtifacts([
      {
        id: skill.id,
        frontmatterBlob: "name: stale\n",
        digest: `sha256:${"f".repeat(64)}`,
      },
    ]);

    const [row] = await db
      .select()
      .from(schema.skillsTable)
      .where(eq(schema.skillsTable.id, skill.id));
    expect(row?.digest).toBe(skill.digest);
    expect(row?.frontmatterBlob).toBe(skill.frontmatterBlob);
  });

  test("fills a legacy row whose blob is missing but whose digest is not", async ({
    makeOrganization,
  }) => {
    // The read path recomputes when EITHER half is missing, so the persisting
    // UPDATE has to accept the same rows. Guarding on `digest IS NULL` alone
    // would leave this row recomputing on every read and never saving.
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "half-filled" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    // Only the blob is cleared. This touches no column the publication digest
    // covers, so the invalidation trigger leaves `digest` standing.
    await db
      .update(schema.skillsTable)
      .set({ frontmatterBlob: null })
      .where(eq(schema.skillsTable.id, skill.id));

    await SkillModel.fillPublicationArtifacts([
      {
        id: skill.id,
        frontmatterBlob: "name: refilled\n",
        digest: `sha256:${"a".repeat(64)}`,
      },
    ]);

    const [row] = await db
      .select()
      .from(schema.skillsTable)
      .where(eq(schema.skillsTable.id, skill.id));
    expect(row?.frontmatterBlob).toBe("name: refilled\n");
  });
});

describe("skill_files digest invalidation trigger", () => {
  async function fileRows(skillId: string) {
    const rows = await db
      .select()
      .from(schema.skillFilesTable)
      .where(eq(schema.skillFilesTable.skillId, skillId));
    return new Map(rows.map((row) => [row.path, row]));
  }

  test("derives every file digest from the bytes written", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "with-files" }),
      files: [
        { path: "a.md", content: "# A", kind: "reference", encoding: "utf8" },
        {
          path: "logo.png",
          content: "iVBORw0KGgo=",
          kind: "asset",
          encoding: "base64",
        },
      ],
    });
    if (!skill) throw new Error("seed failed");

    const rows = await fileRows(skill.id);
    expect(rows.get("a.md")?.digest).toBe(
      computeFileDigest({ content: "# A", encoding: "utf8" }),
    );
    // Base64 assets are digested over the DECODED bytes, so the value a client
    // verifies covers what it actually receives.
    expect(rows.get("logo.png")?.digest).toBe(
      computeFileDigest({ content: "iVBORw0KGgo=", encoding: "base64" }),
    );
  });

  test("invalidates the digest when content moves without a fresh one", async ({
    makeOrganization,
  }) => {
    // The database never computes a digest (the application is the single
    // producer — Postgres and Node disagree on non-canonical base64); it only
    // proves staleness. A write that moves the bytes without refreshing the
    // digest resets it, so a file can never advertise a digest over bytes it
    // does not have.
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "stale-guard" }),
      files: [
        { path: "a.md", content: "# A", kind: "reference", encoding: "utf8" },
      ],
    });
    if (!skill) throw new Error("seed failed");
    const truth = computeFileDigest({ content: "# A", encoding: "utf8" });
    expect((await fileRows(skill.id)).get("a.md")?.digest).toBe(truth);

    // Content moved, digest not refreshed → invalidated, not recomputed. The
    // row is withheld from publication until a model write or the backfill
    // restores the pair.
    await db
      .update(schema.skillFilesTable)
      .set({ content: "# B" })
      .where(eq(schema.skillFilesTable.skillId, skill.id));
    expect((await fileRows(skill.id)).get("a.md")?.digest).toBeNull();

    // Content and digest moved together (what every model write does) → the
    // supplied pair stands.
    const refreshed = computeFileDigest({ content: "# C", encoding: "utf8" });
    await db
      .update(schema.skillFilesTable)
      .set({ content: "# C", digest: refreshed })
      .where(eq(schema.skillFilesTable.skillId, skill.id));
    expect((await fileRows(skill.id)).get("a.md")?.digest).toBe(refreshed);
  });

  test("fillDigests restores an invalidated row without clobbering a fresh write", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "backfillable" }),
      files: [
        { path: "a.md", content: "# A", kind: "reference", encoding: "utf8" },
      ],
    });
    if (!skill) throw new Error("seed failed");
    const row = (await fileRows(skill.id)).get("a.md");
    const truth = computeFileDigest({ content: "# A", encoding: "utf8" });

    // Simulate a pre-0407 row: digest cleared directly (content unchanged).
    await db
      .update(schema.skillFilesTable)
      .set({ digest: null })
      .where(eq(schema.skillFilesTable.skillId, skill.id));

    // The backfill's write path restores it — and the UPDATE it issues must
    // not re-trip the invalidation trigger (content is unchanged).
    await SkillFileModel.fillDigests([{ id: row?.id ?? "", digest: truth }]);
    expect((await fileRows(skill.id)).get("a.md")?.digest).toBe(truth);

    // IS NULL-guarded: a second fill with a stale value cannot overwrite it.
    await SkillFileModel.fillDigests([
      { id: row?.id ?? "", digest: `sha256:${"1".repeat(64)}` },
    ]);
    expect((await fileRows(skill.id)).get("a.md")?.digest).toBe(truth);
  });
});

/**
 * The publication surface decides "can a `skill://` URI name this file path?"
 * twice — in SQL so `skills/list` can page under a LIMIT, and in TypeScript for
 * every path that addresses one skill. Two expressions of one rule drift unless
 * something holds them together, and drift here is not cosmetic: a path the two
 * disagree about is a skill listed but unreadable, or readable but unlisted.
 *
 * So both verdicts are taken over one table of paths, and compared.
 */
describe("publishable file paths: SQL and TypeScript agree", () => {
  const PATHS = [
    // Nameable.
    "a.md",
    "references/FORMS.md",
    "scripts/nested/deep/run.py",
    "...md",
    "..hidden.md",
    "a/...",
    "file with spaces.md",
    "100%.md",
    "a#b?c.md",
    // Not nameable: an empty segment, or a `.`/`..` segment.
    "",
    "/leading.md",
    "trailing.md/",
    "docs//doubled.md",
    "./here.md",
    "../up.md",
    "a/./b.md",
    "a/../b.md",
    ".",
    "..",
    "a/.",
    "a/..",
    "/",
  ];

  test("over every path shape either expression can meet", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const byPath = new Map<string, string>();

    for (const [index, path] of PATHS.entries()) {
      const skill = await SkillModel.createWithFiles({
        skill: skillInput({
          organizationId: org.id,
          name: `path-case-${String(index).padStart(2, "0")}`,
          scope: "org",
        }),
        files: [
          { path, content: "x", kind: "reference", encoding: "utf8" as const },
        ],
      });
      if (!skill) throw new Error(`seed failed for ${JSON.stringify(path)}`);
      byPath.set(path, skill.id);
    }

    // The SQL verdict, read through the query that actually carries it.
    const listed = await SkillModel.findOrgScopedInEnvironment({
      organizationId: org.id,
      environmentId: null,
      excludedForAgentId: crypto.randomUUID(),
      limit: PATHS.length + 1,
    });
    const listedIds = new Set(listed.map((skill) => skill.id));

    for (const path of PATHS) {
      expect(
        listedIds.has(byPath.get(path) ?? ""),
        `SQL and isPublishableSkillFilePath disagreed about ${JSON.stringify(path)}`,
      ).toBe(isPublishableSkillFilePath(path));
    }
  });
});

/**
 * The name gate, the third expression of the same idea — SEP-2640 hosts refuse
 * an entry whose URI segment breaks the Agent Skills naming rules, so a name
 * the SQL admits and the TypeScript rejects is a row fetched, withheld, and
 * logged as drift, on a page that quietly comes back short.
 *
 * One caveat this test cannot cover: `[a-z]` is a collation-dependent range in
 * Postgres, and PGlite is not running the glibc locale a deployment runs. It
 * pins that the two expressions agree, not that they agree under production
 * collation — which is why the predicate forces `COLLATE "C"` rather than
 * trusting the database's default.
 */
describe("spec-compliant skill names: SQL and TypeScript agree", () => {
  const NAMES = [
    // Compliant: lowercase alphanumeric runs joined by single hyphens.
    "quarterly-close",
    "a",
    "a1",
    "1",
    "pdf-processing-v2",
    "a".repeat(64),
    // Not compliant.
    "Quarterly-Close",
    "café",
    "naïve-plan",
    "a--b",
    "-leading",
    "trailing-",
    "under_score",
    "with space",
    "dot.name",
    "a".repeat(65),
  ];

  test("over every name shape either expression can meet", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const byName = new Map<string, string>();

    for (const name of NAMES) {
      const skill = await SkillModel.createWithFiles({
        skill: skillInput({ organizationId: org.id, name, scope: "org" }),
        files: [],
      });
      if (!skill) throw new Error(`seed failed for ${JSON.stringify(name)}`);
      byName.set(name, skill.id);
    }

    const listed = await SkillModel.findOrgScopedInEnvironment({
      organizationId: org.id,
      environmentId: null,
      excludedForAgentId: crypto.randomUUID(),
      limit: NAMES.length + 1,
    });
    const listedIds = new Set(listed.map((skill) => skill.id));

    for (const name of NAMES) {
      expect(
        listedIds.has(byName.get(name) ?? ""),
        `SQL and isSpecCompliantSkillName disagreed about ${JSON.stringify(name)}`,
      ).toBe(isSpecCompliantSkillName(name));
    }
  });
});

/**
 * The frontmatter length gates, same shape as the name gate above: Agent
 * Skills bounds `description` to 1-1024 characters and `compatibility` to 500,
 * and a SEP-2640 host refuses an entry that exceeds them — so a value the SQL
 * admits and the TypeScript rejects is a row fetched, withheld, and logged as
 * drift.
 *
 * The astral rows are the ones that can actually drift: `char_length` counts
 * code points, `String.prototype.length` counts UTF-16 units, and a
 * surrogate-pair emoji weighs 1 against the first and 2 against the second.
 * The TypeScript twins spread into code points precisely so both sides agree;
 * these rows pin that.
 */
describe("spec-compliant skill field lengths: SQL and TypeScript agree", () => {
  const DESCRIPTIONS = [
    // Within bounds, including exactly at the limit — in code points, twice
    // over the limit in UTF-16 units.
    "does the thing",
    "d".repeat(1024),
    "🙂".repeat(1024),
    // Out of bounds: empty (the field is required) and one over.
    "",
    "d".repeat(1025),
    `${"🙂".repeat(1024)}!`,
  ];
  const COMPATIBILITIES = [
    // Absent and empty publish identically: the serializer omits a falsy
    // compatibility, so neither can make a manifest non-conformant.
    null,
    "",
    "c".repeat(500),
    "🙂".repeat(500),
    // Out of bounds.
    "c".repeat(501),
  ];

  test("over description and compatibility shapes", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rows: Array<{
      id: string;
      exposable: boolean;
      label: string;
    }> = [];

    for (const description of DESCRIPTIONS) {
      const skill = await SkillModel.createWithFiles({
        skill: skillInput({
          organizationId: org.id,
          name: `desc-${rows.length}`,
          description,
          scope: "org",
        }),
        files: [],
      });
      if (!skill) throw new Error("seed failed for a description shape");
      rows.push({
        id: skill.id,
        exposable: isSpecCompliantSkillDescription(description),
        label: `description of ${[...description].length} code points`,
      });
    }
    for (const compatibility of COMPATIBILITIES) {
      const skill = await SkillModel.createWithFiles({
        skill: skillInput({
          organizationId: org.id,
          name: `compat-${rows.length}`,
          compatibility,
          scope: "org",
        }),
        files: [],
      });
      if (!skill) throw new Error("seed failed for a compatibility shape");
      rows.push({
        id: skill.id,
        exposable: isSpecCompliantSkillCompatibility(compatibility),
        label: `compatibility of ${[...(compatibility ?? "")].length} code points`,
      });
    }

    const listed = await SkillModel.findOrgScopedInEnvironment({
      organizationId: org.id,
      environmentId: null,
      excludedForAgentId: crypto.randomUUID(),
      limit: rows.length + 1,
    });
    const listedIds = new Set(listed.map((skill) => skill.id));

    for (const row of rows) {
      expect(
        listedIds.has(row.id),
        `SQL and the TypeScript twin disagreed about a ${row.label}`,
      ).toBe(row.exposable);
    }
  });
});

/**
 * The set-level half of the same rule: no stored path may be a directory
 * another path sits in. Every path in such a skill is individually nameable,
 * so the per-path gate above cannot see it — and published, the collision
 * names one URI as both a file and the directory above it, which no host can
 * materialize.
 *
 * Same shape as the per-path table, for the same reason: the SQL and the
 * TypeScript are two expressions of one rule.
 */
describe("colliding file paths: SQL and TypeScript agree", () => {
  const PATH_SETS: string[][] = [
    // Fine: siblings, nesting, and names that merely share a prefix.
    [],
    ["a.md"],
    ["templates/eu.md", "templates/us.md"],
    ["docs/guide.md", "docs/deep/guide.md"],
    ["template.md", "templates/eu.md"],
    // Colliding: one path is a directory the other sits in.
    ["templates", "templates/eu.md"],
    ["templates/eu.md", "templates"],
    ["a/b", "a/b/c.md"],
    ["a", "a/b/c.md"],
    // `_` and `%` are LIKE wildcards; a prefix compare must not treat them as
    // matching anything, or these would be withheld for resembling a pair.
    ["a_b", "axb/c.md"],
    ["a%b", "axxb/c.md"],
  ];

  test("over every path set either expression can meet", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const bySet = new Map<number, string>();

    for (const [index, paths] of PATH_SETS.entries()) {
      const skill = await SkillModel.createWithFiles({
        skill: skillInput({
          organizationId: org.id,
          name: `collide-case-${String(index).padStart(2, "0")}`,
          scope: "org",
        }),
        files: paths.map((path) => ({
          path,
          content: "x",
          kind: "reference" as const,
          encoding: "utf8" as const,
        })),
      });
      if (!skill) throw new Error(`seed failed for set ${index}`);
      bySet.set(index, skill.id);
    }

    const listed = await SkillModel.findOrgScopedInEnvironment({
      organizationId: org.id,
      environmentId: null,
      excludedForAgentId: crypto.randomUUID(),
      limit: PATH_SETS.length + 1,
    });
    const listedIds = new Set(listed.map((skill) => skill.id));

    for (const [index, paths] of PATH_SETS.entries()) {
      expect(
        listedIds.has(bySet.get(index) ?? ""),
        `SQL and hasPublishableFilePathSet disagreed about ${JSON.stringify(paths)}`,
      ).toBe(hasPublishableFilePathSet(paths));
    }
  });
});

describe("SkillModel.findManifestSourceById", () => {
  test("takes the published blob and the body it wraps in one read", async ({
    makeOrganization,
  }) => {
    // The pairing is the point: a manifest composed from a blob read at one
    // moment and a body read at another is bytes that were never committed, and
    // so matches no digest this platform has advertised. Both halves come from
    // here or the tear is back.
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId: org.id, name: "one-read" }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    const source = await SkillModel.findManifestSourceById(skill.id);
    expect(source?.content).toBe(skill.content);
    expect(source?.frontmatterBlob).toBe(skill.frontmatterBlob);
    expect(source?.digest).toBe(skill.digest);
  });

  test("carries the fields a nulled blob has to be rebuilt from", async ({
    makeOrganization,
  }) => {
    // A row predating the columns — or one the invalidation trigger reset — is
    // recomposed from its frontmatter fields. Those must ride along on the same
    // read, or the rebuild reintroduces the very tear the single read removes.
    const org = await makeOrganization();
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({
        organizationId: org.id,
        name: "rebuildable",
        license: "MIT",
      }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");
    await db
      .update(schema.skillsTable)
      .set({ frontmatterBlob: null, digest: null })
      .where(eq(schema.skillsTable.id, skill.id));

    const source = await SkillModel.findManifestSourceById(skill.id);
    expect(source?.frontmatterBlob).toBeNull();
    expect(source?.name).toBe("rebuildable");
    expect(source?.description).toBe("desc");
    expect(source?.license).toBe("MIT");
    expect(source?.content).toBe("# body");
  });

  test("answers null for a row that no longer exists", async () => {
    expect(await SkillModel.findManifestSourceById(crypto.randomUUID())).toBe(
      null,
    );
  });
});

describe("skills publication invalidation trigger", () => {
  async function readSkill(id: string) {
    const [row] = await db
      .select()
      .from(schema.skillsTable)
      .where(eq(schema.skillsTable.id, id));
    return row;
  }

  async function seed(organizationId: string, name: string) {
    const skill = await SkillModel.createWithFiles({
      skill: skillInput({ organizationId, name }),
      files: [],
    });
    if (!skill) throw new Error("seed failed");
    return skill;
  }

  test("a write that moves published bytes without a fresh digest clears both", async ({
    makeOrganization,
  }) => {
    // Stands in for any future write path that changes covered content and
    // forgets to recompute. The database refuses to keep serving the old
    // digest; the read path recomputes on next publish.
    const org = await makeOrganization();
    const skill = await seed(org.id, "invalidated");
    expect(skill.digest).not.toBeNull();

    await db
      .update(schema.skillsTable)
      .set({ content: "# rewritten behind the model's back" })
      .where(eq(schema.skillsTable.id, skill.id));

    const row = await readSkill(skill.id);
    expect(row?.digest).toBeNull();
    expect(row?.frontmatterBlob).toBeNull();
  });

  test("a write that supplies a fresh digest is left alone", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const skill = await seed(org.id, "kept");

    const updated = await SkillModel.updateWithFiles({
      id: skill.id,
      skill: { content: "# edited through the model" },
    });

    expect(updated?.digest).not.toBeNull();
    expect(updated?.frontmatterBlob).not.toBeNull();
    expect(updated?.digest).not.toBe(skill.digest);
    expect((await readSkill(skill.id))?.digest).toBe(updated?.digest);
  });

  test("bookkeeping writes do not invalidate the published artifacts", async ({
    makeOrganization,
  }) => {
    // Usage ticks and sync stamps touch no covered column. If they invalidated,
    // every activation would churn the digest a host already approved.
    const org = await makeOrganization();
    const skill = await seed(org.id, "bookkept");

    SkillModel.recordUsage({ skillId: skill.id, userId: null });
    await drainBackgroundWork();
    await SkillModel.markGithubSyncResult(skill.id, null);

    const row = await readSkill(skill.id);
    expect(row?.digest).toBe(skill.digest);
    expect(row?.frontmatterBlob).toBe(skill.frontmatterBlob);
  });

  test("the read path's own fill does not trigger invalidation", async ({
    makeOrganization,
  }) => {
    // The fill writes the very columns the trigger guards. It must read as a
    // repair, not an edit, or a legacy row could never be filled at all.
    const org = await makeOrganization();
    const skill = await seed(org.id, "self-filling");

    await db
      .update(schema.skillsTable)
      .set({ content: "# moved on" })
      .where(eq(schema.skillsTable.id, skill.id));
    expect((await readSkill(skill.id))?.digest).toBeNull();

    await SkillModel.fillPublicationArtifacts([
      {
        id: skill.id,
        frontmatterBlob: "name: self-filling\n",
        digest: `sha256:${"b".repeat(64)}`,
      },
    ]);

    const row = await readSkill(skill.id);
    expect(row?.digest).toBe(`sha256:${"b".repeat(64)}`);
    expect(row?.frontmatterBlob).toBe("name: self-filling\n");
  });
});
