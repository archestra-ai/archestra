import { withDbTransaction } from "@/database";
import {
  AgentExcludedSkillModel,
  AgentModel,
  AgentSkillModel,
  SkillModel,
  SkillTeamModel,
} from "@/models";
import {
  explainAssignmentRejection,
  publishesSkills,
} from "@/services/agent-skill-resolution";
import {
  type AgentSkillAssignments,
  type AgentSkillAssignmentsResponse,
  type AgentSkillExclusionsResponse,
  ApiError,
} from "@/types";
import { isForeignKeyConstraintError } from "@/utils/db";

/**
 * Which skills a gateway publishes over `skill://` (SEP-2640).
 *
 * Gateways only — see `publishesSkills` in agent-skill-resolution for why an
 * internal agent and an LLM Proxy are not publishing surfaces.
 *
 * Mirrors tool assignment: an admin either hand-picks skills ("Custom", the
 * `agent_skills` set) or turns on Auto and prunes with exclusions. Both sets
 * persist independently, so flipping the mode never discards the other's
 * configuration.
 *
 * Validation happens here, at assignment time, rather than only when the
 * gateway serves. A skill the caller cannot publish — a per-user template, an
 * agent delegation, someone else's personal skill, or a skill outside the
 * gateway's environment — is rejected outright, so an admin gets an error
 * instead of an assignment that silently does nothing. For personal skills
 * assignment time is the ONLY check: at serve time a gateway token carries no
 * user to judge against, so the assignment is the authority there.
 *
 * Both PUTs are full replaces whose body is the GET response, so validation
 * runs only on ids being ADDED — the stored set passed these gates when it was
 * added, and the GET echoes it verbatim (see
 * {@link AgentSkillModel.findSkillSummariesByAgent}). Re-judging stored ids
 * against the current caller and environment would wedge the round-trip the
 * moment an entry drifts: a skill rebound to another environment, or a
 * personal skill that only its author may re-assert, would fail every
 * subsequent save — including another admin's — until someone removed it. The
 * sibling tool/subagent surfaces make the same call (per-id adds, or stable
 * caller-independent checks); this is the full-replace equivalent.
 *
 * Every id a caller ADDS is also checked against that caller's OWN read
 * access to the skill, not merely against the organization. Publishing a skill
 * to a gateway hands its full body to every holder of that gateway's token, so
 * the writer must be someone who could already read it — otherwise anyone able
 * to create a gateway could mint themselves a durable copy of any team skill by
 * id alone. Stored ids skip this too: the GET already returns them, rows
 * included, to anyone who can open the editor, so re-accepting them discloses
 * nothing new.
 */
class AgentSkillAssignmentService {
  async getAssignments(
    agentId: string,
  ): Promise<AgentSkillAssignmentsResponse> {
    // The ids are derived from the rows rather than queried separately, so the
    // list and what it names can never disagree.
    const [agent, skills] = await Promise.all([
      AgentModel.findGatewayAgentById(agentId),
      AgentSkillModel.findSkillSummariesByAgent(agentId),
    ]);

    return {
      accessAllSkills: agent?.accessAllSkills ?? false,
      skillIds: skills.map((skill) => skill.id),
      skills,
    };
  }

  async replaceAssignments(params: {
    agentId: string;
    organizationId: string;
    /** The caller, whose own skill read access every assigned id must satisfy. */
    userId: string;
    /** Whether the caller holds `skill:admin`, which bypasses scope checks. */
    isSkillAdmin: boolean;
    assignments: AgentSkillAssignments;
  }): Promise<AgentSkillAssignmentsResponse> {
    const agent = await this.requireAgent(params);
    // Only ids not already stored face the gates — see the class comment.
    const storedIds = new Set(
      await AgentSkillModel.findSkillIdsByAgent(params.agentId),
    );
    const skills = await this.requireSkillsAccessible({
      skillIds: params.assignments.skillIds.filter(
        (skillId) => !storedIds.has(skillId),
      ),
      organizationId: params.organizationId,
      userId: params.userId,
      isSkillAdmin: params.isSkillAdmin,
    });
    const environmentIdsBySkill = await SkillModel.findEnvironmentIdsBySkillIds(
      skills.map((skill) => skill.id),
    );

    for (const skill of skills) {
      const rejection = explainAssignmentRejection({
        skill,
        agent,
        userId: params.userId,
        skillEnvironmentIds: environmentIdsBySkill.get(skill.id) ?? [],
      });
      if (rejection) {
        throw new ApiError(422, rejection);
      }
    }

    // One transaction: a half-applied change would leave the gateway
    // publishing a set nobody chose.
    try {
      await withDbTransaction(async (tx) => {
        // Serialize concurrent replaces for the same agent: without the row
        // lock, two delete+insert replaces under read committed can interleave
        // into a merged union of both requested states, so a PUT whose whole
        // purpose was to unpublish a skill can leave it published.
        await AgentModel.lockRowForUpdate(params.agentId, tx);
        await AgentModel.setAccessAllSkills(
          params.agentId,
          params.assignments.accessAllSkills,
          tx,
        );
        await AgentSkillModel.replaceAssignments(
          { agentId: params.agentId, skillIds: params.assignments.skillIds },
          tx,
        );
      });
    } catch (error) {
      // TOCTOU: a skill permanently deleted between validation and insert
      // surfaces as an FK violation — map it to a client error, not a 500.
      if (isForeignKeyConstraintError(error)) {
        throw new ApiError(400, "One or more skills no longer exist");
      }
      throw error;
    }

    return await this.getAssignments(params.agentId);
  }

  async getExclusions(agentId: string): Promise<AgentSkillExclusionsResponse> {
    const skills =
      await AgentExcludedSkillModel.findSkillSummariesByAgent(agentId);
    return {
      excludedSkillIds: skills.map((skill) => skill.id),
      skills,
    };
  }

  async replaceExclusions(params: {
    agentId: string;
    organizationId: string;
    /** The caller, whose own skill read access every excluded id must satisfy. */
    userId: string;
    /** Whether the caller holds `skill:admin`, which bypasses scope checks. */
    isSkillAdmin: boolean;
    excludedSkillIds: string[];
  }): Promise<AgentSkillExclusionsResponse> {
    await this.requireAgent(params);
    // Excluding a skill only ever narrows what is published, so the
    // publishability checks that guard assignment do not apply — but the same
    // access check does. The exclusion list is echoed back by the GET as full
    // rows (name, description, scope, author), so accepting an id the caller
    // cannot read would turn this endpoint into a lookup for other people's
    // personal and team skills. As with assignments, only ADDED ids are
    // checked: stored exclusions already come back on the GET, and re-judging
    // them would make one editor's exclusion unsaveable for the next.
    const storedIds = new Set(
      await AgentExcludedSkillModel.findSkillIdsByAgent(params.agentId),
    );
    await this.requireSkillsAccessible({
      skillIds: params.excludedSkillIds.filter(
        (skillId) => !storedIds.has(skillId),
      ),
      organizationId: params.organizationId,
      userId: params.userId,
      isSkillAdmin: params.isSkillAdmin,
    });

    try {
      await withDbTransaction(async (tx) => {
        // Same row lock as the assignment replace, and for the same reason.
        await AgentModel.lockRowForUpdate(params.agentId, tx);
        await AgentExcludedSkillModel.replaceExclusions(
          { agentId: params.agentId, skillIds: params.excludedSkillIds },
          tx,
        );
      });
    } catch (error) {
      if (isForeignKeyConstraintError(error)) {
        throw new ApiError(400, "One or more excluded skills no longer exist");
      }
      throw error;
    }

    return await this.getExclusions(params.agentId);
  }

  // ===== Internal =====

  private async requireAgent(params: {
    agentId: string;
    organizationId: string;
  }) {
    const agent = await AgentModel.findById(params.agentId);
    if (!agent || agent.organizationId !== params.organizationId) {
      throw new ApiError(404, "Agent not found");
    }
    // Publishing is a gateway surface — see `publishesSkills`. Rejected rather
    // than accepted-and-ignored so the admin UI and the API agree on where the
    // section exists: the editor is offered on gateways only, and an agent or
    // LLM Proxy that accepted a write here would be storing a set nothing
    // serves and no screen shows.
    if (!publishesSkills(agent.agentType)) {
      throw new ApiError(
        400,
        "Skills are published by MCP gateways only, which is the surface that serves them to clients",
      );
    }
    return agent;
  }

  /**
   * The live skills these ids name, or a 404 for the first id the caller may
   * not name. Callers pass only the ids being ADDED to the stored set — see
   * the class comment for why stored ids are exempt.
   *
   * Two gates, both required. The organization check keeps a cross-org UUID out;
   * the per-skill access check — the same `userHasSkillAccess` the skill routes
   * enforce on every read — keeps out ids inside the org that this caller
   * cannot see. Org scope alone was not enough: `mcpGateway:create/update` is a
   * default member permission, so without this a member could point their own
   * gateway at any team skill's id and read its body through the gateway token.
   *
   * Every failure is `404 Skill not found: <id>`, identical to a nonexistent
   * id, so the endpoint cannot be used to probe which skill ids an org holds.
   *
   * NOTE: this is a write-time check only. Losing access later (leaving the
   * team, the skill narrowing its team assignments) does NOT retract an
   * existing publication — the gateway keeps serving it. Re-checking at serve
   * time is a known follow-up.
   */
  private async requireSkillsAccessible(params: {
    skillIds: string[];
    organizationId: string;
    userId: string;
    isSkillAdmin: boolean;
  }) {
    const uniqueIds = [...new Set(params.skillIds)];
    if (uniqueIds.length === 0) return [];

    const skills = await SkillModel.findByIds(uniqueIds);
    const found = new Map(skills.map((skill) => [skill.id, skill]));

    // Existence and org first: no I/O, and it establishes that every remaining
    // id resolved to a row this caller's organization owns.
    for (const skillId of uniqueIds) {
      const skill = found.get(skillId);
      if (!skill || skill.organizationId !== params.organizationId) {
        throw new ApiError(404, `Skill not found: ${skillId}`);
      }
    }

    const accessible = await Promise.all(
      skills.map((skill) =>
        SkillTeamModel.userHasSkillAccess({
          organizationId: params.organizationId,
          userId: params.userId,
          skill,
          isSkillAdmin: params.isSkillAdmin,
        }),
      ),
    );
    const denied = skills.find((_, index) => !accessible[index]);
    if (denied) {
      throw new ApiError(404, `Skill not found: ${denied.id}`);
    }

    return skills;
  }
}

export const agentSkillAssignmentService = new AgentSkillAssignmentService();
