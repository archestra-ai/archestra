import {
  CreatedByNullableSchema,
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  MAX_BULK_IDS,
  PaginationQuerySchema,
  parseLabelsParam,
  ResourcePermissionGrantSchema,
  type ResourceVisibilityScope,
  ResourceVisibilityScopeSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { getAgentTypePermissionChecker } from "@/auth/agent-type-permissions";
import {
  getSkillPermissionChecker,
  requireSkillModifyPermission,
  type SkillPermissionChecker,
} from "@/auth/skill-permissions";
import { isGlobalAdmin, userHasPermission } from "@/auth/utils";
import logger from "@/logging";
import {
  AgentActivationSkillRuleModel,
  AgentExcludedSkillModel,
  AgentModel,
  AgentSkillModel,
  CreatedByModel,
  lookupCreator,
  OrganizationModel,
  SkillEnvironmentModel,
  SkillFileModel,
  SkillLabelModel,
  SkillModel,
  SkillTeamModel,
  SkillUsageEventModel,
  SkillUserModel,
  SkillVersionModel,
  TaskModel,
  TeamModel,
  ToolModel,
  UserModel,
} from "@/models";
import { agentSkillAssignmentService } from "@/services/agent-skill-assignment";
import { publishesSkills } from "@/services/agent-skill-resolution";
import { assertCanAssignEnvironment } from "@/services/environments/environment";
import { transferResourceOwnership } from "@/services/resource-ownership";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  builtInSkillShippedWrite,
  findBuiltInSkillBySourceRef,
} from "@/skills/built-in-skills";
import {
  resolveGithubPatToken,
  resolveGithubSkillAppCredentials,
} from "@/skills/github-app-token";
import {
  discoverSkills,
  importSkills,
  MAX_FILES_PER_SKILL,
  SkillImportError,
} from "@/skills/github-import";
import type { GithubSkillSource } from "@/skills/github-source";
import {
  normalizeAllowedTools,
  parseSkillManifest,
  SkillParseError,
} from "@/skills/parser";
import { skillCatalog } from "@/skills/skill-catalog";
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
  LabelWithDetailsSchema,
  SelectSkillVersionFileSchema,
  SelectSkillVersionSchema,
  type Skill,
  SkillFileEncodingSchema,
  SkillGithubSyncIntervalSchema,
  SkillResponseSchema,
  SkillSortBy,
  SkillUsageStatisticsSchema,
  SkillVersionMetadataSchema,
  SkillWithFilesSchema,
  UuidIdSchema,
} from "@/types";
import {
  isForeignKeyConstraintError,
  isUniqueConstraintError,
} from "@/utils/db";
import { registerEntityLabelRoutes } from "../entity-labels";

/**
 * Shared fields identifying a GitHub skill source. Authentication is optional
 * and at most one method may be supplied: a transient one-time PAT
 * (`githubToken`, never stored), a stored PAT (`githubPatId`, managed at
 * /settings/credentials), or a stored GitHub App config (`githubAppConfigId`).
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

/** Usage analytics look back this far ("the last month"). */
const USAGE_STATISTICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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

/**
 * Someone a personal skill has been shared with by name. Such a skill stays
 * `scope = 'personal'` and carries grants beside it, so this is what tells a
 * shared skill apart from a private one.
 */
const SkillUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
});

/** An environment a skill is restricted to (empty = every environment). */
const SkillEnvironmentSchema = z.object({ id: z.string(), name: z.string() });

/** A skill row plus its resource-file count, team assignments, and author. */
const SkillListItemSchema = SkillResponseSchema.extend({
  canPublish: z.boolean().optional(),
  /** The author, in the shape shared by every major object. */
  createdBy: CreatedByNullableSchema,
  fileCount: z.number(),
  teams: z.array(SkillTeamSchema),
  users: z.array(SkillUserSchema),
  environments: z.array(SkillEnvironmentSchema),
  authorName: z.string().nullable(),
  /**
   * Distinct users the usage-event log attributes activations to. 0 when all
   * recorded uses are unattributed or predate per-event tracking.
   */
  usageUserCount: z.number(),
  labels: z.array(LabelWithDetailsSchema),
});

/** A skill with its resource files, team, and environment assignments. */
const SkillDetailSchema = SkillWithFilesSchema.extend({
  createdBy: CreatedByNullableSchema,
  teams: z.array(SkillTeamSchema),
  users: z.array(SkillUserSchema),
  environments: z.array(SkillEnvironmentSchema),
  labels: z.array(LabelWithDetailsSchema),
});

/** One immutable version with its resource-file snapshots. */
const SkillVersionDetailSchema = SelectSkillVersionSchema.extend({
  files: z.array(SelectSkillVersionFileSchema),
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

/**
 * Manual create/update payload: raw SKILL.md, resource files, and the skill's
 * visibility scope.
 *
 * `files` is optional: on update, omitting it leaves the existing resource
 * files untouched; passing `[]` clears them. `scope` defaults to `personal`;
 * `teamIds` is only meaningful for `scope = 'team'`.
 */
const SkillManifestFieldsSchema = z.object({
  content: SkillManifestContentSchema,
  files: z.array(SkillFileInputSchema).max(MAX_FILES_PER_SKILL).optional(),
  scope: ResourceVisibilityScopeSchema.optional(),
  teamIds: z.array(z.string()).optional(),
  /** Only meaningful for `scope = 'personal'`; ignored for team/org skills. */
  userIds: z.array(z.string()).optional(),
  environmentIds: z
    .array(UuidIdSchema)
    .optional()
    .describe(
      "Environments the skill is restricted to. Empty (or omitted on " +
        "create) makes the skill available to agents in every " +
        "environment; otherwise only agents in one of the listed " +
        "environments see it.",
    ),
  allowedTools: z
    .array(z.string())
    .optional()
    .describe(
      "Tools the skill expects, overriding the SKILL.md `allowed-tools` " +
        "frontmatter. Omit to use the frontmatter; pass [] to clear.",
    ),
  labels: z
    .array(LabelWithDetailsSchema)
    .optional()
    .describe(
      "Key/value labels. Omit to leave existing labels untouched; pass [] " +
        "to clear them.",
    ),
});

const SkillManifestInputSchema = SkillManifestFieldsSchema.extend({
  initialGrants: z.array(ResourcePermissionGrantSchema).max(200).optional(),
}).superRefine((data, ctx) => refineUniqueFilePaths(data.files, ctx));

/**
 * Update payload: the manifest fields plus `baseVersion`, the compare-and-set
 * the `edit_skill` MCP tool already takes under the same name. The skill editor
 * sends the head its form was seeded from, so a write landing between that read
 * and the save is rejected (409) rather than silently buried. Optional, for
 * callers composing a payload that owes nothing to a prior read of the skill.
 *
 * Split from {@link SkillManifestInputSchema} because `.superRefine()` yields a
 * `ZodEffects`, which cannot be `.extend()`ed — the shared fields have to live
 * in a plain object for the update schema to add to them.
 */
const SkillManifestUpdateSchema = SkillManifestFieldsSchema.omit({
  // Who can reach a skill is decided by its resource permission policy, which
  // the permissions API writes on its own. The stored visibility columns are
  // carried through an update untouched.
  scope: true,
  teamIds: true,
  userIds: true,
})
  .extend({
    baseVersion: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "The skill's `latestVersion` when this edit was composed. Rejected " +
          "with 409 if the skill has moved past it. Omit only when the payload " +
          "owes nothing to a prior read of the skill.",
      ),
  })
  .superRefine((data, ctx) => refineUniqueFilePaths(data.files, ctx));

const BulkSkillIdsSchema = z
  .array(UuidIdSchema)
  .min(1)
  .max(MAX_BULK_IDS)
  .describe("Skills to act on. Duplicates are collapsed.");

/**
 * Per-skill outcome of a bulk operation. Partial success is the normal case:
 * ids are authorized one at a time, so one skill the caller may not touch does
 * not strand the rest of the selection.
 */
const BulkSkillOutcomeSchema = z.object({
  succeeded: z.array(z.object({ id: z.string(), name: z.string() })),
  failed: z.array(
    z.object({
      id: z.string(),
      /** Null when the id resolved to nothing the caller can see. */
      name: z.string().nullable(),
      error: z.string(),
    }),
  ),
});

type BulkSkillOutcomeEntry = { id: string; name: string };
type BulkSkillFailure = { id: string; name: string | null; error: string };

/** A comma-separated query param parsed into a string[] (mirrors the agents list). */
const CommaSeparatedIds = z.preprocess(
  (val) => (typeof val === "string" ? val.split(",").filter(Boolean) : val),
  z.array(z.string()),
);

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
  fastify.post(
    "/api/skills/:id/transfer-ownership",
    {
      schema: {
        operationId: RouteId.TransferSkillOwnership,
        description: "Transfer ownership to another organization member",
        tags: ["Ownership"],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ ownerId: z.string().min(1) }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, body, user, organizationId }) => {
      await transferResourceOwnership({
        kind: "skill",
        id: params.id,
        ownerId: body.ownerId,
        userId: user.id,
        organizationId,
      });
      return { success: true };
    },
  );

  registerEntityLabelRoutes(fastify, {
    basePath: "/api/skills",
    tag: "Skills",
    entityNamePlural: "skills",
    model: SkillLabelModel,
    keysOperationId: RouteId.GetSkillLabelKeys,
    valuesOperationId: RouteId.GetSkillLabelValues,
  });

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
            "Restrict results to native skills available through this internal " +
              "agent or eligible for publication by this saved MCP gateway.",
          ),
          mcpGatewayEnvironment: z
            .union([UuidIdSchema, z.literal("default")])
            .optional()
            .describe(
              "Preview skills eligible for MCP Gateway All mode using this " +
                "form environment. Use `default` for the Default environment.",
            ),
          agentSkillView: z
            .enum(["effective", "eligible"])
            .default("effective")
            .describe(
              "Effective applies the saved skill policy. Eligible previews the skills that All mode can include before its exclusions.",
            ),
          scope: ResourceVisibilityScopeSchema.optional().describe(
            "Filter by visibility scope: personal, team, or org.",
          ),
          teamIds: CommaSeparatedIds.optional().describe(
            "Team IDs (comma-separated); only used when scope=team.",
          ),
          authorIds: CommaSeparatedIds.optional().describe(
            "Author user IDs (comma-separated). Admin-only; used with scope=personal.",
          ),
          excludeAuthorIds: CommaSeparatedIds.optional().describe(
            "Exclude author user IDs (comma-separated). Admin-only; used with scope=personal.",
          ),
          excludeOtherPersonalSkills: z
            .preprocess(
              (val) => (typeof val === "string" ? val === "true" : val),
              z.boolean(),
            )
            .optional()
            .describe(
              "Hide personal skills owned by other users. Admin-only; no-op for non-admins.",
            ),
          status: z
            .enum(["active", "deleted"])
            .optional()
            .default("active")
            .describe(
              "Which skills to list: active (default) or the soft-deleted " +
                "trash. `deleted` is restricted to callers who manage every skill.",
            ),
          labels: z
            .string()
            .optional()
            .describe(
              "Filter by labels. Format: key1:val1|val2;key2:val3. AND across keys, OR within values.",
            ),
        }).merge(createSortingQuerySchema(SkillSortBy)),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SkillListItemSchema),
        ),
      },
    },
    async (
      {
        query: {
          limit,
          offset,
          search,
          sourceRepo,
          forAgentId,
          mcpGatewayEnvironment,
          agentSkillView,
          scope,
          teamIds,
          authorIds,
          excludeAuthorIds,
          excludeOtherPersonalSkills,
          status,
          labels,
          ...sorting
        },
        organizationId,
        user,
      },
      reply,
    ) => {
      const checker = await getSkillPermissionChecker({
        userId: user.id,
        organizationId,
      });

      // Viewing the trash is an admin surface: it needs `update` on every
      // skill (a grant at `*`). Delete is authorized per skill, so there is no
      // narrower checker-level capability to gate on.
      if (status === "deleted" && (!checker.canRead || !checker.isAdmin)) {
        throw new ApiError(403, "Forbidden");
      }

      // Skills are environment-scoped; `forAgentId` narrows the list to what
      // that agent can actually use (used by the chat slash-command menu).
      let environmentId: string | null | undefined;
      let allowedSkillIds: string[] | undefined;
      let excludedSkillIds: string[] | undefined;
      let effectiveScope = scope;
      let publishableOverMcp = false;
      if (forAgentId === undefined && mcpGatewayEnvironment !== undefined) {
        const agentChecker = await getAgentTypePermissionChecker({
          userId: user.id,
          organizationId,
        });
        agentChecker.require("mcp_gateway", "create");
        environmentId =
          mcpGatewayEnvironment === "default" ? null : mcpGatewayEnvironment;
        await assertCanAssignEnvironment({
          environmentId,
          organizationId,
          userId: user.id,
        });
        effectiveScope = "org";
        publishableOverMcp = true;
      } else if (forAgentId !== undefined) {
        const agent = await AgentModel.findById(forAgentId, user.id, true);
        if (!agent || agent.organizationId !== organizationId) {
          throw new ApiError(404, "Agent not found");
        }
        const agentChecker = await getAgentTypePermissionChecker({
          userId: user.id,
          organizationId,
        });
        try {
          agentChecker.require(agent.agentType, "read");
        } catch {
          throw new ApiError(404, "Agent not found");
        }
        if (
          !agentChecker.isAdmin(agent.agentType) &&
          !(await AgentModel.findById(forAgentId, user.id, false))
        ) {
          throw new ApiError(404, "Agent not found");
        }
        environmentId = agent.environmentId ?? null;
        if (publishesSkills(agent.agentType)) {
          publishableOverMcp = true;
          if (
            mcpGatewayEnvironment !== undefined &&
            agentSkillView !== "eligible"
          ) {
            throw new ApiError(
              400,
              "mcpGatewayEnvironment requires agentSkillView=eligible",
            );
          }
          if (agentSkillView === "eligible") {
            effectiveScope = "org";
            if (mcpGatewayEnvironment !== undefined) {
              agentChecker.require(agent.agentType, "update");
              environmentId =
                mcpGatewayEnvironment === "default"
                  ? null
                  : mcpGatewayEnvironment;
              await assertCanAssignEnvironment({
                environmentId,
                organizationId,
                userId: user.id,
              });
            }
          } else if (agent.accessAllSkills) {
            effectiveScope = "org";
            excludedSkillIds =
              await AgentExcludedSkillModel.findSkillIdsByAgent(forAgentId);
          } else {
            allowedSkillIds =
              await AgentSkillModel.findSkillIdsByAgent(forAgentId);
          }
        } else if (agent.agentType === "agent") {
          if (mcpGatewayEnvironment !== undefined) {
            throw new ApiError(
              400,
              "mcpGatewayEnvironment is available only for MCP gateways",
            );
          }
          const policy =
            await AgentActivationSkillRuleModel.findPolicySnapshot(forAgentId);
          if (!policy) {
            throw new ApiError(404, "Agent not found");
          }
          // The generic Skills table is native-only. For the eligible view,
          // activation-skills supplies the editor's complete cross-source set.
          if (agentSkillView !== "eligible") {
            if (policy.mode === "manual") {
              allowedSkillIds = policy.rules.flatMap((rule) =>
                rule.disposition === "allow" &&
                rule.reference.source === "native"
                  ? [rule.reference.skillId]
                  : [],
              );
            } else {
              excludedSkillIds = policy.rules.flatMap((rule) =>
                rule.disposition === "exclude" &&
                rule.reference.source === "native"
                  ? [rule.reference.skillId]
                  : [],
              );
            }
          }
        } else {
          throw new ApiError(400, "This agent type does not expose skills");
        }
      }
      // Non-admins see only skills within their scope; admins see all.
      let accessibleSkillIds = await SkillTeamModel.getUserAccessibleSkillIds({
        organizationId,
        userId: user.id,
        onlyExplicitGrants: !checker.canRead,
        isSkillAdmin: checker.isAdmin && checker.canRead,
      });
      if (allowedSkillIds !== undefined) {
        const accessibleSet = new Set(accessibleSkillIds);
        accessibleSkillIds = allowedSkillIds.filter((id) =>
          accessibleSet.has(id),
        );
      }

      // Author filters are an admin oversight surface (mirrors the agents
      // list); non-admins are already restricted to their own scope.
      const scopeFilters = {
        scope: effectiveScope,
        teamIds,
        authorIds: checker.isAdmin ? authorIds : undefined,
        excludeAuthorIds: checker.isAdmin ? excludeAuthorIds : undefined,
        excludeOtherPersonalForUserId:
          checker.isAdmin && excludeOtherPersonalSkills ? user.id : undefined,
        status,
      };

      // Resolved once so the page query and the count agree, and so a filter
      // that matches nothing short circuits both.
      const parsedLabels = parseLabelsParam(labels);
      const labelFilteredIds = parsedLabels
        ? await SkillLabelModel.getIdsMatchingLabels(parsedLabels)
        : undefined;

      const [skills, total] = await Promise.all([
        SkillModel.findByOrganization({
          organizationId,
          limit,
          offset,
          search,
          sourceRepo,
          accessibleSkillIds,
          excludedSkillIds,
          publishableOverMcp,
          environmentId,
          labelFilteredIds,
          ...scopeFilters,
          sorting,
        }),
        SkillModel.countByOrganization({
          organizationId,
          search,
          sourceRepo,
          accessibleSkillIds,
          excludedSkillIds,
          publishableOverMcp,
          environmentId,
          labelFilteredIds,
          ...scopeFilters,
        }),
      ]);

      const skillIds = skills.map((skill) => skill.id);
      const skillAuthorIds = [
        ...new Set(
          skills
            .map((skill) => CreatedByModel.id(skill, skill.authorId))
            .filter((id): id is string => id !== null),
        ),
      ];
      const [
        fileCounts,
        teamsBySkill,
        usersBySkill,
        environmentsBySkill,
        authorNames,
        creators,
        usageUserCounts,
        labelsBySkill,
        publicationPermissions,
      ] = await Promise.all([
        SkillFileModel.countBySkillIds(skillIds),
        SkillTeamModel.getTeamDetailsForSkills(skillIds),
        SkillUserModel.getUserDetailsForSkills(skillIds),
        SkillEnvironmentModel.getEnvironmentDetailsForSkills(skillIds),
        UserModel.getNamesByIds(skillAuthorIds),
        CreatedByModel.resolve(skillAuthorIds),
        SkillUsageEventModel.countDistinctUsersBySkillIds(skillIds),
        SkillLabelModel.getLabelsForMany(skillIds),
        agentSkillAssignmentService.getPublicationPermissions({
          organizationId,
          userId: user.id,
          skillIds,
        }),
      ]);

      return reply.send({
        data: skills.map((skill) => ({
          ...skill,
          canPublish: publicationPermissions.get(skill.id),
          // skill_files holds only bundled resources; +1 for the mandatory
          // SKILL.md (stored in the skills row) so the count matches the catalog.
          fileCount: (fileCounts.get(skill.id) ?? 0) + 1,
          teams: teamsBySkill.get(skill.id) ?? [],
          users: usersBySkill.get(skill.id) ?? [],
          environments: environmentsBySkill.get(skill.id) ?? [],
          authorName: skill.authorId
            ? (authorNames.get(skill.authorId) ?? null)
            : null,
          createdBy: lookupCreator(
            creators,
            CreatedByModel.id(skill, skill.authorId),
          ),
          usageUserCount: usageUserCounts.get(skill.id) ?? 0,
          labels: labelsBySkill.get(skill.id) ?? [],
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
      // Sharing with named people keeps the skill personal, so grants only
      // apply to that scope; a team/org skill is already reachable more widely.
      const userIds = scope === "personal" ? dedupe(body.userIds ?? []) : [];
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissions.validateRecipients({
        organizationId,
        resource: "skill",
        grants: [
          ...userIds.map((id) => ({
            subject: { type: "user" as const, id },
            actions: ["read" as const, "use" as const],
          })),
          ...teamIds.map((id) => ({
            subject: { type: "team" as const, id },
            actions: ["read" as const, "use" as const],
          })),
        ],
      });
      // SPDX-SnippetEnd

      const environmentIds = dedupe(body.environmentIds ?? []);

      await assertSkillTeams({ scope, teamIds, organizationId });

      // Always assert on create: an empty list makes the skill available in
      // every environment including the org default, which may itself be
      // restricted (mirrors the agent path).
      await assertSkillEnvironmentsAssignable({
        userId: user.id,
        organizationId,
        environmentIds,
      });

      const resourceId = crypto.randomUUID();
      if (body.initialGrants?.length) {
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        await ResourcePermissions.validateInitialGrants({
          organizationId,
          userId: user.id,
          resource: "skill",
          grants: body.initialGrants,
          target: {
            id: resourceId,
            name: parsed.name,
            authorId: user.id,
            scope,
            teams: teamIds.map((id) => ({ id })),
            users: userIds.map((id) => ({ id })),
          },
        });
        // SPDX-SnippetEnd
      }

      const skill = await withTeamFkErrorMapped(() =>
        SkillModel.createWithFiles({
          initialPermissionGrants: ResourcePermissions.grantsForCreation({
            grants: body.initialGrants,
            visibility: scope,
          }),
          skill: {
            ...toSkillInsertFields(parsed),
            organizationId,
            authorId: user.id,
            allowedTools: resolveAllowedTools(body, parsed),
            sourceType: "manual",
            scope,
          },
          files: toSkillFiles(body.files ?? []),
          teamIds,
          userIds,
          environmentIds,
        }),
      );
      if (!skill) {
        throw skillNameConflict(parsed.name);
      }
      if (userIds.length > 0) {
        await SkillUserModel.syncSkillUsers(skill.id, userIds);
      }
      if (body.labels?.length) {
        await SkillLabelModel.syncLabels(skill.id, body.labels);
      }

      return reply.send(await loadSkillDetail(skill));
    },
  );

  fastify.get(
    "/api/skills/:id",
    {
      schema: {
        operationId: RouteId.GetSkill,
        description: "Get a skill with its resource files",
        tags: ["Skills"],
        // UuidIdSchema (not z.string()): a non-uuid id — callers pass skill
        // names here — used to flow into the model and fail in Postgres with
        // "invalid input syntax for type uuid" as a 500. Reject at the
        // boundary as a 400 instead; names are not valid skill ids.
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(SkillDetailSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      const skill = await requireReadableSkill({
        id,
        userId: user.id,
        organizationId,
      });
      return reply.send(await loadSkillDetail(skill));
    },
  );

  fastify.get(
    "/api/skills/:id/usage-statistics",
    {
      schema: {
        operationId: RouteId.GetSkillUsageStatistics,
        description:
          "Per-user activation counts for a skill over the last 30 days",
        tags: ["Skills"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(SkillUsageStatisticsSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      const skill = await requireReadableSkill({
        id,
        userId: user.id,
        organizationId,
      });
      const since = new Date(Date.now() - USAGE_STATISTICS_WINDOW_MS);
      return reply.send(
        await SkillUsageEventModel.getUsageStatistics({
          skillId: skill.id,
          since,
          organizationId,
        }),
      );
    },
  );

  fastify.get(
    "/api/skills/:id/versions",
    {
      schema: {
        operationId: RouteId.GetSkillVersions,
        description:
          "List a skill's version history, newest first, as metadata only " +
          "(no SKILL.md body). Version numbers are contiguous from 1. " +
          "Paginated.",
        tags: ["Skills"],
        params: z.object({ id: UuidIdSchema }),
        querystring: PaginationQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(SkillVersionMetadataSchema),
        ),
      },
    },
    async ({ params: { id }, query, organizationId, user }, reply) => {
      const skill = await requireReadableSkill({
        id,
        userId: user.id,
        organizationId,
      });
      return reply.send(
        await SkillVersionModel.listForSkill({
          skillId: skill.id,
          organizationId,
          pagination: query,
        }),
      );
    },
  );

  fastify.get(
    "/api/skills/:id/versions/:version",
    {
      schema: {
        operationId: RouteId.GetSkillVersion,
        description:
          "Get one immutable skill version: the SKILL.md body it captured " +
          "plus its resource-file snapshots.",
        tags: ["Skills"],
        params: z.object({
          id: UuidIdSchema,
          // capped at int4 max so impossible versions 400 instead of
          // reaching Postgres as an out-of-range bind
          version: z.coerce.number().int().positive().max(2_147_483_647),
        }),
        response: constructResponseSchema(SkillVersionDetailSchema),
      },
    },
    async ({ params: { id, version }, organizationId, user }, reply) => {
      const skill = await requireReadableSkill({
        id,
        userId: user.id,
        organizationId,
      });
      const row = await SkillVersionModel.findBySkillAndVersion(
        skill.id,
        version,
      );
      if (!row) {
        throw new ApiError(404, `Skill has no version ${version}`);
      }
      return reply.send({
        ...row,
        files: await SkillVersionModel.findFiles(row.id),
      });
    },
  );

  fastify.put(
    "/api/skills/:id",
    {
      schema: {
        operationId: RouteId.UpdateSkill,
        description: "Update a skill's SKILL.md, resource files, and scope",
        tags: ["Skills"],
        params: z.object({ id: UuidIdSchema }),
        body: SkillManifestUpdateSchema,
        response: constructResponseSchema(SkillDetailSchema),
      },
    },
    async ({ params: { id }, body, organizationId, user }, reply) => {
      const existing = await findSkillOrThrow(id, organizationId);
      const parsed = parseManifestOrThrow(body.content);

      await authorizeSkillModify({
        skill: existing,
        userId: user.id,
        organizationId,
      });

      // A GitHub-synced skill's content is owned by its source repo: reject
      // manifest/file changes (Archestra-side settings — scope, teams,
      // environments — stay editable below). Disconnecting the skill from
      // GitHub makes it editable.
      if (existing.githubSyncInterval !== null) {
        assertSyncedSkillContentUnchanged({ existing, parsed, body });
      }

      // Changing a skill's environment assignments is gated like assigning
      // them: every environment in the new set must be assignable by this user.
      const existingEnvironmentIds =
        (
          await SkillEnvironmentModel.getEnvironmentIdsForSkills([existing.id])
        ).get(existing.id) ?? [];
      const newEnvironmentIds =
        body.environmentIds === undefined
          ? existingEnvironmentIds
          : dedupe(body.environmentIds);
      const environmentsChanged =
        body.environmentIds !== undefined &&
        !sameIdSet(newEnvironmentIds, existingEnvironmentIds);
      if (environmentsChanged) {
        await assertSkillEnvironmentsAssignable({
          userId: user.id,
          organizationId,
          environmentIds: newEnvironmentIds,
        });
      }

      let updated: Skill | null;
      try {
        // The metadata and files are updated in a single transaction (see
        // SkillModel.updateWithFiles). Team assignments are not touched here:
        // access lives in the skill's permission policy.
        updated = await withTeamFkErrorMapped(() =>
          SkillModel.updateWithFiles({
            id,
            skill: {
              ...toSkillInsertFields(parsed),
              allowedTools: resolveAllowedTools(body, parsed),
            },
            files:
              body.files === undefined ? undefined : toSkillFiles(body.files),
            environmentIds: environmentsChanged ? newEnvironmentIds : undefined,
            // Compare-and-set against the head the caller composed from; the
            // transaction rejects (409) rather than burying a concurrent edit.
            expectedLatestVersion: body.baseVersion,
          }),
        );
      } catch (error) {
        // Name conflict within the skill's visibility namespace — not a team FK
        // (mapped above) or a duplicate resource-file path (rejected at input).
        // The version-conflict 409 raised inside the transaction is an ApiError,
        // not a unique violation, so it passes through this check untouched.
        if (isSkillNameConflict(error)) {
          throw skillNameConflict(parsed.name);
        }
        throw error;
      }

      if (!updated) {
        throw new ApiError(404, "Skill not found");
      }
      // Only touch labels when the caller sent them, so an update that omits
      // the field leaves existing labels alone.
      if (body.labels !== undefined) {
        await SkillLabelModel.syncLabels(id, body.labels);
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
      const accessibleSkillIds = await SkillTeamModel.getUserAccessibleSkillIds(
        {
          organizationId,
          userId: user.id,
          isSkillAdmin: checker.isAdmin,
        },
      );

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
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      const skill = await findSkillOrThrow(id, organizationId);

      await authorizeSkillModify({
        skill,
        userId: user.id,
        organizationId,
        action: "delete",
      });

      const success = await SkillModel.delete(id);
      if (!success) {
        throw new ApiError(404, "Skill not found");
      }
      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/skills/bulk-delete",
    {
      schema: {
        operationId: RouteId.BulkDeleteSkills,
        description:
          "Soft-delete several skills in one request. Each id is authorized " +
          "exactly as the single-skill delete authorizes its own: an id the " +
          "caller cannot see or modify is reported in `failed` and the rest " +
          "of the batch still applies. Deleted skills keep their versions and " +
          "resource files and can be restored from the trash.",
        tags: ["Skills"],
        body: z.object({ skillIds: BulkSkillIdsSchema }),
        response: constructResponseSchema(BulkSkillOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { organizationId, user, body } = request;
      const skillIds = dedupe(body.skillIds);

      const context = await loadBulkSkillContext({
        skillIds,
        userId: user.id,
        organizationId,
      });
      request.auditBefore = await buildBulkSkillAuditSnapshot({
        skillIds,
        organizationId,
      });

      const deletable: BulkSkillOutcomeEntry[] = [];
      const failed: BulkSkillFailure[] = [];

      for (const id of skillIds) {
        const skill = context.skillsById.get(id);
        if (
          !skill ||
          (!context.isVisible(skill) &&
            !context.checker.allowsScoped?.(id, "delete"))
        ) {
          failed.push({ id, name: null, error: "Skill not found" });
          continue;
        }
        try {
          requireSkillModifyPermission({
            checker: context.checker,
            skillId: id,
            action: "delete",
          });
        } catch (error) {
          if (error instanceof ApiError) {
            failed.push({ id, name: skill.name, error: error.message });
            continue;
          }
          throw error;
        }
        deletable.push({ id, name: skill.name });
      }

      // One statement rather than a delete per id: a soft delete cannot
      // conflict with anything (it frees the name rather than claiming one),
      // so there is no per-skill failure left for the write itself to produce.
      await SkillModel.deleteMany(deletable.map((entry) => entry.id));

      request.auditAfter = await buildBulkSkillAuditSnapshot({
        skillIds,
        organizationId,
      });
      return reply.send({ succeeded: deletable, failed });
    },
  );

  fastify.post(
    "/api/skills/:id/restore",
    {
      schema: {
        operationId: RouteId.RestoreSkill,
        description: "Restore a soft-deleted skill",
        tags: ["Skills"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(SkillDetailSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      // The soft-deleted row: findById/findSkillOrThrow filter deleted rows and
      // would 404 every restore. Authorize this object directly — junction
      // rows survive soft-delete, so its scope/team lookups still resolve.
      const skill = await SkillModel.findDeletedById(id, organizationId);
      if (!skill) {
        throw new ApiError(404, "Skill not found");
      }

      await authorizeSkillModify({
        skill,
        userId: user.id,
        organizationId,
        action: "delete",
      });

      const conflictMessage = await SkillModel.getRestoreConflictMessage(skill);
      if (conflictMessage) {
        throw new ApiError(409, conflictMessage);
      }

      let success: boolean;
      try {
        success = await SkillModel.restore(id);
      } catch (error) {
        // The pre-check is advisory; the partial unique index is the real
        // guard. A create can claim the freed name between the check and this
        // UPDATE — map that violation to a 409 rather than a 500.
        if (
          isUniqueConstraintError(error, "skills_org_personal_name_idx") ||
          isUniqueConstraintError(error, "skills_org_shared_name_idx")
        ) {
          throw skillNameConflict(skill.name);
        }
        throw error;
      }
      if (!success) {
        throw new ApiError(404, "Skill not found");
      }

      // The row is active again, so the normal detail path is safe.
      const restored = await findSkillOrThrow(id, organizationId);
      return reply.send(await loadSkillDetail(restored));
    },
  );

  fastify.delete(
    "/api/skills/:id/permanent",
    {
      schema: {
        operationId: RouteId.PermanentlyDeleteSkill,
        description:
          "Permanently destroy a soft-deleted skill (global admins only). " +
          "Irreversible, with no grace period: every version and resource file " +
          "is destroyed, along with the skill's team and user grants, " +
          "environment assignments, usage events, and share links — so any " +
          "public share URL for it stops working. 404 if there is no " +
          "soft-deleted skill with that id in the org, which is also the " +
          "answer when the skill is still live or the caller is not a global " +
          "admin. 409 while a sandbox still has the skill mounted; that is " +
          "retryable, but note nothing clears a mount on its own — it lasts as " +
          "long as the sandbox does. Built-in skills cannot be purged: their " +
          "soft-deleted row is what stops the seeder recreating them on the " +
          "next restart. Restore wins a race.",
        tags: ["Skills"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      // Checked before the skill is read: a caller who is not a global admin
      // gets the same 404 whatever the id, so the endpoint never confirms the
      // skill exists. `skill:admin` deliberately does not reach here — it is an
      // oversight grant, and this destroys the bytes for good.
      if (!(await isGlobalAdmin(user.id, organizationId))) {
        throw new ApiError(404, "Skill not found");
      }

      const skill = await SkillModel.findDeletedById(id, organizationId);
      if (!skill) {
        throw new ApiError(404, "Skill not found");
      }

      // A built-in's soft-deleted row IS the opt-out: `SkillModel.findBuiltIn`
      // includes deleted rows precisely so the startup seeder sees one and
      // skips it. Destroying the row would hand the skill back on the next
      // boot, making "permanent" deletion both untrue and silently
      // opt-out-reverting. 403 rather than 404 — the skill is visibly in the
      // trash to anyone who can list it, so there is nothing to conceal.
      if (skill.sourceType === "built_in") {
        throw new ApiError(
          403,
          "Built-in skills cannot be permanently deleted. Deleting one already " +
            "removes it for good — its retained record is what stops it being " +
            "recreated on the next restart.",
        );
      }

      if (await SkillVersionModel.hasSandboxMountsForSkill(id)) {
        throw skillStillMounted();
      }

      let purged: boolean;
      try {
        purged = await SkillModel.purge({ id, organizationId });
      } catch (error) {
        // The pre-check above is advisory; the RESTRICT foreign key is the real
        // guard, and a sandbox can mount the skill between the two. Map that to
        // the same 409 rather than a 500. Caught HERE, outside the model's
        // transaction: a foreign-key violation aborts the whole Postgres
        // transaction, so nothing inside it could have recovered.
        if (isForeignKeyConstraintError(error)) {
          throw skillStillMounted();
        }
        throw error;
      }
      if (!purged) {
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
        params: z.object({ id: UuidIdSchema }),
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
        params: z.object({ id: UuidIdSchema }),
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
    async ({ query: { q, limit }, organizationId }, reply) => {
      await assertOnlineSkillCatalogEnabled(organizationId);
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
      await assertOnlineSkillCatalogEnabled(organizationId);
      const githubCredentials = await resolveGithubImportCredentials({
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
          ...githubCredentials,
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
      await assertOnlineSkillCatalogEnabled(organizationId);
      const githubCredentials = await resolveGithubImportCredentials({
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
          ...githubCredentials,
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
            initialGrants: z
              .array(ResourcePermissionGrantSchema)
              .max(200)
              .optional(),
            scope: ResourceVisibilityScopeSchema.optional(),
            teamIds: z.array(z.string()).optional(),
            /** Only meaningful for `scope = 'personal'`. */
            userIds: z.array(z.string()).optional(),
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
            created: z.array(SkillResponseSchema),
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
      await assertOnlineSkillCatalogEnabled(organizationId);
      // Imported skills carry an explicit scope, authorized like manual create;
      // when omitted they default to `personal` so a bulk import is never
      // silently published org-wide.
      const scope = body.scope ?? "personal";
      const teamIds = scope === "team" ? dedupe(body.teamIds ?? []) : [];
      // Sharing with named people keeps a skill personal, so grants only apply
      // to that scope; every skill in this import gets the same set.
      const userIds = scope === "personal" ? dedupe(body.userIds ?? []) : [];

      await assertSkillTeams({ scope, teamIds, organizationId });

      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissions.validateRecipients({
        organizationId,
        resource: "skill",
        grants: [
          ...userIds.map((id) => ({
            subject: { type: "user" as const, id },
            actions: ["read" as const, "use" as const],
          })),
          ...teamIds.map((id) => ({
            subject: { type: "team" as const, id },
            actions: ["read" as const, "use" as const],
          })),
        ],
      });
      // SPDX-SnippetEnd
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissions.validateInitialGrants({
        organizationId,
        userId: user.id,
        resource: "skill",
        grants: body.initialGrants ?? [],
        target: {
          id: crypto.randomUUID(),
          name: "Imported skill",
          authorId: user.id,
          scope,
          teams: teamIds.map((id) => ({ id })),
          users: userIds.map((id) => ({ id })),
        },
      });
      // SPDX-SnippetEnd
      const githubCredentials = await resolveGithubImportCredentials({
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
          ...githubCredentials,
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
              sourceOrigin: item.sourceOrigin,
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
            userIds,
            initialPermissionGrants: ResourcePermissions.grantsForCreation({
              grants: body.initialGrants,
              visibility: scope,
            }),
            // version 1 is exactly what the repo held at this commit.
            versionSourceCommit: item.sourceCommit,
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
 * Gate every server path that reaches the public online skill catalog on the
 * organization's `onlineSkillCatalogEnabled` setting.
 *
 * The setting used to be advisory: only the add-skill wizard read it, so
 * turning it off hid the source picker while the catalog search and the GitHub
 * discover/preview/import endpoints stayed reachable by anything that speaks
 * HTTP. Enforcing it here makes the admin's choice binding for direct API
 * calls and scripts too, not only for the UI.
 *
 * Deliberately NOT gated:
 * - Authoring a skill from content the caller supplies (`POST /api/skills`,
 *   and the `create_skill`/`update_skill`/`edit_skill` chat tools). Those never
 *   touch the online catalog, and the setting's own copy promises that
 *   disabling it leaves the blank-template editor available.
 * - Pulls for skills that were already imported (`PATCH
 *   /api/skills/:id/github-sync` and the scheduled sync). They re-fetch the
 *   repo and path already recorded on the skill and cannot introduce a new
 *   source, so disabling the catalog stops new online skills arriving instead
 *   of silently freezing the ones an org already runs.
 */
async function assertOnlineSkillCatalogEnabled(
  organizationId: string,
): Promise<void> {
  const enabled =
    await OrganizationModel.getOnlineSkillCatalogEnabled(organizationId);
  if (!enabled) {
    throw new ApiError(
      403,
      "The online skill catalog is disabled for this organization. Skills " +
        "can still be written by hand, but they cannot be discovered or " +
        "imported from GitHub.",
    );
  }
}

/**
 * Assigning a skill to restricted environments asks for a `use` grant on each
 * environment, the same question the agent and MCP-catalog assignment paths
 * ask. An empty set (skill available in every environment, including the org
 * default) is gated like assigning the default environment. Throws 403/404 if
 * the caller may not assign an environment.
 */
async function assertSkillEnvironmentsAssignable(params: {
  userId: string;
  organizationId: string;
  environmentIds: string[];
}): Promise<void> {
  const { userId, organizationId, environmentIds } = params;
  if (environmentIds.length === 0) {
    await assertCanAssignEnvironment({
      environmentId: null,
      organizationId,
      userId,
    });
    return;
  }
  for (const environmentId of environmentIds) {
    await assertCanAssignEnvironment({ environmentId, organizationId, userId });
  }
}

/**
 * Keep the configured GitHub host with App credentials through every import
 * request. PAT and anonymous imports retain their github.com destination.
 */
async function resolveGithubImportCredentials(params: {
  githubToken?: string;
  githubAppConfigId?: string;
  githubPatId?: string;
  organizationId: string;
  userId: string;
}): Promise<{ githubToken?: string; githubSource?: GithubSkillSource }> {
  const {
    githubToken,
    githubAppConfigId,
    githubPatId,
    organizationId,
    userId,
  } = params;
  if (!githubAppConfigId && !githubPatId) {
    return { githubToken };
  }

  // using a stored credential requires read access to GitHub credentials
  const allowed = await userHasPermission(
    userId,
    organizationId,
    "credential",
    "read",
  );
  if (!allowed) {
    throw new ApiError(403, "You do not have access to GitHub credentials");
  }

  if (githubPatId) {
    return {
      githubToken: await resolveGithubPatToken({ githubPatId, organizationId }),
    };
  }
  return resolveGithubSkillAppCredentials({
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

/**
 * Resolve a live skill and enforce the full read-access path: org scoping
 * plus scope/team/author visibility. Every failure is a 404 so existence is
 * never leaked to users who cannot see the skill. Version reads don't filter
 * soft-deletes themselves, so resolving the live skill here (findSkillOrThrow
 * excludes deleted rows) is what keeps a deleted skill's history unreachable.
 */
async function requireReadableSkill(params: {
  id: string;
  userId: string;
  organizationId: string;
}): Promise<Skill> {
  const skill = await findSkillOrThrow(params.id, params.organizationId);
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  const effective = await ResourcePermissions.getEffective({
    organizationId: params.organizationId,
    userId: params.userId,
    resource: "skill",
    scope: params.id,
  });
  // SPDX-SnippetEnd
  if (!effective.grants.some((grant) => grant.action === "read"))
    throw new ApiError(404, "Skill not found");
  return skill;
}

/** A skill with its files, team, and environment assignments, for detail responses. */
async function loadSkillDetail(skill: Skill) {
  const [
    files,
    teamsBySkill,
    usersBySkill,
    environmentsBySkill,
    createdBy,
    labels,
  ] = await Promise.all([
    SkillFileModel.findBySkillId(skill.id),
    SkillTeamModel.getTeamDetailsForSkills([skill.id]),
    SkillUserModel.getUserDetailsForSkills([skill.id]),
    SkillEnvironmentModel.getEnvironmentDetailsForSkills([skill.id]),
    CreatedByModel.resolveOne(CreatedByModel.id(skill, skill.authorId)),
    SkillLabelModel.getLabelsFor(skill.id),
  ]);
  return {
    ...skill,
    createdBy,
    files,
    teams: teamsBySkill.get(skill.id) ?? [],
    users: usersBySkill.get(skill.id) ?? [],
    environments: environmentsBySkill.get(skill.id) ?? [],
    labels,
  };
}

/**
 * Everything the bulk routes need to authorize a batch of skills, read in a
 * fixed number of queries rather than per skill: the caller's skill
 * permissions and teams, the skills themselves fenced to the organization,
 * their current team assignments and per-person grants, and a visibility test.
 *
 * The organization fence is load-bearing. Skill ids arrive straight from the
 * request body, and `requireSkillModifyPermission` short-circuits for an
 * admin — where "admin" means admin of the CALLER's organization — so without
 * fencing here a foreign-org id would sail past the scope checks. Dropping it
 * from the map instead makes it indistinguishable from a nonexistent id, which
 * is what the single-skill routes answer too.
 */
async function loadBulkSkillContext(params: {
  skillIds: string[];
  userId: string;
  organizationId: string;
}): Promise<{
  checker: SkillPermissionChecker;
  userTeamIds: string[];
  skillsById: Map<string, Skill>;
  teamIdsBySkill: Map<string, string[]>;
  userIdsBySkill: Map<string, string[]>;
  isVisible: (skill: Skill) => boolean;
}> {
  const { skillIds, userId, organizationId } = params;

  const checker = await getSkillPermissionChecker({ userId, organizationId });
  const [skills, userTeamIds, accessibleIds] = await Promise.all([
    SkillModel.findByIds(skillIds),
    checker.isAdmin
      ? Promise.resolve<string[]>([])
      : TeamModel.getUserTeamIds(userId),
    SkillTeamModel.getUserAccessibleSkillIds({
      organizationId,
      userId,
      isSkillAdmin: checker.isAdmin,
    }),
  ]);

  const skillsById = new Map(
    skills
      .filter((skill) => skill.organizationId === organizationId)
      .map((skill) => [skill.id, skill]),
  );
  const foundIds = [...skillsById.keys()];
  const [teamsBySkill, usersBySkill] = await Promise.all([
    SkillTeamModel.getTeamDetailsForSkills(foundIds),
    SkillUserModel.getUserDetailsForSkills(foundIds),
  ]);
  const accessibleIdSet = accessibleIds ? new Set(accessibleIds) : null;

  return {
    checker,
    userTeamIds,
    skillsById,
    teamIdsBySkill: new Map(
      [...teamsBySkill].map(([id, teams]) => [id, teams.map((t) => t.id)]),
    ),
    userIdsBySkill: new Map(
      [...usersBySkill].map(([id, users]) => [id, users.map((u) => u.id)]),
    ),
    isVisible: (skill) =>
      accessibleIdSet === null || accessibleIdSet.has(skill.id),
  };
}

/**
 * Per-skill visibility snapshot for a bulk route's audit record, used for both
 * the before and after side.
 *
 * The registry's generic `fetchById` cannot express this: a batch has no single
 * resource id, and the snapshot has to be derived from the request body, which
 * `fetchById` never sees. Soft-deleted rows are included so a bulk delete's
 * "after" side still names what it removed rather than going empty.
 *
 * Assigning this to `auditBefore` bypasses the hook's sanitizer, which is safe
 * here: the snapshot is ids, names, scopes and a deleted flag, with nothing
 * secret in it.
 */
async function buildBulkSkillAuditSnapshot(params: {
  skillIds: string[];
  organizationId: string;
}): Promise<Record<string, unknown>> {
  const rows = await SkillModel.findVisibilityForAudit({
    ids: params.skillIds,
    organizationId: params.organizationId,
  });
  const ids = rows.map((row) => row.id);
  const [teamsBySkill, usersBySkill] = await Promise.all([
    SkillTeamModel.getTeamDetailsForSkills(ids),
    SkillUserModel.getUserDetailsForSkills(ids),
  ]);
  return {
    skills: rows.map((row) => ({
      ...row,
      // Sorted so two reads of an unchanged batch produce an identical
      // snapshot and the audit diff stays empty; row order is unspecified.
      teamIds: (teamsBySkill.get(row.id) ?? []).map((team) => team.id).sort(),
      userIds: (usersBySkill.get(row.id) ?? []).map((user) => user.id).sort(),
    })),
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Whether two id lists contain the same set of ids. */
function sameIdSet(a: string[], b: string[]): boolean {
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
 * Authorize a modify (update/delete/reset) on an existing skill: the caller
 * must be able to see it — else 404, not 403, so scope is not leaked to users
 * who cannot see the skill — and hold the action on it through a grant.
 */
async function authorizeSkillModify(params: {
  skill: Skill;
  userId: string;
  organizationId: string;
  action?: "update" | "delete";
}): Promise<void> {
  const { skill, userId, organizationId } = params;

  const checker = await getSkillPermissionChecker({ userId, organizationId });

  if (!skill.deletedAt) {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const effective = await ResourcePermissions.getEffective({
      organizationId,
      userId,
      resource: "skill",
      scope: skill.id,
    });
    // SPDX-SnippetEnd
    if (
      !effective.grants.some(
        (grant) =>
          grant.action === "read" ||
          grant.action === (params.action ?? "update"),
      )
    )
      throw new ApiError(404, "Skill not found");
    if (
      !effective.grants.some(
        (grant) => grant.action === (params.action ?? "update"),
      )
    )
      throw new ApiError(
        403,
        "You do not have permission to modify this skill",
      );
  } else {
    const visible = await SkillTeamModel.userHasSkillAccess({
      organizationId,
      userId,
      skill,
    });
    if (
      !visible &&
      !checker.allowsScoped?.(skill.id, params.action ?? "update")
    )
      throw new ApiError(404, "Skill not found");
    requireSkillModifyPermission({
      checker,
      skillId: skill.id,
      action: params.action,
    });
  }
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

/**
 * A sandbox still mounts one of the skill's versions, and the mount pins those
 * bytes (`ON DELETE RESTRICT`), so they cannot be destroyed yet. Says plainly
 * that retrying is the remedy AND that nothing clears a mount on its own — a
 * bare "try again later" would imply a wait that may never end.
 */
function skillStillMounted(): ApiError {
  return new ApiError(
    409,
    "This skill is still mounted in a code sandbox, which pins the version " +
      "files being deleted. Retry once those sandboxes are gone; note that a " +
      "mount lasts as long as its sandbox, which is not cleaned up on a timer.",
  );
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
