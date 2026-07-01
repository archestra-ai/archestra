import { createHash } from "node:crypto";
import { withDbTransaction } from "@/database";
import { SkillModel, SkillShareLinkModel } from "@/models";
import { SKILL_SHARE_LINK_TOKEN_PREFIX } from "@/models/skill-share-link";
import { describe, expect, test } from "@/test";
import { deriveSkillShareLinkStatus, type SkillShareLink } from "@/types";

async function seedSkill(params: { organizationId: string; name: string }) {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId: params.organizationId,
      authorId: null,
      name: params.name,
      description: `${params.name} description`,
      content: `# ${params.name}`,
      metadata: {},
      sourceType: "manual",
      scope: "org",
    },
    files: [],
  });
  if (!skill) throw new Error("failed to seed skill");
  return skill;
}

describe("SkillShareLinkModel.create", () => {
  test("generates a token with the expected prefix and persists its hash", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const skill = await seedSkill({ organizationId: org.id, name: "alpha" });

    const { link, rawToken } = await SkillShareLinkModel.create({
      organizationId: org.id,
      createdByUserId: user.id,
      skillIds: [skill.id],
      marketplaceName: "org-12345678-skills",
      name: "Demo",
      expiresAt: null,
    });

    expect(rawToken.startsWith(SKILL_SHARE_LINK_TOKEN_PREFIX)).toBe(true);
    expect(rawToken.length).toBeGreaterThan(
      SKILL_SHARE_LINK_TOKEN_PREFIX.length,
    );
    expect(link.tokenStart).toBe(rawToken.slice(0, 22));
    expect(link.tokenHash).toBe(
      createHash("sha256").update(rawToken).digest("hex"),
    );
    expect(link.skills).toEqual([
      { id: skill.id, name: "alpha", description: "alpha description" },
    ]);
    expect(link.marketplaceName).toBe("org-12345678-skills");
    expect(link.revokedAt).toBeNull();
  });

  test("persists junction rows for every requested skill", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const a = await seedSkill({ organizationId: org.id, name: "a-skill" });
    const b = await seedSkill({ organizationId: org.id, name: "b-skill" });

    const { link } = await SkillShareLinkModel.create({
      organizationId: org.id,
      createdByUserId: user.id,
      skillIds: [a.id, b.id],
      marketplaceName: "org-12345678-skills",
    });

    const ids = link.skills.map((s) => s.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  test("rejects empty skillIds", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    await expect(
      SkillShareLinkModel.create({
        organizationId: org.id,
        createdByUserId: user.id,
        skillIds: [],
        marketplaceName: "org-12345678-skills",
      }),
    ).rejects.toThrow(/skillIds must be non-empty/);
  });
});

describe("SkillShareLinkModel.validate", () => {
  test("resolves a valid raw token to its link and skills", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const skill = await seedSkill({ organizationId: org.id, name: "valid" });

    const { rawToken } = await SkillShareLinkModel.create({
      organizationId: org.id,
      createdByUserId: user.id,
      skillIds: [skill.id],
      marketplaceName: "org-12345678-skills",
    });

    const result = await SkillShareLinkModel.validate({ rawToken });
    expect(result).not.toBeNull();
    expect(result?.skills.map((s) => s.id)).toEqual([skill.id]);
  });

  test("returns null for an unknown token", async () => {
    const result = await SkillShareLinkModel.validate({
      rawToken: `${SKILL_SHARE_LINK_TOKEN_PREFIX}deadbeefdeadbeefdeadbeefdeadbeef`,
    });
    expect(result).toBeNull();
  });

  test("returns null for a revoked link", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const skill = await seedSkill({
      organizationId: org.id,
      name: "revoked-skill",
    });

    const { link, rawToken } = await SkillShareLinkModel.create({
      organizationId: org.id,
      createdByUserId: user.id,
      skillIds: [skill.id],
      marketplaceName: "org-12345678-skills",
    });

    await SkillShareLinkModel.revoke({
      id: link.id,
      organizationId: org.id,
    });

    expect(await SkillShareLinkModel.validate({ rawToken })).toBeNull();
  });

  test("returns null for an expired link", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const skill = await seedSkill({
      organizationId: org.id,
      name: "expired-skill",
    });

    const { rawToken } = await SkillShareLinkModel.create({
      organizationId: org.id,
      createdByUserId: user.id,
      skillIds: [skill.id],
      marketplaceName: "org-12345678-skills",
      expiresAt: new Date(Date.now() - 1000),
    });

    expect(await SkillShareLinkModel.validate({ rawToken })).toBeNull();
  });
});

describe("SkillShareLinkModel.revoke", () => {
  test("is idempotent and preserves the original revokedAt", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const skill = await seedSkill({
      organizationId: org.id,
      name: "idempotent-skill",
    });

    const { link } = await SkillShareLinkModel.create({
      organizationId: org.id,
      createdByUserId: user.id,
      skillIds: [skill.id],
      marketplaceName: "org-12345678-skills",
    });

    const first = await SkillShareLinkModel.revoke({
      id: link.id,
      organizationId: org.id,
    });
    const firstRevokedAt = first?.revokedAt;
    expect(firstRevokedAt).toBeInstanceOf(Date);

    const second = await SkillShareLinkModel.revoke({
      id: link.id,
      organizationId: org.id,
    });
    expect(second?.revokedAt?.getTime()).toBe(firstRevokedAt?.getTime());
  });

  test("refuses to revoke links from a different organization", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, orgA.id);
    const skill = await seedSkill({ organizationId: orgA.id, name: "iso" });

    const { link } = await SkillShareLinkModel.create({
      organizationId: orgA.id,
      createdByUserId: user.id,
      skillIds: [skill.id],
      marketplaceName: "org-12345678-skills",
    });

    const cross = await SkillShareLinkModel.revoke({
      id: link.id,
      organizationId: orgB.id,
    });
    expect(cross).toBeNull();
  });
});

describe("SkillShareLinkModel.listByOrganization", () => {
  test("returns links with their skills attached, filtered by skillId when set", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const skillA = await seedSkill({ organizationId: org.id, name: "list-a" });
    const skillB = await seedSkill({ organizationId: org.id, name: "list-b" });

    const { link: linkA } = await SkillShareLinkModel.create({
      organizationId: org.id,
      createdByUserId: user.id,
      skillIds: [skillA.id],
      marketplaceName: "org-12345678-skills",
    });
    const { link: linkB } = await SkillShareLinkModel.create({
      organizationId: org.id,
      createdByUserId: user.id,
      skillIds: [skillB.id],
      marketplaceName: "org-12345678-skills",
    });

    const all = await SkillShareLinkModel.listByOrganization({
      organizationId: org.id,
    });
    expect(all.map((l) => l.id).sort()).toEqual([linkA.id, linkB.id].sort());

    const filtered = await SkillShareLinkModel.listByOrganization({
      organizationId: org.id,
      skillId: skillB.id,
    });
    expect(filtered.map((l) => l.id)).toEqual([linkB.id]);
  });
});

describe("deriveSkillShareLinkStatus", () => {
  const base: Pick<SkillShareLink, "revokedAt" | "expiresAt"> = {
    revokedAt: null,
    expiresAt: null,
  };
  const now = new Date("2026-05-26T00:00:00Z");

  test("active when neither revoked nor expired", () => {
    expect(deriveSkillShareLinkStatus(base, now)).toBe("active");
  });

  test("active when expiresAt is in the future", () => {
    expect(
      deriveSkillShareLinkStatus(
        { ...base, expiresAt: new Date("2026-12-31T00:00:00Z") },
        now,
      ),
    ).toBe("active");
  });

  test("expired when expiresAt is now or earlier", () => {
    expect(
      deriveSkillShareLinkStatus(
        { ...base, expiresAt: new Date("2026-01-01T00:00:00Z") },
        now,
      ),
    ).toBe("expired");
  });

  test("revoked takes precedence over expiry", () => {
    expect(
      deriveSkillShareLinkStatus(
        {
          revokedAt: new Date("2026-04-01T00:00:00Z"),
          expiresAt: new Date("2026-01-01T00:00:00Z"),
        },
        now,
      ),
    ).toBe("revoked");
  });
});

describe("SkillShareLinkModel.create with caller transaction", () => {
  test("commits with the caller's transaction and is queryable afterwards", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const skill = await seedSkill({ organizationId: org.id, name: "tx-ok" });

    const { link, rawToken } = await withDbTransaction((tx) =>
      SkillShareLinkModel.create({
        organizationId: org.id,
        createdByUserId: user.id,
        skillIds: [skill.id],
        marketplaceName: "org-tx-skills",
        tx,
      }),
    );

    expect(link.skills).toHaveLength(1);
    const validated = await SkillShareLinkModel.validate({ rawToken });
    expect(validated?.link.id).toBe(link.id);
  });

  test("rolls back with the caller's transaction (no orphaned link)", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const skill = await seedSkill({ organizationId: org.id, name: "tx-rb" });

    let rawToken = "";
    await expect(
      withDbTransaction(async (tx) => {
        const created = await SkillShareLinkModel.create({
          organizationId: org.id,
          createdByUserId: user.id,
          skillIds: [skill.id],
          marketplaceName: "org-tx-rollback-skills",
          tx,
        });
        rawToken = created.rawToken;
        throw new Error("render failed");
      }),
    ).rejects.toThrow("render failed");

    expect(await SkillShareLinkModel.validate({ rawToken })).toBeNull();
    expect(
      await SkillShareLinkModel.listByOrganization({
        organizationId: org.id,
      }),
    ).toEqual([]);
  });
});

describe("SkillShareLinkModel.revoke with caller transaction", () => {
  test("rolls back with the caller's transaction (link stays valid)", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const skill = await seedSkill({ organizationId: org.id, name: "rv-rb" });

    const { link, rawToken } = await SkillShareLinkModel.create({
      organizationId: org.id,
      createdByUserId: user.id,
      skillIds: [skill.id],
      marketplaceName: "org-revoke-rollback-skills",
    });

    // rotation revokes the old link and creates its replacement in one
    // transaction; if the replacement fails, the revoke must undo too
    await expect(
      withDbTransaction(async (tx) => {
        await SkillShareLinkModel.revoke({
          id: link.id,
          organizationId: org.id,
          tx,
        });
        throw new Error("replacement failed");
      }),
    ).rejects.toThrow("replacement failed");

    expect(await SkillShareLinkModel.validate({ rawToken })).not.toBeNull();
  });
});
