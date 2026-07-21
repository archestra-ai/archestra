import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  type ResourceVisibilityScope,
  ResourceVisibilityScopeSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import {
  getAgentTypePermissionChecker,
  requireAgentModifyPermission,
} from "@/auth/agent-type-permissions";
import {
  getSkillPermissionChecker,
  requireSkillModifyPermission,
  type SkillPermissionChecker,
} from "@/auth/skill-permissions";
import { userHasPermission } from "@/auth/utils";
import { withDbTransaction } from "@/database";
import logger from "@/logging";
import {
  AgentModel,
  MemberModel,
  OrganizationModel,
  SkillFileModel,
  SkillModel,
  SkillTeamModel,
  TaskModel,
  TeamModel,
  ToolModel,
  UserModel,
} from "@/models";
import { assertCanAssignEnvironment } from "@/services/environments/environment";
import { agentToSkill, SCOPE_FIELD } from "@/skills/agent-migration";
import {
  builtInSkillShippedWrite,
  findBuiltInSkillBySourceRef,
} from "@/skills/built-in-skills";
import {
  resolveGithubAppInstallationToken,
  resolveGithubPatToken,
} from "@/skills/github-app-token";
import {
  discoverSkills,
  importSkills,
  MAX_FILES_PER_SKILL,
  MAX_SKILL_FILE_BYTES,
  SkillImportError,
} from "@/skills/github-import";
import {
  normalizeAllowedTools,
  parseSkillManifest,
  SkillParseError,
} from "@/skills/parser";
import { skillCatalog } from "@/skills/skill-catalog";
import { suggestSkillDescription } from "@/skills/skill-description";
import {
  isSkillNameConflict,
  refineUniqueFilePaths,
  SkillFileInputSchema,
  SkillManifestContentSchema,
  toSkillFiles,
  toSkillInsertFields,
} from "@/skills/validation";
import { taskQueueService } from "@/task-queue";
import {
  ApiError,
  constructResponseSchema,
  createSortingQuerySchema,
  DeleteObjectResponseSchema,
  SelectSkillSchema,
  type Skill,
  SkillFileEncodingSchema,
  SkillGithubSyncIntervalSchema,
  SkillSortBy,
  SkillWithFilesSchema,
  UuidIdSchema,
} from "@/types";
import { isForeignKeyConstraintError } from "@/utils/db";

/**
 * Shared fields identifying a GitHub skill source. Authentication is optional
 * and at most one method may be supplied: a transient one-time PAT
 * (`githubToken`, never stored), a stored PAT (`githubPatId`, managed at
 * /settings/github), or a stored GitHub App config (`githubAppConfigId`).
 */
const githubSkillSourceShape = {
  repoUrl: z.string().min(1),
  path: z.string().optional(),
  githubToken: z.string().optional(),
  githubAppConfigId: z.string().uuid().optional(),
  githubPatId: z.string().uuid().optional(),
};

function hasSingleGithubAuth(source: {
  githubToken?: string;
  githubAppConfigId?: string;
  githubPatId?: string;
}): boolean {
  return (
    [source.githubToken, source.githubAppConfigId, source.githubPatId].filter(
      Boolean,
    ).length <= 1
  );
}

const singleGithubAuthError = {
  message:
    "Provide at most one of githubToken, githubPatId, or githubAppConfigId",
  path: ["githubAppConfigId"],
};

const GithubSkillSourceSchema = z
  .object(githubSkillSourceShape)
  .refine(hasSingleGithubAuth, singleGithubAuthError);

/** A team a skill is assigned to (for `scope = 'team'` skills). */
const SkillTeamSchema = z.object({ id: z.string(), name: z.string() });

/** A skill row plus its resource-file count, team assignments, and author. */
const SkillListItemSchema = SelectSkillSchema.extend({
  fileCount: z.number(),
  teams: z.array(SkillTeamSchema),
  authorName: z.string().nullable(),
});

/** A skill with its resource files and team assignments. */
const SkillDetailSchema = SkillWithFilesSchema.extend({
  teams: z.array(SkillTeamSchema),
});

/** One crawled public-GitHub skill returned by a catalog search. */
const SkillCatalogResultSchema = z.object({
  repo: z.string(),
  skillPath: z.string(),
  name: z.string(),
  description: z.string(),
  compatibility: z.string().nullable(),
  fileCount: z.number(),
});

/** One source-agent field and how the conversion preserved it. */
const MigrationFieldSchema = z.object({
  field: z.string(),
  detail: z.string(),
});

/**
 * Record of how an agent→skill conversion mapped each field: `carried` to a
 * native skill field, or `annotated` into the SKILL.md body / metadata. Nothing
 * is silently dropped, so the UI can show the user exactly what changed.
 */
const MigrationReportSchema = z.object({
  carried: z.array(MigrationFieldSchema),
  annotated: z.array(MigrationFieldSchema),
});

/** An LLM-suggested skill description for the convert-to-skill dialog. */
const SuggestSkillDescriptionResponseSchema = z.object({
  description: z.string(),
});

const ConvertAgentToSkillResponseSchema = z.object({
  skill: SkillDetailSchema,
  report: MigrationReportSchema,
  /** Whether the source agent was deleted as part of the conversion. */
  deletedAgent: z.boolean(),
});

/**
 * Conversion options gathered in the confirm dialog: an explicit skill
 * description (required there when the agent has none) and whether to delete the
 * source agent once the skill exists.
 */
const ConvertAgentToSkillInputSchema = z.object({
  description: z.string().trim().min(1).max(1024).optional(),
  deleteAgent: z.boolean().optional(),
});

/**
 * Manual create/update payload: raw SKILL.md, resource files, and the skill's
 * visibility scope.
 *
 * `files` is optional: on update, omitting it leaves the existing resource
 * files untouched; passing `[]` clears them. `scope` defaults to `personal`;
 * `teamIds` is only meaningful for `scope = 'team'`.
 */
const SkillManifestInputSchema = z
  .object({
    content: SkillManifestContentSchema,
    files: z.array(SkillFileInputSchema).max(MAX_FILES_PER_SKILL).optional(),
    scope: ResourceVisibilityScopeSchema.optional(),
    teamIds: z.array(z.string()).optional(),
    environmentId: UuidIdSchema.nullable()
      .optional()
      .describe(
        "Environment the skill belongs to; null (or omitted on create) is " +
          "the Default environment. Agents only see skills in their own " +
          "environment.",
      ),
    allowedTools: z
      .array(z.string())
      .optional()
      .describe(
        "Tools the skill expects, overriding the SKILL.md `allowed-tools` " +
          "frontmatter. Omit to use the frontmatter; pass [] to clear.",
      ),
  })
  .superRefine((data, ctx) => refineUniqueFilePaths(data.files, ctx));

const DiscoveredSkillSchema = z.object({
  skillPath: z.string(),
  name: z.string(),
  description: z.string(),
  compatibility: z.string().nullable(),
  allowedTools: z.string().nullable(),
  templated: z.boolean(),
  fileCount: z.number(),
});

const skillRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/skills",
    {
      schema: {
        operationId: RouteId.GetSkills,
        description: "List all agent skills for the organization",
        tags: ["Skills"],
        querystring: PaginationQuerySchema.extend({
          search: z.string().optional(),
          sourceRepo: z.string().optional(),
          forAgentId: UuidIdSchema.optional().describe(
            "Restrict results to skills visible from this agent's " +
              "environment (strict match, built-in skills exempt).",
          ),
        }).merge(createSortingQuerySchema(SkillSortBy)),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SkillListItemSchema),
        ),
      },
    },
    async (
      {
        query: { limit, offset, search, sourceRepo, forAgentId, ...sorting },
        organizationId,
        user,
      },
      reply,
    ) => {
      const checker = await getSkillPermissionChecker({
        userId: user.id,
        organizationId,
      });

      // Skills are environment-scoped; `forAgentId` narrows the list to what
      // that agent can actually see (used by the chat slash-command menu).
      let environmentId: string | null | undefined;
      if (forAgentId !== undefined) {
        const agent = await AgentModel.findById(forAgentId);
        if (!agent || agent.organizationId !== organizationId) {
          throw new ApiError(404, "Agent not found");
        }
        environmentId = agent.environmentId ?? null;
      }
      // Non-admins see only skills within their scope; admins see all.
      const accessibleSkillIds = checker.isAdmin
        ? undefined
        : await SkillTeamModel.getUserAccessibleSkillIds({
            organizationId,
            userId: user.id,
          });

      const [skills, total] = await Promise.all([
        SkillModel.findByOrganization({
          organizationId,
          limit,
          offset,
          search,
          sourceRepo,
          accessibleSkillIds,
          environmentId,
          sorting,
        }),
        SkillModel.countByOrganization({
          organizationId,
          search,
          sourceRepo,
          accessibleSkillIds,
          environmentId,
        }),
      ]);

      const skillIds = skills.map((skill) => skill.id);
      const authorIds = [
        ...new Set(
          skills
            .map((skill) => skill.authorId)
            .filter((id): id is string => id !== null),
        ),
      ];
      const [fileCounts, teamsBySkill, authorNames] = await Promise.all([
        SkillFileModel.countBySkillIds(skillIds),
        SkillTeamModel.getTeamDetailsForSkills(skillIds),
        UserModel.getNamesByIds(authorIds),
      ]);

      return reply.send({
        data: skills.map((skill) => ({
          ...skill,
          // skill_files holds only bundled resources; +1 for the mandatory
          // SKILL.md (stored in the skills row) so the count matches the catalog.
          fileCount: (fileCounts.get(skill.id) ?? 0) + 1,
          teams: teamsBySkill.get(skill.id) ?? [],
          authorName: skill.authorId
            ? (authorNames.get(skill.authorId) ?? null)
            : null,
        })),
        pagination: calculatePaginationMeta(total, { limit, offset }),
      });
    },
  );

  fastify.post(
    "/api/skills",
    {
      schema: {
        operationId: RouteId.CreateSkill,
        description: "Create a skill from a raw SKILL.md and resource files",
        tags: ["Skills"],
        body: SkillManifestInputSchema,
        response: constructResponseSchema(SkillDetailSchema),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      const parsed = parseManifestOrThrow(body.content);
      const scope = body.scope ?? "personal";
      const teamIds = scope === "team" ? dedupe(body.teamIds ?? []) : [];

      await authorizeSkillCreate({
        userId: user.id,
        organizationId,
        scope,
        teamIds,
      });

      // Always assert on create: a null/omitted environment still lands on the
      // org default, which may itself be restricted (mirrors the agent path).
      await assertSkillEnvironmentAssignable({
        userId: user.id,
        organizationId,
        environmentId: body.environmentId ?? null,
      });

      const skill = await withTeamFkErrorMapped(() =>
        SkillModel.createWithFiles({
          skill: {
            ...toSkillInsertFields(parsed),
            organizationId,
            authorId: user.id,
            allowedTools: resolveAllowedTools(body, parsed),
            environmentId: body.environmentId ?? null,
            sourceType: "manual",
            scope,
          },
          files: toSkillFiles(body.files ?? []),
          teamIds,
        }),
      );
      if (!skill) {
        throw skillNameConflict(parsed.name);
      }

      return reply.send(await loadSkillDetail(skill));
    },
  );

  // Lives in the skill plugin (not the agent plugin) so it can reuse the
  // skill-create authorization helpers; the button that calls it sits on the
  // agent page. Non-destructive: the source agent is left untouched.
  fastify.post(
    "/api/agents/:id/convert-to-skill",
    {
      schema: {
        operationId: RouteId.ConvertAgentToSkill,
        description:
          "Convert an internal agent into a new Agent Skill. The skill inherits the agent's scope. The source agent is left intact unless deleteAgent is set.",
        tags: ["Skills"],
        params: z.object({ id: UuidIdSchema }),
        body: ConvertAgentToSkillInputSchema,
        response: constructResponseSchema(ConvertAgentToSkillResponseSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      const { agent, agentChecker } =
        await authorizeInternalAgentForSkillConversion({
          id,
          userId: user.id,
          organizationId,
        });

      // If the caller wants the source agent gone, prove they may delete it
      // BEFORE creating the skill, so a permission failure doesn't leave an
      // orphan skill behind. Mirrors the agent DELETE route's authorization.
      if (body.deleteAgent) {
        try {
          agentChecker.require(agent.agentType, "delete");
        } catch {
          throw new ApiError(
            403,
            "You do not have permission to delete this agent",
          );
        }
        const agentUserTeamIds = agentChecker.isAdmin(agent.agentType)
          ? []
          : await TeamModel.getUserTeamIds(user.id);
        requireAgentModifyPermission({
          checker: agentChecker,
          agentType: agent.agentType,
          agentScope: agent.scope,
          agentAuthorId: agent.authorId,
          agentTeamIds: agent.teams.map((team) => team.id),
          userTeamIds: agentUserTeamIds,
          userId: user.id,
        });
        if (await MemberModel.isAgentDefault(agent.id)) {
          throw new ApiError(
            400,
            "Cannot delete a default agent. Set another agent as default first.",
          );
        }
      }

      const { draft, teamIds, report } = agentToSkill(agent, {
        description: body.description,
      });

      // Agent system prompts are unbounded, so enforce the same content-size cap
      // the manual/import paths apply to SKILL.md (SkillManifestInputSchema). An
      // oversized skill would otherwise slip in here and later bloat chat
      // activation payloads and the model's context.
      if (draft.content.length > MAX_SKILL_FILE_BYTES) {
        throw new ApiError(
          400,
          `Converted skill content exceeds the ${MAX_SKILL_FILE_BYTES}-character limit. Trim the agent's system prompt before converting.`,
        );
      }

      // ...and be allowed to create a skill in the scope inherited from the agent.
      await authorizeSkillCreate({
        userId: user.id,
        organizationId,
        scope: draft.scope,
        teamIds,
      });

      // Create the skill and (optionally) delete the source agent in one
      // transaction so convert+delete is all-or-nothing: a failed delete rolls
      // back the skill insert, so a retry never collides with a half-created
      // skill and the user is never left with duplicated state.
      let deletedAgent = false;
      const skill = await withTeamFkErrorMapped(() =>
        withDbTransaction(async (tx) => {
          const created = await SkillModel.createWithFiles(
            {
              skill: {
                ...toSkillInsertFields(draft),
                organizationId,
                authorId: user.id,
                // skills are environment-scoped; inherit the source agent's
                // environment so the converted skill stays visible where the
                // agent lived.
                environmentId: agent.environmentId ?? null,
                sourceType: "manual",
                scope: draft.scope,
              },
              files: [],
              teamIds,
            },
            tx,
          );
          if (!created) {
            // name already taken in this visibility scope — nothing was
            // inserted, so rolling back here leaves no orphan.
            throw skillNameConflict(draft.name);
          }
          // Eligibility was checked above; delete inside the same transaction.
          if (body.deleteAgent) {
            deletedAgent = await AgentModel.delete(agent.id, tx);
          }
          return created;
        }),
      );

      // this surface persists the agent's scope (and teams) verbatim, so report
      // it carried. The MCP draft path can't and reports it annotated instead.
      report.carried.push({ field: SCOPE_FIELD, detail: draft.scope });

      logger.info(
        { agentId: agent.id, skillId: skill.id, organizationId, deletedAgent },
        "[Skills] Converted agent to skill",
      );
      return reply.send({
        skill: await loadSkillDetail(skill),
        report,
        deletedAgent,
      });
    },
  );

  fastify.post(
    "/api/agents/:id/suggest-skill-description",
    {
      schema: {
        operationId: RouteId.SuggestSkillDescription,
        description:
          "Suggest a skill description for an agent using an LLM, for the convert-to-skill flow. Does not modify the agent or create a skill.",
        tags: ["Skills"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(
          SuggestSkillDescriptionResponseSchema,
        ),
      },
    },
    async ({ params: { id }, user, organizationId }, reply) => {
      const { agent } = await authorizeInternalAgentForSkillConversion({
        id,
        userId: user.id,
        organizationId,
      });

      const description = await suggestSkillDescription({
        agent,
        organizationId,
        userId: user.id,
      });
      if (!description) {
        throw new ApiError(
          502,
          "Could not generate a description. Please write one manually.",
        );
      }
      return reply.send({ description });
    },
  );

  fastify.get(
    "/api/skills/:id",
    {
      schema: {
        operationId: RouteId.GetSkill,
        description: "Get a skill with its resource files",
        tags: ["Skills"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(SkillDetailSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      const skill = await findSkillOrThrow(id, organizationId);
      const checker = await getSkillPermissionChecker({
        userId: user.id,
        organizationId,
      });
      // 404 (not 403) so scope is not leaked to users who cannot see the skill.
      const hasAccess = await SkillTeamModel.userHasSkillAccess({
        organizationId,
        userId: user.id,
        skill,
        isSkillAdmin: checker.isAdmin,
      });
      if (!hasAccess) {
        throw new ApiError(404, "Skill not found");
      }
      return reply.send(await loadSkillDetail(skill));
    },
  );

  fastify.put(
    "/api/skills/:id",
    {
      schema: {
        operationId: RouteId.UpdateSkill,
        description: "Update a skill's SKILL.md, resource files, and scope",
        tags: ["Skills"],
        params: z.object({ id: z.string() }),
        body: SkillManifestInputSchema,
        response: constructResponseSchema(SkillDetailSchema),
      },
    },
    async ({ params: { id }, body, organizationId, user }, reply) => {
      const existing = await findSkillOrThrow(id, organizationId);
      const parsed = parseManifestOrThrow(body.content);

      const {
        checker,
        userTeamIds,
        skillTeamIds: existingTeamIds,
      } = await authorizeSkillModify({
        skill: existing,
        userId: user.id,
        organizationId,
      });

      // A GitHub-synced skill's content is owned by its source repo: reject
      // manifest/file changes (Archestra-side settings — scope, teams,
      // environment — stay editable below). Disconnecting the skill from
      // GitHub makes it editable.
      if (existing.githubSyncInterval !== null) {
        assertSyncedSkillContentUnchanged({ existing, parsed, body });
      }

      // Re-authorize and re-sync teams only when scope or team assignments
      // actually change. A content-only edit that echoes the existing teams
      // must not 403 a non-admin author or needlessly rewrite team rows.
      const newScope = body.scope ?? existing.scope;
      const newTeamIds =
        newScope === "team" ? dedupe(body.teamIds ?? existingTeamIds) : [];
      const scopeChanged = newScope !== existing.scope;
      const teamsChanged =
        newScope === "team" && !sameTeamSet(newTeamIds, existingTeamIds);
      if (scopeChanged || teamsChanged) {
        authorizeSkillScope({
          checker,
          scope: newScope,
          authorId: existing.authorId,
          requestedTeamIds: newTeamIds,
          userTeamIds,
          userId: user.id,
        });
        await assertSkillTeams({
          scope: newScope,
          teamIds: newTeamIds,
          organizationId,
        });
      }

      // Moving a skill between environments is gated like assigning one: the
      // target environment must be assignable by this user.
      const environmentChanged =
        body.environmentId !== undefined &&
        body.environmentId !== existing.environmentId;
      if (environmentChanged) {
        await assertSkillEnvironmentAssignable({
          userId: user.id,
          organizationId,
          environmentId: body.environmentId ?? null,
        });
      }

      let updated: Skill | null;
      try {
        // The metadata, files, and team assignments are updated in a single
        // transaction (see SkillModel.updateWithFiles), so a team deleted
        // mid-request rolls the whole update back rather than leaving a
        // team-scoped skill with no teams. teamIds is only synced when scope or
        // teams actually change; otherwise it is left untouched.
        updated = await withTeamFkErrorMapped(() =>
          SkillModel.updateWithFiles({
            id,
            skill: {
              ...toSkillInsertFields(parsed),
              allowedTools: resolveAllowedTools(body, parsed),
              scope: newScope,
              ...(environmentChanged
                ? { environmentId: body.environmentId ?? null }
                : {}),
            },
            files:
              body.files === undefined ? undefined : toSkillFiles(body.files),
            teamIds: scopeChanged || teamsChanged ? newTeamIds : undefined,
          }),
        );
      } catch (error) {
        // Name conflict within the skill's visibility namespace — not a team FK
        // (mapped above) or a duplicate resource-file path (rejected at input).
        if (isSkillNameConflict(error)) {
          throw skillNameConflict(parsed.name);
        }
        throw error;
      }

      if (!updated) {
        throw new ApiError(404, "Skill not found");
      }

      return reply.send(await loadSkillDetail(updated));
    },
  );

  fastify.get(
    "/api/skills/source-repos",
    {
      schema: {
        operationId: RouteId.GetSkillSourceRepos,
        description:
          "List distinct GitHub repositories that skills in this organization were imported from",
        tags: ["Skills"],
        response: constructResponseSchema(
          z.object({ repos: z.array(z.string()) }),
        ),
      },
    },
    async ({ organizationId, user }, reply) => {
      const checker = await getSkillPermissionChecker({
        userId: user.id,
        organizationId,
      });
      const accessibleSkillIds = checker.isAdmin
        ? undefined
        : await SkillTeamModel.getUserAccessibleSkillIds({
            organizationId,
            userId: user.id,
          });

      const repos = await SkillModel.findDistinctSourceRepos({
        organizationId,
        accessibleSkillIds,
      });
      return reply.send({ repos });
    },
  );

  fastify.delete(
    "/api/skills/:id",
    {
      schema: {
        operationId: RouteId.DeleteSkill,
        description: "Delete a skill and its resource files",
        tags: ["Skills"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      const skill = await findSkillOrThrow(id, organizationId);

      await authorizeSkillModify({ skill, userId: user.id, organizationId });

      const success = await SkillModel.delete(id);
      if (!success) {
        throw new ApiError(404, "Skill not found");
      }
      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/skills/:id/reset",
    {
      schema: {
        operationId: RouteId.ResetSkill,
        description:
          "Reset a built-in skill to its shipped default SKILL.md and resource files. Only applies to skills with sourceType `built_in`.",
        tags: ["Skills"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(SkillDetailSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      const skill = await findSkillOrThrow(id, organizationId);
      // Check scope-visibility first (404 if the caller can't see the skill),
      // before revealing its sourceType via a 400, matching the update/delete
      // routes and the authorizeSkillModify contract (no scope leak).
      await authorizeSkillModify({ skill, userId: user.id, organizationId });

      if (skill.sourceType !== "built_in") {
        throw new ApiError(400, "Only built-in skills can be reset to default");
      }
      const definition = skill.sourceRef
        ? findBuiltInSkillBySourceRef(skill.sourceRef)
        : null;
      if (!definition) {
        throw new ApiError(404, "No shipped default exists for this skill");
      }

      // brand the shipped default under this org's white-label identity before
      // writing it, matching syncBuiltInSkills (no-op unless full white-labeling
      // is active). builtInSkillShippedWrite reads the synced singleton.
      const organization = await OrganizationModel.getById(organizationId);
      archestraMcpBranding.syncFromOrganization(organization);

      const shipped = builtInSkillShippedWrite(definition);
      const reset = await SkillModel.updateWithFiles({
        id,
        skill: shipped.skill,
        files: shipped.files,
      });
      if (!reset) {
        throw new ApiError(404, "Skill not found");
      }

      logger.info(
        { skillId: id, organizationId },
        "[Skills] Reset built-in skill to default",
      );
      return reply.send(await loadSkillDetail(reset));
    },
  );

  fastify.patch(
    "/api/skills/:id/github-sync",
    {
      schema: {
        operationId: RouteId.UpdateSkillGithubSync,
        description:
          "Manage a GitHub-synced skill: change its pull frequency, trigger " +
          "an immediate pull, or disconnect it from the GitHub source " +
          "(interval null) — a disconnected skill keeps its content and " +
          "provenance and becomes editable in the app.",
        tags: ["Skills"],
        params: z.object({ id: z.string() }),
        body: z
          .object({
            interval: SkillGithubSyncIntervalSchema.optional().describe(
              "New pull frequency.",
            ),
            syncNow: z
              .literal(true)
              .optional()
              .describe("Trigger an immediate pull from the source repo."),
            disconnect: z
              .literal(true)
              .optional()
              .describe(
                "Disconnect the skill from its GitHub source: it keeps its " +
                  "content and becomes editable in the app.",
              ),
          })
          .refine(
            (body) =>
              [
                body.interval !== undefined,
                body.syncNow ?? false,
                body.disconnect ?? false,
              ].filter(Boolean).length === 1,
            {
              message:
                "Pass exactly one of `interval`, `syncNow`, or `disconnect`",
              path: ["interval"],
            },
          ),
        response: constructResponseSchema(SkillDetailSchema),
      },
    },
    async ({ params: { id }, body, organizationId, user }, reply) => {
      const skill = await findSkillOrThrow(id, organizationId);
      // Scope-visibility first (404), before revealing sync state via a 400 —
      // matching the reset route and the authorizeSkillModify contract.
      await authorizeSkillModify({ skill, userId: user.id, organizationId });

      if (skill.githubSyncInterval === null) {
        throw new ApiError(
          400,
          "This skill is not synced from GitHub. Sync is chosen when " +
            "importing from a repository.",
        );
      }

      if (body.syncNow) {
        // one pull at a time per skill — same in-flight guard as the
        // scheduled check-due tick.
        const active = await TaskModel.findActivePayloadValues(
          "skill_github_sync",
          "skillId",
        );
        if (!active.has(skill.id)) {
          await taskQueueService.enqueue({
            taskType: "skill_github_sync",
            payload: { skillId: skill.id },
          });
        }
        return reply.send(await loadSkillDetail(skill));
      }

      const updated = await SkillModel.setGithubSync(
        id,
        body.disconnect ? null : { interval: body.interval ?? "1d" },
      );
      if (!updated) {
        throw new ApiError(404, "Skill not found");
      }

      logger.info(
        { skillId: id, organizationId, interval: body.interval ?? null },
        body.disconnect
          ? "[Skills] Skill disconnected from GitHub source"
          : "[Skills] GitHub sync frequency changed",
      );
      return reply.send(await loadSkillDetail(updated));
    },
  );

  fastify.post(
    "/api/skills/enable-defaults",
    {
      schema: {
        operationId: RouteId.EnableSkillToolDefaults,
        description:
          "Enable the Agent Skill tools (`list_skills`, `load_skill`) for this organization. Sets the org-level flag and backfills the tools onto every existing agent. Idempotent.",
        tags: ["Skills"],
        response: constructResponseSchema(
          z.object({ enabled: z.literal(true), agentsBackfilled: z.number() }),
        ),
      },
    },
    async ({ organizationId }, reply) => {
      await OrganizationModel.patch(organizationId, {
        skillToolsEnabled: true,
      });
      const agentsBackfilled =
        await ToolModel.backfillSkillToolsToOrgAgents(organizationId);
      logger.info(
        { organizationId, agentsBackfilled },
        "[Skills] Enabled skill tool defaults and backfilled existing agents",
      );
      return reply.send({ enabled: true, agentsBackfilled });
    },
  );

  fastify.get(
    "/api/skills/catalog/search",
    {
      schema: {
        operationId: RouteId.SearchSkillCatalog,
        description:
          "Search the crawled public-GitHub skill catalog by name, repo, path, or description. Backed by an in-memory token index; returns ranked candidates to import via the GitHub import endpoints.",
        tags: ["Skills"],
        querystring: z.object({
          q: z.string().default(""),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: constructResponseSchema(
          z.object({
            results: z.array(SkillCatalogResultSchema),
            totalCount: z.number(),
          }),
        ),
      },
    },
    async ({ query: { q, limit } }, reply) => {
      const results = skillCatalog.search({ query: q, limit });
      return reply.send({
        results: results.map((entry) => ({
          repo: entry.repo,
          skillPath: entry.skillPath,
          name: entry.name,
          description: entry.description,
          compatibility: entry.compatibility,
          fileCount: entry.fileCount,
        })),
        totalCount: skillCatalog.size,
      });
    },
  );

  fastify.post(
    "/api/skills/github/discover",
    {
      schema: {
        operationId: RouteId.DiscoverGithubSkills,
        description: "Discover skills in a GitHub repository",
        tags: ["Skills"],
        body: GithubSkillSourceSchema,
        response: constructResponseSchema(
          z.object({
            repoUrl: z.string(),
            ref: z.string(),
            skills: z.array(
              DiscoveredSkillSchema.extend({ exists: z.boolean() }),
            ),
          }),
        ),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      const githubToken = await resolveGithubImportToken({
        githubToken: body.githubToken,
        githubAppConfigId: body.githubAppConfigId,
        githubPatId: body.githubPatId,
        organizationId,
        userId: user.id,
      });
      const result = await runImport(() =>
        discoverSkills({
          repoUrl: body.repoUrl,
          path: body.path,
          githubToken,
        }),
      );

      // Flag names an import would actually collide with so the UI can disable
      // them in the multi-select. Mirrors the per-scope unique indexes: a shared
      // skill of that name, or this user's own personal skill — another user's
      // personal skill of the same name cannot block the import, so it must not
      // disable the row. (The hint stays scope-blind: it cannot know the target
      // scope yet, so a shared name still flags even though a personal import
      // could coexist — the conservative direction.)
      const collisions = await SkillModel.findImportNameCollisions({
        organizationId,
        userId: user.id,
        names: result.skills.map((skill) => skill.name),
      });
      const skills = result.skills.map((skill) => ({
        ...skill,
        exists: collisions.has(skill.name),
      }));

      return reply.send({ ...result, skills });
    },
  );

  fastify.post(
    "/api/skills/github/preview",
    {
      schema: {
        operationId: RouteId.PreviewGithubSkill,
        description:
          "Fetch a single skill's manifest and files from GitHub without persisting it.",
        tags: ["Skills"],
        body: z
          .object({ ...githubSkillSourceShape, skillPath: z.string() })
          .refine(hasSingleGithubAuth, singleGithubAuthError),
        response: constructResponseSchema(
          z.object({
            name: z.string(),
            description: z.string(),
            content: z.string(),
            license: z.string().nullable(),
            compatibility: z.string().nullable(),
            allowedTools: z.string().nullable(),
            agentName: z.string().nullable(),
            templated: z.boolean(),
            metadata: z.record(z.string(), z.string()),
            files: z.array(
              z.object({
                path: z.string(),
                content: z.string(),
                encoding: SkillFileEncodingSchema,
                kind: z.enum(["reference", "script", "asset"]),
              }),
            ),
            skippedFiles: z
              .array(z.string())
              .describe(
                "Resource paths not imported: oversized, beyond the per-skill file cap, or unfetchable",
              ),
            sourceRef: z.string(),
            sourceCommit: z.string(),
          }),
        ),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      const githubToken = await resolveGithubImportToken({
        githubToken: body.githubToken,
        githubAppConfigId: body.githubAppConfigId,
        githubPatId: body.githubPatId,
        organizationId,
        userId: user.id,
      });
      const [item] = await runImport(() =>
        importSkills({
          repoUrl: body.repoUrl,
          path: body.path,
          githubToken,
          skillPaths: [body.skillPath],
        }),
      );
      if (!item) {
        throw new ApiError(404, `Skill not found at ${body.skillPath}`);
      }
      return reply.send({
        ...item.parsed,
        files: item.files,
        skippedFiles: item.skippedFiles,
        sourceRef: item.sourceRef,
        sourceCommit: item.sourceCommit,
      });
    },
  );

  fastify.post(
    "/api/skills/github/import",
    {
      schema: {
        operationId: RouteId.ImportGithubSkills,
        description: "Import selected skills from a GitHub repository",
        tags: ["Skills"],
        body: z
          .object({
            ...githubSkillSourceShape,
            skillPaths: z.array(z.string()).min(1),
            scope: ResourceVisibilityScopeSchema.optional(),
            teamIds: z.array(z.string()).optional(),
            sync: z
              .object({ interval: SkillGithubSyncIntervalSchema })
              .default({ interval: "1d" })
              .describe(
                "Pull schedule for the imported skills. Every import is " +
                  "synced from the repo and read-only in the app until " +
                  "disconnected. Defaults to daily.",
              ),
          })
          .refine(hasSingleGithubAuth, singleGithubAuthError)
          .refine((body) => !body.githubToken, {
            message:
              "Imports are always kept in sync, and a transient token is " +
              "never stored, so scheduled pulls could not authenticate. " +
              "Save the token or use a GitHub App configuration " +
              "(Settings → GitHub), or import a public repository.",
            path: ["githubToken"],
          }),
        response: constructResponseSchema(
          z.object({
            created: z.array(SelectSkillSchema),
            skipped: z.array(z.string()),
            skippedFiles: z
              .array(
                z.object({
                  skillPath: z.string(),
                  files: z.array(z.string()),
                }),
              )
              .describe(
                "Per created skill, resource paths not imported: oversized, beyond the per-skill file cap, or unfetchable",
              ),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { body, organizationId, user } = request;
      // Imported skills carry an explicit scope, authorized like manual create;
      // when omitted they default to `personal` so a bulk import is never
      // silently published org-wide.
      const scope = body.scope ?? "personal";
      const teamIds = scope === "team" ? dedupe(body.teamIds ?? []) : [];

      await authorizeSkillCreate({
        userId: user.id,
        organizationId,
        scope,
        teamIds,
      });

      const githubToken = await resolveGithubImportToken({
        githubToken: body.githubToken,
        githubAppConfigId: body.githubAppConfigId,
        githubPatId: body.githubPatId,
        organizationId,
        userId: user.id,
      });
      const imported = await runImport(() =>
        importSkills({
          repoUrl: body.repoUrl,
          path: body.path,
          githubToken,
          skillPaths: body.skillPaths,
        }),
      );

      const created: Skill[] = [];
      const skipped: string[] = [];
      const skippedFiles: { skillPath: string; files: string[] }[] = [];
      for (const item of imported) {
        const skill = await withTeamFkErrorMapped(() =>
          SkillModel.createWithFiles({
            skill: {
              ...toSkillInsertFields(item.parsed),
              organizationId,
              authorId: user.id,
              sourceType: "github",
              sourceRef: item.sourceRef,
              sourceCommit: item.sourceCommit,
              scope,
              // every import is synced: record the schedule, tracking ref
              // (null = default branch), and the stored credential scheduled
              // pulls reuse (App config or saved PAT).
              githubSyncInterval: body.sync.interval,
              githubSyncRef: item.requestedRef,
              githubAppConfigId: body.githubAppConfigId ?? null,
              githubPatId: body.githubPatId ?? null,
            },
            files: item.files,
            teamIds,
          }),
        );
        if (!skill) {
          skipped.push(item.parsed.name);
          continue;
        }
        created.push(skill);
        if (item.skippedFiles.length > 0) {
          skippedFiles.push({
            skillPath: item.skillPath,
            files: item.skippedFiles,
          });
        }
      }

      logger.info(
        { organizationId, created: created.length, skipped: skipped.length },
        "[Skills] GitHub import complete",
      );

      // Supply the audit post-state: a bulk import has no single resourceId,
      // so record the created skills (id + name) for traceability.
      request.auditAfter = {
        created: created.map((s) => ({ id: s.id, name: s.name })),
        skipped,
      };

      return reply.send({ created, skipped, skippedFiles });
    },
  );
};

// ===== Internal helpers =====

/**
 * Assigning a skill to a restricted environment is gated by
 * skill:deploy-to-restricted, mirroring the per-resource permissions the agent
 * and MCP-catalog assignment paths use. Throws 403/404 if the caller may not
 * assign the environment.
 */
async function assertSkillEnvironmentAssignable(params: {
  userId: string;
  organizationId: string;
  environmentId: string | null;
}): Promise<void> {
  const { userId, organizationId, environmentId } = params;
  const hasSkillDeploy = await userHasPermission(
    userId,
    organizationId,
    "skill",
    "deploy-to-restricted",
  );
  await assertCanAssignEnvironment({
    environmentId,
    organizationId,
    canDeployToRestricted: hasSkillDeploy,
  });
}

/**
 * Resolve the token a GitHub skill import authenticates with. A stored GitHub
 * App config (org-scoped, github.com only) is exchanged for a short-lived
 * installation token; a stored PAT is read from the secret manager; otherwise
 * the transient one-time PAT (if any) is passed through.
 */
async function resolveGithubImportToken(params: {
  githubToken?: string;
  githubAppConfigId?: string;
  githubPatId?: string;
  organizationId: string;
  userId: string;
}): Promise<string | undefined> {
  const {
    githubToken,
    githubAppConfigId,
    githubPatId,
    organizationId,
    userId,
  } = params;
  if (!githubAppConfigId && !githubPatId) {
    return githubToken;
  }

  // using a stored credential requires read access to GitHub credentials
  const allowed = await userHasPermission(
    userId,
    organizationId,
    "githubAppConfig",
    "read",
  );
  if (!allowed) {
    throw new ApiError(403, "You do not have access to GitHub credentials");
  }

  if (githubPatId) {
    return resolveGithubPatToken({ githubPatId, organizationId });
  }
  return resolveGithubAppInstallationToken({
    // hasSingleGithubAuth guarantees exactly one stored-credential id here
    githubAppConfigId: githubAppConfigId as string,
    organizationId,
  });
}

/**
 * Reject a PUT that would change a GitHub-synced skill's content. The manifest
 * must parse to exactly the stored fields and `files` must be omitted — an
 * echo of the current manifest (how the editor submits settings-only changes)
 * passes; any drift means an attempted edit of repo-owned content.
 */
function assertSyncedSkillContentUnchanged(params: {
  existing: Skill;
  parsed: ReturnType<typeof parseSkillManifest>;
  body: { files?: unknown; allowedTools?: string[] };
}): void {
  const { existing, parsed, body } = params;
  const next = {
    ...toSkillInsertFields(parsed),
    allowedTools: resolveAllowedTools(body, parsed),
  };
  const scalarChanged = (
    [
      "name",
      "description",
      "content",
      "license",
      "compatibility",
      "allowedTools",
      "agentName",
      "templated",
    ] as const
  ).some((field) => next[field] !== existing[field]);
  const metadataChanged =
    JSON.stringify(next.metadata) !== JSON.stringify(existing.metadata);
  if (scalarChanged || metadataChanged || body.files !== undefined) {
    throw new ApiError(
      409,
      "This skill is synced from GitHub and its content is read-only. Disconnect it from the GitHub source to edit it in the app.",
    );
  }
}

async function findSkillOrThrow(id: string, organizationId: string) {
  const skill = await SkillModel.findById(id);
  if (!skill || skill.organizationId !== organizationId) {
    throw new ApiError(404, "Skill not found");
  }
  return skill;
}

/** A skill with its files and team assignments, for detail responses. */
async function loadSkillDetail(skill: Skill) {
  const [files, teamsBySkill] = await Promise.all([
    SkillFileModel.findBySkillId(skill.id),
    SkillTeamModel.getTeamDetailsForSkills([skill.id]),
  ]);
  return { ...skill, files, teams: teamsBySkill.get(skill.id) ?? [] };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Whether two team-id lists contain the same set of ids. */
function sameTeamSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

/**
 * Validate a skill's team assignments before persisting. Only meaningful for
 * `team` scope: such a skill must have at least one team (otherwise it is
 * invisible to everyone, including its author), and every team must exist
 * within the organization — a stale/deleted id fails with a clean 400 instead
 * of an FK violation mid-transaction.
 */
async function assertSkillTeams(params: {
  scope: ResourceVisibilityScope;
  teamIds: string[];
  organizationId: string;
}): Promise<void> {
  if (params.scope !== "team") return;

  if (params.teamIds.length === 0) {
    throw new ApiError(
      400,
      "A team-scoped skill must be assigned to at least one team",
    );
  }

  const teams = await TeamModel.findByIds(params.teamIds);
  const validIds = new Set(
    teams
      .filter((team) => team.organizationId === params.organizationId)
      .map((team) => team.id),
  );
  const missing = params.teamIds.filter((id) => !validIds.has(id));
  if (missing.length > 0) {
    throw new ApiError(400, `Unknown team id(s): ${missing.join(", ")}`);
  }
}

/**
 * Run a skill write, converting a `skill_team` foreign-key violation — a team
 * deleted between {@link assertSkillTeams} and the insert — into a clean 400.
 */
async function withTeamFkErrorMapped<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isForeignKeyConstraintError(error)) {
      throw new ApiError(
        400,
        "One or more of the selected teams no longer exist",
      );
    }
    throw error;
  }
}

/**
 * Authorize creating/moving a skill to the given scope and teams. Enforces the
 * 3-tier scope check and, for non-admins, that every assigned team is one the
 * user belongs to.
 */
function authorizeSkillScope(params: {
  checker: SkillPermissionChecker;
  scope: ResourceVisibilityScope;
  authorId: string | null;
  requestedTeamIds: string[];
  userTeamIds: string[];
  userId: string;
}): void {
  requireSkillModifyPermission({
    checker: params.checker,
    scope: params.scope,
    authorId: params.authorId,
    skillTeamIds: params.requestedTeamIds,
    userTeamIds: params.userTeamIds,
    userId: params.userId,
  });

  if (!params.checker.isAdmin && params.scope === "team") {
    const userTeamIdSet = new Set(params.userTeamIds);
    if (params.requestedTeamIds.some((id) => !userTeamIdSet.has(id))) {
      throw new ApiError(
        403,
        "You can only assign skills to teams you are a member of",
      );
    }
  }
}

/**
 * Authorization for creating a skill in a given scope: the caller must hold
 * the scope-appropriate create permission and may only target teams they
 * belong to (admins excepted), and those teams must exist in the org.
 */
async function authorizeSkillCreate(params: {
  userId: string;
  organizationId: string;
  scope: ResourceVisibilityScope;
  teamIds: string[];
}): Promise<void> {
  const checker = await getSkillPermissionChecker({
    userId: params.userId,
    organizationId: params.organizationId,
  });
  const userTeamIds = checker.isAdmin
    ? []
    : await TeamModel.getUserTeamIds(params.userId);
  authorizeSkillScope({
    checker,
    scope: params.scope,
    authorId: params.userId,
    requestedTeamIds: params.teamIds,
    userTeamIds,
    userId: params.userId,
  });
  await assertSkillTeams({
    scope: params.scope,
    teamIds: params.teamIds,
    organizationId: params.organizationId,
  });
}

/**
 * Read-authorize an internal agent for the convert-to-skill flow, shared by the
 * convert and suggest-description routes.
 *
 * admin-view load bypasses access filtering; the read + scope checks below
 * re-impose it BEFORE we reveal anything about the resource — otherwise a user
 * with only agent:read could distinguish an inaccessible
 * profile/MCP-gateway/LLM-proxy from a nonexistent id via the "not an internal
 * agent" 400. Only once the caller is allowed to read it do we disclose that it
 * is the wrong kind of resource for conversion.
 *
 * Returns the loaded agent and its permission checker so callers can run
 * follow-up checks (e.g. delete) without reloading.
 */
async function authorizeInternalAgentForSkillConversion(params: {
  id: string;
  userId: string;
  organizationId: string;
}) {
  const { id, userId, organizationId } = params;

  const agent = await AgentModel.findById(id, userId, true);
  if (!agent || agent.organizationId !== organizationId) {
    throw new ApiError(404, "Agent not found");
  }

  const agentChecker = await getAgentTypePermissionChecker({
    userId,
    organizationId,
  });
  try {
    agentChecker.require(agent.agentType, "read");
  } catch {
    throw new ApiError(404, "Agent not found");
  }
  if (!agentChecker.isAdmin(agent.agentType)) {
    const accessible = await AgentModel.findById(id, userId, false);
    if (!accessible) {
      throw new ApiError(404, "Agent not found");
    }
  }

  if (agent.agentType !== "agent" || agent.builtInAgentConfig) {
    throw new ApiError(400, "Only internal agents can be converted to skills.");
  }

  return { agent, agentChecker };
}

/**
 * Authorize a modify (update/delete/reset) on an existing skill: the caller
 * must be able to see it — else 404, not 403, so scope is not leaked to users
 * who cannot see the skill — and hold the scope-appropriate modify permission.
 *
 * Returns the skill's permission checker, the caller's team ids, and the
 * skill's current team ids so callers can run follow-up scope/team
 * re-authorization (e.g. on update) without reloading.
 */
async function authorizeSkillModify(params: {
  skill: Skill;
  userId: string;
  organizationId: string;
}): Promise<{
  checker: SkillPermissionChecker;
  userTeamIds: string[];
  skillTeamIds: string[];
}> {
  const { skill, userId, organizationId } = params;

  const checker = await getSkillPermissionChecker({ userId, organizationId });
  const userTeamIds = checker.isAdmin
    ? []
    : await TeamModel.getUserTeamIds(userId);
  const skillTeamIds = await SkillTeamModel.getTeamsForSkill(skill.id);

  const hasAccess = await SkillTeamModel.userHasSkillAccess({
    organizationId,
    userId,
    skill,
    isSkillAdmin: checker.isAdmin,
  });
  if (!hasAccess) {
    throw new ApiError(404, "Skill not found");
  }
  requireSkillModifyPermission({
    checker,
    scope: skill.scope,
    authorId: skill.authorId,
    skillTeamIds,
    userTeamIds,
    userId,
  });

  return { checker, userTeamIds, skillTeamIds };
}

/** Explicit `allowedTools` wins over the SKILL.md frontmatter when provided. */
function resolveAllowedTools(
  body: { allowedTools?: string[] },
  parsed: { allowedTools: string | null },
): string | null {
  return body.allowedTools === undefined
    ? parsed.allowedTools
    : normalizeAllowedTools(body.allowedTools);
}

function parseManifestOrThrow(raw: string) {
  try {
    return parseSkillManifest(raw);
  } catch (error) {
    if (error instanceof SkillParseError) {
      throw new ApiError(400, error.message);
    }
    throw error;
  }
}

function skillNameConflict(name: string): ApiError {
  return new ApiError(409, `A skill named "${name}" already exists`);
}

/** Run a GitHub operation, converting import/parse failures into 400s. */
async function runImport<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SkillImportError || error instanceof SkillParseError) {
      throw new ApiError(400, error.message);
    }
    throw error;
  }
}

export default skillRoutes;
