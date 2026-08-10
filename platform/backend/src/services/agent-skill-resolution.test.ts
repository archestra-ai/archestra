import db, { schema } from "@/database";
import { EnvironmentModel } from "@/models";
import AgentExcludedSkillModel from "@/models/agent-excluded-skill";
import SkillModel from "@/models/skill";
import { expect, test } from "@/test";
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
      authorId: skill.scope === "personal" ? skill.authorId : null,
    });
    expect(
      byKey?.id ?? null,
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

test("a name shared by a personal and an org skill resolves by scope", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  // Names are unique only within a visibility, which is why the URI carries a
  // scope segment. The by-key lookup has to honour it, or a gateway would
  // serve one skill's bytes under the other's URI.
  const org = await makeOrganization();
  const author = await makeUser({ email: "author@test.com" });
  const agent = await makeAgent({ organizationId: org.id });

  const shared = await makeSkill(org.id, { name: "refunds", scope: "org" });
  const personal = await makeSkill(org.id, {
    name: "refunds",
    scope: "personal",
    authorId: author.id,
  });
  for (const skill of [shared, personal]) {
    await assignSkill({ agentId: agent.id, skillId: skill.id });
  }

  const bySharedUri = await resolveExposedSkill({
    agentId: agent.id,
    name: "refunds",
    authorId: null,
  });
  const byPersonalUri = await resolveExposedSkill({
    agentId: agent.id,
    name: "refunds",
    authorId: author.id,
  });

  expect(bySharedUri?.id).toBe(shared.id);
  expect(byPersonalUri?.id).toBe(personal.id);
});

test("a URI key can never name two skills at once", async ({
  makeOrganization,
}) => {
  // The by-key lookup takes one row and applies no tie-break, which is only
  // safe because a name is unique within exactly the visibility a URI pins.
  // If that ever stopped holding, this lookup would start choosing arbitrarily
  // between candidates.
  const org = await makeOrganization();
  await makeSkill(org.id, { name: "duplicated", scope: "org" });

  // A team skill shares the shared-name index with org skills.
  await expect(
    makeSkill(org.id, { name: "duplicated", scope: "team" }),
  ).rejects.toThrow();
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
    }),
  ).toBeNull();
});

test("assignment rejection explains each unpublishable case", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const caller = await makeUser({ email: "caller@test.com" });
  const other = await makeUser({ email: "other@test.com" });
  const sharedGateway = await makeAgent({ organizationId: org.id });

  const templated = await makeSkill(org.id, {
    name: "templated-skill",
    templated: true,
  });
  const delegated = await makeSkill(org.id, {
    name: "delegated-skill",
    agentName: "refund-processor",
  });
  // Reachable in practice only via `skill:admin` or a per-user grant — the
  // access check upstream 404s everyone else — but publishability must still
  // say no: reading someone's personal skill never implies publishing it.
  const someoneElsesPersonal = await makeSkill(org.id, {
    name: "personal-skill",
    scope: "personal",
    authorId: other.id,
  });
  const ownPersonal = await makeSkill(org.id, {
    name: "own-personal-skill",
    scope: "personal",
    authorId: caller.id,
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

  const reject = (skill: Skill, skillEnvironmentIds: string[] = []) =>
    explainAssignmentRejection({
      skill,
      agent: sharedGateway as Agent,
      userId: caller.id,
      skillEnvironmentIds,
    });

  expect(reject(templated)).toMatch(/templated/i);
  expect(reject(delegated)).toMatch(/refund-processor/);
  expect(reject(someoneElsesPersonal)).toMatch(/personal/i);
  expect(reject(ownPersonal)).toBeNull();
  expect(reject(badName)).toMatch(/Agent Skills/);
  expect(reject(longDescription)).toMatch(/description/i);
  expect(reject(longCompatibility)).toMatch(/compatibility/i);
  expect(reject(otherEnvironment, [elsewhere.id])).toMatch(/environment/i);
  expect(reject(ordinary)).toBeNull();
});
