import { describe, expect, it } from "vitest";
import {
  type GatewayLike,
  getPersonalSkillPublishWarning,
  getSkillPublishability,
  type SkillLike,
} from "./agent-skills-editor.utils";

const orgSkill: SkillLike = { name: "org-skill", scope: "org" };
const gateway: GatewayLike = {};
const currentUserId = "user-1";

function publishability(
  skill: SkillLike,
  overrides: Partial<{
    gateway: GatewayLike | null;
    currentUserId: string | null;
  }> = {},
) {
  return getSkillPublishability({
    skill,
    gateway,
    currentUserId,
    ...overrides,
  });
}

describe("getSkillPublishability", () => {
  it("allows an ordinary org skill", () => {
    expect(publishability(orgSkill)).toEqual({
      publishable: true,
      reason: null,
    });
  });

  it("rejects a templated skill", () => {
    const result = publishability({ ...orgSkill, templated: true });
    expect(result.publishable).toBe(false);
    expect(result.reason).toMatch(/templated/i);
  });

  it("rejects an agent-delegated skill and names the agent", () => {
    const result = publishability({
      ...orgSkill,
      agentName: "refund-processor",
    });
    expect(result.publishable).toBe(false);
    expect(result.reason).toContain("refund-processor");
  });

  it("allows the caller's own personal skill on any gateway", () => {
    expect(
      publishability({
        name: "my-skill",
        scope: "personal",
        authorId: currentUserId,
      }).publishable,
    ).toBe(true);
  });

  it("rejects another author's personal skill", () => {
    const result = publishability({
      name: "my-skill",
      scope: "personal",
      authorId: "user-2",
    });
    expect(result.publishable).toBe(false);
    expect(result.reason).toMatch(/personal/i);
  });

  it("fails closed while the session is unknown", () => {
    expect(
      publishability(
        { name: "my-skill", scope: "personal", authorId: currentUserId },
        { currentUserId: null },
      ).publishable,
    ).toBe(false);
  });

  it("fails closed for a personal skill with no recorded author", () => {
    // `null === null` must never read as authorship.
    expect(
      publishability(
        { name: "my-skill", scope: "personal", authorId: null },
        { currentUserId: null },
      ).publishable,
    ).toBe(false);
  });

  it("allows a team skill", () => {
    expect(
      publishability({ name: "team-skill", scope: "team" }).publishable,
    ).toBe(true);
  });

  it("rejects a skill whose name breaks the Agent Skills naming rules", () => {
    const result = publishability({ ...orgSkill, name: "My Skill" });
    expect(result.publishable).toBe(false);
    expect(result.reason).toMatch(/rename/i);
  });
});

describe("getPersonalSkillPublishWarning", () => {
  it("discloses the token-holder audience for a personal skill", () => {
    expect(
      getPersonalSkillPublishWarning({
        name: "my-skill",
        scope: "personal",
        authorId: currentUserId,
      }),
    ).toMatch(/token/i);
  });

  it("stays silent for shared skills", () => {
    expect(getPersonalSkillPublishWarning(orgSkill)).toBeNull();
  });
});

describe("getSkillPublishability environment gate", () => {
  const inProd: GatewayLike = { environmentId: "env-prod" };

  it("allows a skill restricted to the gateway's own environment", () => {
    expect(
      publishability(
        { ...orgSkill, environments: [{ id: "env-prod" }] },
        { gateway: inProd },
      ).publishable,
    ).toBe(true);
  });

  it("rejects a skill restricted to other environments", () => {
    const result = publishability(
      { ...orgSkill, environments: [{ id: "env-staging" }] },
      { gateway: inProd },
    );
    expect(result.publishable).toBe(false);
    expect(result.reason).toMatch(/environment/i);
  });

  it("allows an unrestricted skill anywhere, since no environment excludes it", () => {
    expect(
      publishability({ ...orgSkill, environments: [] }, { gateway: inProd })
        .publishable,
    ).toBe(true);
  });

  it("rejects an environment-restricted skill on a gateway with no environment", () => {
    expect(
      publishability(
        { ...orgSkill, environments: [{ id: "env-prod" }] },
        { gateway: { environmentId: null } },
      ).publishable,
    ).toBe(false);
  });

  it("exempts built-in skills from the gate", () => {
    expect(
      publishability(
        {
          ...orgSkill,
          sourceType: "built_in",
          environments: [{ id: "env-staging" }],
        },
        { gateway: inProd },
      ).publishable,
    ).toBe(true);
  });

  it("fails open for a row carrying no environments at all", () => {
    // The assignment endpoints return rows without environment data, and those
    // rows are the already-assigned skills. Disabling them on a guess would
    // strand chips an admin needs in order to unpublish them.
    expect(publishability(orgSkill, { gateway: inProd }).publishable).toBe(
      true,
    );
  });
});
