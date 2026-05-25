import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  type ResourceVisibilityScope,
  ResourceVisibilityScopeSchema,
  RouteId,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getSkillPermissionChecker,
  requireSkillModifyPermission,
  type SkillPermissionChecker,
} from "@/auth/skill-permissions";
import logger from "@/logging";
import {
  OrganizationModel,
  SkillFileModel,
  SkillModel,
  SkillTeamModel,
  TeamModel,
  ToolModel,
  UserModel,
} from "@/models";
import {
  discoverSkills,
  importSkills,
  MAX_FILES_PER_SKILL,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILE_CONTENT_CHARS,
  SkillImportError,
} from "@/skills/github-import";
import {
  deriveSkillFileKind,
  parseSkillManifest,
  SkillParseError,
} from "@/skills/parser";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  SelectSkillSchema,
  type Skill,
  SkillFileEncodingSchema,
  SkillWithFilesSchema,
} from "@/types";
import {
  isForeignKeyConstraintError,
  isUniqueConstraintError,
} from "@/utils/db";

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

/** Raw resource file as submitted by the in-app editor. */
const SkillFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string().max(MAX_SKILL_FILE_CONTENT_CHARS),
  encoding: SkillFileEncodingSchema.optional(),
});

/**
 * Manual create/update payload: raw SKILL.md, resource files, and the skill's
 * visibility scope.
 *
 * `files` is optional: on update, omitting it leaves the existing resource
 * files untouched; passing `[]` clears them. `scope` defaults to `personal`;
 * `teamIds` is only meaningful for `scope = 'team'`.
 */
const SkillManifestInputSchema = z.object({
  content: z.string().min(1).max(MAX_SKILL_FILE_BYTES),
  files: z.array(SkillFileInputSchema).max(MAX_FILES_PER_SKILL).optional(),
  scope: ResourceVisibilityScopeSchema.optional(),
  teamIds: z.array(z.string()).optional(),
});

const DiscoveredSkillSchema = z.object({
  skillPath: z.string(),
  name: z.string(),
  description: z.string(),
  compatibility: z.string().nullable(),
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
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SkillListItemSchema),
        ),
      },
    },
    async (
      { query: { limit, offset, search, sourceRepo }, organizationId, user },
      reply,
    ) => {
      const checker = await getSkillPermissionChecker({
        userId: user.id,
        organizationId,
      });
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
        }),
        SkillModel.countByOrganization({
          organizationId,
          search,
          sourceRepo,
          accessibleSkillIds,
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
          fileCount: fileCounts.get(skill.id) ?? 0,
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

      const checker = await getSkillPermissionChecker({
        userId: user.id,
        organizationId,
      });
      const userTeamIds = checker.isAdmin
        ? []
        : await TeamModel.getUserTeamIds(user.id);
      authorizeSkillScope({
        checker,
        scope,
        authorId: user.id,
        requestedTeamIds: teamIds,
        userTeamIds,
        userId: user.id,
      });
      await assertSkillTeams({ scope, teamIds, organizationId });

      const skill = await withTeamFkErrorMapped(() =>
        SkillModel.createWithFiles({
          skill: {
            organizationId,
            authorId: user.id,
            name: parsed.name,
            description: parsed.description,
            content: parsed.content,
            license: parsed.license,
            compatibility: parsed.compatibility,
            metadata: parsed.metadata,
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

      const checker = await getSkillPermissionChecker({
        userId: user.id,
        organizationId,
      });
      const userTeamIds = checker.isAdmin
        ? []
        : await TeamModel.getUserTeamIds(user.id);
      const existingTeamIds = await SkillTeamModel.getTeamsForSkill(id);

      // 404 if the user cannot even see the skill; 403 if visible but not theirs to modify.
      const hasAccess = await SkillTeamModel.userHasSkillAccess({
        organizationId,
        userId: user.id,
        skill: existing,
        isSkillAdmin: checker.isAdmin,
      });
      if (!hasAccess) {
        throw new ApiError(404, "Skill not found");
      }
      requireSkillModifyPermission({
        checker,
        scope: existing.scope,
        authorId: existing.authorId,
        skillTeamIds: existingTeamIds,
        userTeamIds,
        userId: user.id,
      });

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

      let updated: Skill | null;
      try {
        updated = await SkillModel.updateWithFiles({
          id,
          skill: {
            name: parsed.name,
            description: parsed.description,
            content: parsed.content,
            license: parsed.license,
            compatibility: parsed.compatibility,
            metadata: parsed.metadata,
            scope: newScope,
          },
          files:
            body.files === undefined ? undefined : toSkillFiles(body.files),
        });
      } catch (error) {
        // only the org+name index — not a duplicate resource-file path
        if (isUniqueConstraintError(error, "skills_org_name_idx")) {
          throw skillNameConflict(parsed.name);
        }
        throw error;
      }

      if (!updated) {
        throw new ApiError(404, "Skill not found");
      }
      if (scopeChanged || teamsChanged) {
        await withTeamFkErrorMapped(() =>
          SkillTeamModel.syncSkillTeams(id, newTeamIds),
        );
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

      const checker = await getSkillPermissionChecker({
        userId: user.id,
        organizationId,
      });
      const userTeamIds = checker.isAdmin
        ? []
        : await TeamModel.getUserTeamIds(user.id);
      const teamIds = await SkillTeamModel.getTeamsForSkill(id);

      const hasAccess = await SkillTeamModel.userHasSkillAccess({
        organizationId,
        userId: user.id,
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
        skillTeamIds: teamIds,
        userTeamIds,
        userId: user.id,
      });

      const success = await SkillModel.delete(id);
      if (!success) {
        throw new ApiError(404, "Skill not found");
      }
      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/skills/enable-defaults",
    {
      schema: {
        operationId: RouteId.EnableSkillToolDefaults,
        description:
          "Enable the Agent Skill tools (`list_skills`, `activate_skill`, `read_skill_file`) for this organization. Sets the org-level flag and backfills the tools onto every existing agent. Idempotent.",
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

  fastify.post(
    "/api/skills/github/discover",
    {
      schema: {
        operationId: RouteId.DiscoverGithubSkills,
        description: "Discover skills in a GitHub repository",
        tags: ["Skills"],
        body: z.object({
          repoUrl: z.string().min(1),
          path: z.string().optional(),
          githubToken: z.string().optional(),
        }),
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
    async ({ body, organizationId }, reply) => {
      const result = await runImport(() =>
        discoverSkills({
          repoUrl: body.repoUrl,
          path: body.path,
          githubToken: body.githubToken,
        }),
      );

      // Flag skills whose name already exists in the org so the UI can disable
      // them in the multi-select.
      const skills = await Promise.all(
        result.skills.map(async (skill) => ({
          ...skill,
          exists:
            (await SkillModel.findByName(organizationId, skill.name)) !== null,
        })),
      );

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
        body: z.object({
          repoUrl: z.string().min(1),
          path: z.string().optional(),
          githubToken: z.string().optional(),
          skillPath: z.string(),
        }),
        response: constructResponseSchema(
          z.object({
            name: z.string(),
            description: z.string(),
            content: z.string(),
            license: z.string().nullable(),
            compatibility: z.string().nullable(),
            metadata: z.record(z.string(), z.string()),
            files: z.array(
              z.object({
                path: z.string(),
                content: z.string(),
                encoding: SkillFileEncodingSchema,
                kind: z.enum(["reference", "script", "asset"]),
              }),
            ),
            sourceRef: z.string(),
            sourceCommit: z.string(),
          }),
        ),
      },
    },
    async ({ body }, reply) => {
      const [item] = await runImport(() =>
        importSkills({
          repoUrl: body.repoUrl,
          path: body.path,
          githubToken: body.githubToken,
          skillPaths: [body.skillPath],
        }),
      );
      if (!item) {
        throw new ApiError(404, `Skill not found at ${body.skillPath}`);
      }
      return reply.send({
        ...item.parsed,
        files: item.files,
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
        body: z.object({
          repoUrl: z.string().min(1),
          path: z.string().optional(),
          githubToken: z.string().optional(),
          skillPaths: z.array(z.string()).min(1),
          scope: ResourceVisibilityScopeSchema.optional(),
          teamIds: z.array(z.string()).optional(),
        }),
        response: constructResponseSchema(
          z.object({
            created: z.array(SelectSkillSchema),
            skipped: z.array(z.string()),
          }),
        ),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      // Imported skills carry an explicit scope, authorized like manual create;
      // when omitted they default to `personal` so a bulk import is never
      // silently published org-wide.
      const scope = body.scope ?? "personal";
      const teamIds = scope === "team" ? dedupe(body.teamIds ?? []) : [];

      const checker = await getSkillPermissionChecker({
        userId: user.id,
        organizationId,
      });
      const userTeamIds = checker.isAdmin
        ? []
        : await TeamModel.getUserTeamIds(user.id);
      authorizeSkillScope({
        checker,
        scope,
        authorId: user.id,
        requestedTeamIds: teamIds,
        userTeamIds,
        userId: user.id,
      });
      await assertSkillTeams({ scope, teamIds, organizationId });

      const imported = await runImport(() =>
        importSkills({
          repoUrl: body.repoUrl,
          path: body.path,
          githubToken: body.githubToken,
          skillPaths: body.skillPaths,
        }),
      );

      const created: Skill[] = [];
      const skipped: string[] = [];
      for (const item of imported) {
        const skill = await withTeamFkErrorMapped(() =>
          SkillModel.createWithFiles({
            skill: {
              organizationId,
              authorId: user.id,
              name: item.parsed.name,
              description: item.parsed.description,
              content: item.parsed.content,
              license: item.parsed.license,
              compatibility: item.parsed.compatibility,
              metadata: item.parsed.metadata,
              sourceType: "github",
              sourceRef: item.sourceRef,
              sourceCommit: item.sourceCommit,
              scope,
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
      }

      logger.info(
        { organizationId, created: created.length, skipped: skipped.length },
        "[Skills] GitHub import complete",
      );

      return reply.send({ created, skipped });
    },
  );
};

// ===== Internal helpers =====

async function findSkillOrThrow(id: string, organizationId: string) {
  const skill = await SkillModel.findById(id);
  if (!skill || skill.organizationId !== organizationId) {
    throw new ApiError(404, "Skill not found");
  }
  return skill;
}

async function loadFiles(skillId: string) {
  return await SkillFileModel.findBySkillId(skillId);
}

/** A skill with its files and team assignments, for detail responses. */
async function loadSkillDetail(skill: Skill) {
  const [files, teamsBySkill] = await Promise.all([
    loadFiles(skill.id),
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

function toSkillFiles(
  files: { path: string; content: string; encoding?: "utf8" | "base64" }[],
) {
  return files.map((file) => ({
    path: file.path,
    content: file.content,
    encoding: file.encoding ?? "utf8",
    kind: deriveSkillFileKind(file.path),
  }));
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
