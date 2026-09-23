import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { EnvironmentModel } from "@/models";
import AgentExcludedSkillModel from "@/models/agent-excluded-skill";
import SkillModel from "@/models/skill";
import { describe, expect, test } from "@/test";
import type { Agent, InsertSkill, Skill } from "@/types";
import {
  explainAssignmentRejection,
  resolveExposedSkill,
  resolveExposedSkills,
} from "./agent-skill-resolution";

/**
 * Assign one skill to an agent, additively — the fixture equivalent of Custom
 * mode. A direct insert rather than the service, whose write-time validation is
 * exercised by the route tests; these tests are about what resolution exposes.
 */
async function assignSkill(params: { agentId: string; skillId: string }) {
  await db.insert(schema.agentSkillsTable).values(params).onConflictDoNothing();
}

async function makeSkill(
  organizationId: string,
  overrides: Partial<InsertSkill> = {},
  environmentIds: string[] = [],
): Promise<Skill> {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId,
      name: `skill-${crypto.randomUUID().slice(0, 8)}`,
      description: "A test skill",
      content: "# Instructions",
      scope: "org",
      latestVersion: 1,
      ...overrides,
    } as InsertSkill,
    files: [],
    environmentIds,
  });
  if (!skill) throw new Error("failed to create test skill");
  return skill;
}

/** A page wide enough that no fixture in this file can fill it. */
const ALL = 1_000;

async function exposedNames(agentId: string): Promise<string[]> {
  const exposed = await resolveExposedSkills({ agentId, limit: ALL });
  return (exposed?.skills ?? []).map((skill) => skill.name).sort();
}

test("Custom mode publishes exactly the assigned skills", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const assigned = await makeSkill(org.id, { name: "assigned" });
  await makeSkill(org.id, { name: "not-assigned" });

  await assignSkill({ agentId: agent.id, skillId: assigned.id });

  expect(await exposedNames(agent.id)).toEqual(["assigned"]);
});

test("Custom mode ignores the exclusion list, which only applies to Auto", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const skill = await makeSkill(org.id, { name: "assigned" });

  await assignSkill({ agentId: agent.id, skillId: skill.id });
  await AgentExcludedSkillModel.replaceExclusions({
    agentId: agent.id,
    skillIds: [skill.id],
  });

  expect(await exposedNames(agent.id)).toEqual(["assigned"]);
});

test("Auto mode publishes org-scoped skills and honours exclusions", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({
    organizationId: org.id,
    accessAllSkills: true,
  });
  await makeSkill(org.id, { name: "org-a", scope: "org" });
  const excluded = await makeSkill(org.id, { name: "org-b", scope: "org" });

  await AgentExcludedSkillModel.replaceExclusions({
    agentId: agent.id,
    skillIds: [excluded.id],
  });

  expect(await exposedNames(agent.id)).toEqual(["org-a"]);
});

test("Auto mode never publishes team skills, whoever is connecting", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  // A gateway token frequently carries no user, and when it does the principal
  // is the token's bound user rather than the connecting human — so resolving
  // team visibility here would leak one user's team skills to every holder of
  // the token. Auto is org-scope-only precisely to make that impossible.
  const org = await makeOrganization();
  const author = await makeUser({ email: "author@test.com" });
  const agent = await makeAgent({
    organizationId: org.id,
    accessAllSkills: true,
  });

  await makeSkill(org.id, { name: "org-skill", scope: "org" });
  await makeSkill(org.id, { name: "team-skill", scope: "team" });
  await makeSkill(org.id, {
    name: "personal-skill",
    scope: "personal",
    authorId: author.id,
  });

  expect(await exposedNames(agent.id)).toEqual(["org-skill"]);
});

test("an assigned personal skill is served on any gateway", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  // The assignment is the authority for personal skills like for every other
  // scope: only the author can create it (enforced at assignment time, where a
  // caller exists to check), and at serve time a gateway token frequently
  // carries no user to check against — so the read applies no scope gate.
  const org = await makeOrganization();
  const author = await makeUser({ email: "author@test.com" });
  const agent = await makeAgent({ organizationId: org.id });
  const personal = await makeSkill(org.id, {
    name: "personal-skill",
    scope: "personal",
    authorId: author.id,
  });

  await assignSkill({ agentId: agent.id, skillId: personal.id });

  expect(await exposedNames(agent.id)).toEqual(["personal-skill"]);
});

test("templated and agent-delegated skills are never published", async ({
  makeOrganization,
  makeAgent,
}) => {
  // A templated skill's bytes differ per activating user, so it has no stable
  // digest; a delegated skill hands off to an agent a client cannot reach.
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });

  const templated = await makeSkill(org.id, {
    name: "templated-skill",
    templated: true,
  });
  const delegated = await makeSkill(org.id, {
    name: "delegated-skill",
    agentName: "refund-processor",
  });
  const ordinary = await makeSkill(org.id, { name: "ordinary-skill" });

  for (const skill of [templated, delegated, ordinary]) {
    await assignSkill({ agentId: agent.id, skillId: skill.id });
  }

  expect(await exposedNames(agent.id)).toEqual(["ordinary-skill"]);
});

test("a skill whose name breaks the Agent Skills naming rules is never published", async ({
  makeOrganization,
  makeAgent,
}) => {
  // SEP-2640 requires the final URI segment to equal the frontmatter name, and
  // the Agent Skills spec constrains names to lowercase alphanumerics and
  // single hyphens — a name like "My Skill" has no conforming URI, so strict
  // hosts would refuse the entry. Withheld rather than published broken.
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });

  const nonConforming = await makeSkill(org.id, { name: "My Skill" });
  const conforming = await makeSkill(org.id, { name: "my-skill" });

  for (const skill of [nonConforming, conforming]) {
    await assignSkill({ agentId: agent.id, skillId: skill.id });
  }

  expect(await exposedNames(agent.id)).toEqual(["my-skill"]);
});

test("a soft-deleted skill drops off the gateway in Custom mode", async ({
  makeOrganization,
  makeAgent,
}) => {
  // Skill deletion is a soft delete that keeps the assignment row; the read
  // must filter it, or a deleted skill would stay published to token holders.
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const deleted = await makeSkill(org.id, { name: "deleted-skill" });
  const kept = await makeSkill(org.id, { name: "kept-skill" });

  for (const skill of [deleted, kept]) {
    await assignSkill({ agentId: agent.id, skillId: skill.id });
  }
  await SkillModel.delete(deleted.id);

  expect(await exposedNames(agent.id)).toEqual(["kept-skill"]);
});

test("Custom mode withholds a skill bound to another environment", async ({
  makeOrganization,
  makeAgent,
}) => {
  // Same rule as assigned tools: the assignment does not override environment
  // isolation, so a skill rebound elsewhere stops being served.
  const org = await makeOrganization();
  const production = await EnvironmentModel.create({
    organizationId: org.id,
    name: "production",
  });
  const staging = await EnvironmentModel.create({
    organizationId: org.id,
    name: "staging",
  });
  const agent = await makeAgent({
    organizationId: org.id,
    environmentId: production.id,
  });

  const inProduction = await makeSkill(org.id, { name: "in-production" }, [
    production.id,
  ]);
  const inStaging = await makeSkill(org.id, { name: "in-staging" }, [
    staging.id,
  ]);
  const unbound = await makeSkill(org.id, { name: "unbound" });

  for (const skill of [inProduction, inStaging, unbound]) {
    await assignSkill({ agentId: agent.id, skillId: skill.id });
  }

  // A skill with no environment assignments is visible everywhere.
  expect(await exposedNames(agent.id)).toEqual(["in-production", "unbound"]);
});

test("resolution returns null for an unknown agent", async () => {
  expect(
    await resolveExposedSkills({ agentId: crypto.randomUUID(), limit: ALL }),
  ).toBeNull();
  expect(
    await resolveExposedSkill({
      agentId: crypto.randomUUID(),
      name: "anything",
      authorId: null,
      callerUserId: null,
    }),
  ).toBeNull();
});

/**
 * The by-key path and the set path must agree exactly. They are separate
 * queries — one selects the org's catalog, the other one row — so nothing but a
 * test stops them drifting into publishing different sets. Every case below
 * asserts both directions: reachable through the listing implies reachable by
 * URI, and withheld from the listing implies unreachable by URI.
 */
async function expectPathsAgree(agentId: string, skills: Skill[]) {
  const exposed = await resolveExposedSkills({ agentId, limit: ALL });
  const exposedIds = new Set((exposed?.skills ?? []).map((skill) => skill.id));

  for (const skill of skills) {
    const byKey = await resolveExposedSkill({
      agentId,
      name: skill.name,
      // The address a listing gives the skill: its author, or bare when it has
      // none. A bare lookup resolves only among skills the caller can read.
      authorId: skill.authorId,
      callerUserId: skill.authorId,
    });
    expect(
      byKey && "skill" in byKey ? byKey.skill.id : null,
      `${skill.name} (${skill.scope}) disagreed between the set and by-key paths`,
    ).toBe(exposedIds.has(skill.id) ? skill.id : null);
  }
}

test("Auto mode resolves the same set by key as it lists", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const author = await makeUser({ email: "author@test.com" });
  const agent = await makeAgent({
    organizationId: org.id,
    accessAllSkills: true,
  });

  const listed = await makeSkill(org.id, { name: "listed", scope: "org" });
  const excluded = await makeSkill(org.id, { name: "excluded", scope: "org" });
  const team = await makeSkill(org.id, { name: "team-skill", scope: "team" });
  const personal = await makeSkill(org.id, {
    name: "personal-skill",
    scope: "personal",
    authorId: author.id,
  });
  const templated = await makeSkill(org.id, {
    name: "templated-skill",
    templated: true,
  });
  const badName = await makeSkill(org.id, { name: "Bad Name" });

  await AgentExcludedSkillModel.replaceExclusions({
    agentId: agent.id,
    skillIds: [excluded.id],
  });

  await expectPathsAgree(agent.id, [
    listed,
    excluded,
    team,
    personal,
    templated,
    badName,
  ]);
});

test("Custom mode resolves the same set by key as it lists", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const author = await makeUser({ email: "author@test.com" });
  const agent = await makeAgent({ organizationId: org.id });

  const assigned = await makeSkill(org.id, { name: "assigned", scope: "org" });
  const assignedTeam = await makeSkill(org.id, {
    name: "assigned-team",
    scope: "team",
    authorId: author.id,
  });
  const assignedPersonal = await makeSkill(org.id, {
    name: "assigned-personal",
    scope: "personal",
    authorId: author.id,
  });
  const unassigned = await makeSkill(org.id, { name: "unassigned" });

  for (const skill of [assigned, assignedTeam, assignedPersonal]) {
    await assignSkill({ agentId: agent.id, skillId: skill.id });
  }

  await expectPathsAgree(agent.id, [
    assigned,
    assignedTeam,
    assignedPersonal,
    unassigned,
  ]);
});

test("an author URI names exactly that author's skill of the name", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  // Names are unique per author, which is why the URI carries the author.
  // The by-key lookup has to honour it, or a gateway would serve one skill's
  // bytes under the other's URI.
  const org = await makeOrganization();
  const alice = await makeUser();
  const bob = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const alices = await makeSkill(org.id, {
    name: "refunds",
    authorId: alice.id,
  });
  const bobs = await makeSkill(org.id, { name: "refunds", authorId: bob.id });
  for (const skill of [alices, bobs]) {
    await assignSkill({ agentId: agent.id, skillId: skill.id });
  }

  for (const [author, expected] of [
    [alice, alices],
    [bob, bobs],
  ] as const) {
    const resolution = await resolveExposedSkill({
      agentId: agent.id,
      name: "refunds",
      authorId: author.id,
      callerUserId: null,
    });
    expect(resolution && "skill" in resolution && resolution.skill.id).toBe(
      expected.id,
    );
  }
});

test("a name is unique per author, not per organization", async ({
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const alice = await makeUser();
  const bob = await makeUser();
  await makeSkill(org.id, { name: "duplicated", authorId: alice.id });

  // Another author may reuse the name; the same author may not.
  await expect(
    makeSkill(org.id, { name: "duplicated", authorId: bob.id }),
  ).resolves.toBeTruthy();
  await expect(
    makeSkill(org.id, { name: "duplicated", authorId: alice.id }),
  ).rejects.toThrow();
});

describe("the bare skill://archestra/shared/<name> rule", () => {
  async function readGrant(params: {
    organizationId: string;
    skillId: string;
    userIds: string[];
  }) {
    await db
      .update(schema.resourcePermissionPoliciesTable)
      .set({
        grants: params.userIds.map((id) => ({
          subject: { type: "user" as const, id },
          actions: ["read" as const, "use" as const],
        })),
      })
      .where(
        and(
          eq(
            schema.resourcePermissionPoliciesTable.organizationId,
            params.organizationId,
          ),
          eq(schema.resourcePermissionPoliciesTable.resource, "skill"),
          eq(schema.resourcePermissionPoliciesTable.scope, params.skillId),
        ),
      );
  }

  async function setup({
    makeOrganization,
    makeAgent,
    makeUser,
    makeMember,
  }: {
    makeOrganization: () => Promise<{ id: string }>;
    makeAgent: (o: { organizationId: string }) => Promise<{ id: string }>;
    makeUser: () => Promise<{ id: string }>;
    makeMember: (
      userId: string,
      organizationId: string,
      o: { role: string },
    ) => Promise<unknown>;
  }) {
    const org = await makeOrganization();
    const [caller, alice, bob] = [
      await makeUser(),
      await makeUser(),
      await makeUser(),
    ];
    for (const user of [caller, alice, bob]) {
      await makeMember(user.id, org.id, { role: "member" });
    }
    const agent = await makeAgent({ organizationId: org.id });
    return { org, caller, alice, bob, agent };
  }

  const bare = (agentId: string, callerUserId: string | null) =>
    resolveExposedSkill({
      agentId,
      name: "refunds",
      authorId: null,
      callerUserId,
    });

  test("picks the caller's own skill first", async ({
    makeOrganization,
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const { org, caller, alice, agent } = await setup({
      makeOrganization,
      makeAgent,
      makeUser,
      makeMember,
    });
    const own = await makeSkill(org.id, {
      name: "refunds",
      authorId: caller.id,
    });
    const other = await makeSkill(org.id, {
      name: "refunds",
      authorId: alice.id,
    });
    for (const skill of [own, other]) {
      await assignSkill({ agentId: agent.id, skillId: skill.id });
      await readGrant({
        organizationId: org.id,
        skillId: skill.id,
        userIds: [caller.id],
      });
    }

    const resolution = await bare(agent.id, caller.id);
    expect(resolution && "skill" in resolution && resolution.skill.id).toBe(
      own.id,
    );
  });

  test("resolves the single match the caller can read, and never one the caller cannot", async ({
    makeOrganization,
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const { org, caller, alice, bob, agent } = await setup({
      makeOrganization,
      makeAgent,
      makeUser,
      makeMember,
    });
    const readable = await makeSkill(org.id, {
      name: "refunds",
      authorId: alice.id,
    });
    const unreadable = await makeSkill(org.id, {
      name: "refunds",
      authorId: bob.id,
    });
    for (const skill of [readable, unreadable]) {
      await assignSkill({ agentId: agent.id, skillId: skill.id });
    }
    await readGrant({
      organizationId: org.id,
      skillId: readable.id,
      userIds: [caller.id, alice.id],
    });
    await readGrant({
      organizationId: org.id,
      skillId: unreadable.id,
      userIds: [bob.id],
    });

    const resolution = await bare(agent.id, caller.id);
    expect(resolution && "skill" in resolution && resolution.skill.id).toBe(
      readable.id,
    );

    // Bob's skill is published on this gateway, but the caller cannot read
    // it: the bare rule does not reach it even when it is the only match.
    await readGrant({
      organizationId: org.id,
      skillId: readable.id,
      userIds: [alice.id],
    });
    expect(await bare(agent.id, caller.id)).toBeNull();
    // Its author form still reaches it: the gateway publishes it.
    const byAuthor = await resolveExposedSkill({
      agentId: agent.id,
      name: "refunds",
      authorId: bob.id,
      callerUserId: caller.id,
    });
    expect(byAuthor && "skill" in byAuthor && byAuthor.skill.id).toBe(
      unreadable.id,
    );
  });

  test("reports every readable match when none is the caller's own", async ({
    makeOrganization,
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const { org, caller, alice, bob, agent } = await setup({
      makeOrganization,
      makeAgent,
      makeUser,
      makeMember,
    });
    const skills = [
      await makeSkill(org.id, { name: "refunds", authorId: alice.id }),
      await makeSkill(org.id, { name: "refunds", authorId: bob.id }),
    ];
    for (const skill of skills) {
      await assignSkill({ agentId: agent.id, skillId: skill.id });
      await readGrant({
        organizationId: org.id,
        skillId: skill.id,
        userIds: [caller.id],
      });
    }

    const resolution = await bare(agent.id, caller.id);
    expect(
      resolution && "ambiguous" in resolution
        ? resolution.ambiguous.map((skill) => skill.id).sort()
        : null,
    ).toEqual(skills.map((skill) => skill.id).sort());
  });

  test("a caller with no user reaches only skills published to the organization", async ({
    makeOrganization,
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const { org, alice, agent } = await setup({
      makeOrganization,
      makeAgent,
      makeUser,
      makeMember,
    });
    const skill = await makeSkill(org.id, {
      name: "refunds",
      authorId: alice.id,
    });
    await assignSkill({ agentId: agent.id, skillId: skill.id });
    await readGrant({
      organizationId: org.id,
      skillId: skill.id,
      userIds: [alice.id],
    });

    expect(await bare(agent.id, null)).toBeNull();
  });
});

test("a skill in another organization is unreachable by key", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const otherOrg = await makeOrganization();
  const agent = await makeAgent({
    organizationId: org.id,
    accessAllSkills: true,
  });
  await makeSkill(otherOrg.id, { name: "their-skill", scope: "org" });

  expect(
    await resolveExposedSkill({
      agentId: agent.id,
      name: "their-skill",
      authorId: null,
      callerUserId: null,
    }),
  ).toBeNull();
});

// Publishing is a gateway surface. The editor was once offered on internal
// agents too, so an upgraded deployment can hold `agent_skills` rows — and an
// Auto flag — against a type that no longer has a screen to manage them.
// Resolution refuses them rather than serving a set nobody can see.
for (const agentType of ["agent", "llm_proxy"] as const) {
  test(`a ${agentType} serves nothing, even holding rows an earlier build let it store`, async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id, agentType });
    const stale = await makeSkill(org.id, { name: "stale-assignment" });
    await assignSkill({ agentId: agent.id, skillId: stale.id });

    expect(await exposedNames(agent.id)).toEqual([]);
    expect(
      await resolveExposedSkill({
        agentId: agent.id,
        name: "stale-assignment",
        authorId: null,
        callerUserId: null,
      }),
    ).toBeNull();
  });
}

test("a non-gateway agent publishes nothing in Auto mode either", async ({
  makeOrganization,
  makeAgent,
}) => {
  // Auto reads the org catalog rather than an assignment set, so it is the
  // path a stale `access_all_skills` flag would drag every organization skill
  // onto.
  const org = await makeOrganization();
  const agent = await makeAgent({
    organizationId: org.id,
    agentType: "agent",
    accessAllSkills: true,
  });
  await makeSkill(org.id, { name: "org-wide", scope: "org" });

  expect(await exposedNames(agent.id)).toEqual([]);
  expect(
    await resolveExposedSkill({
      agentId: agent.id,
      name: "org-wide",
      authorId: null,
      callerUserId: null,
    }),
  ).toBeNull();
});

test("assignment rejection explains each unpublishable case", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const sharedGateway = await makeAgent({ organizationId: org.id });

  const templated = await makeSkill(org.id, {
    name: "templated-skill",
    templated: true,
  });
  const delegated = await makeSkill(org.id, {
    name: "delegated-skill",
    agentName: "refund-processor",
  });
  const badName = await makeSkill(org.id, { name: "Bad Name" });
  const longDescription = await makeSkill(org.id, {
    name: "long-description-skill",
    description: "d".repeat(1025),
  });
  const longCompatibility = await makeSkill(org.id, {
    name: "long-compatibility-skill",
    compatibility: "c".repeat(501),
  });
  const ordinary = await makeSkill(org.id, { name: "ordinary-skill" });
  const elsewhere = await EnvironmentModel.create({
    organizationId: org.id,
    name: "elsewhere",
  });
  const otherEnvironment = await makeSkill(
    org.id,
    { name: "other-environment-skill" },
    [elsewhere.id],
  );

  const reject = (
    skill: Skill,
    skillEnvironmentIds: string[] = [],
    canPublish = true,
  ) =>
    explainAssignmentRejection({
      skill,
      agent: sharedGateway as Agent,
      canPublish,
      skillEnvironmentIds,
    });

  expect(reject(templated)).toMatch(/templated/i);
  expect(reject(delegated)).toMatch(/refund-processor/);
  // Publishing is decided by the caller's grant on the skill alone; the
  // author-only rule for personal skills applied only before conversion.
  expect(reject(ordinary, [], false)).toMatch(/manage permissions/i);
  expect(reject(badName)).toMatch(/Agent Skills/);
  expect(reject(longDescription)).toMatch(/description/i);
  expect(reject(longCompatibility)).toMatch(/compatibility/i);
  expect(reject(otherEnvironment, [elsewhere.id])).toMatch(/environment/i);
  expect(reject(ordinary)).toBeNull();
});
