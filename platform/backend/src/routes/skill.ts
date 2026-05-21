import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import {
  OrganizationModel,
  SkillFileModel,
  SkillModel,
  ToolModel,
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
import { isUniqueConstraintError } from "@/utils/db";

/** A skill row plus its resource-file count, for the catalog list. */
const SkillListItemSchema = SelectSkillSchema.extend({
  fileCount: z.number(),
});

/** Raw resource file as submitted by the in-app editor. */
const SkillFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string().max(MAX_SKILL_FILE_CONTENT_CHARS),
  encoding: SkillFileEncodingSchema.optional(),
});

/**
 * Manual create/update payload: raw SKILL.md plus resource files.
 *
 * `files` is optional: on update, omitting it leaves the existing resource
 * files untouched; passing `[]` clears them.
 */
const SkillManifestInputSchema = z.object({
  content: z.string().min(1).max(MAX_SKILL_FILE_BYTES),
  files: z.array(SkillFileInputSchema).max(MAX_FILES_PER_SKILL).optional(),
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
      { query: { limit, offset, search, sourceRepo }, organizationId },
      reply,
    ) => {
      const [skills, total] = await Promise.all([
        SkillModel.findByOrganization({
          organizationId,
          limit,
          offset,
          search,
          sourceRepo,
        }),
        SkillModel.countByOrganization({ organizationId, search, sourceRepo }),
      ]);

      const fileCounts = await SkillFileModel.countBySkillIds(
        skills.map((skill) => skill.id),
      );

      return reply.send({
        data: skills.map((skill) => ({
          ...skill,
          fileCount: fileCounts.get(skill.id) ?? 0,
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
        response: constructResponseSchema(SkillWithFilesSchema),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      const parsed = parseManifestOrThrow(body.content);

      const skill = await SkillModel.createWithFiles({
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
        },
        files: toSkillFiles(body.files ?? []),
      });
      if (!skill) {
        throw skillNameConflict(parsed.name);
      }

      return reply.send({ ...skill, files: await loadFiles(skill.id) });
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
        response: constructResponseSchema(SkillWithFilesSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const skill = await findSkillOrThrow(id, organizationId);
      return reply.send({ ...skill, files: await loadFiles(skill.id) });
    },
  );

  fastify.put(
    "/api/skills/:id",
    {
      schema: {
        operationId: RouteId.UpdateSkill,
        description: "Update a skill's SKILL.md and resource files",
        tags: ["Skills"],
        params: z.object({ id: z.string() }),
        body: SkillManifestInputSchema,
        response: constructResponseSchema(SkillWithFilesSchema),
      },
    },
    async ({ params: { id }, body, organizationId }, reply) => {
      await findSkillOrThrow(id, organizationId);
      const parsed = parseManifestOrThrow(body.content);

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

      return reply.send({ ...updated, files: await loadFiles(id) });
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
    async ({ organizationId }, reply) => {
      const repos = await SkillModel.findDistinctSourceRepos(organizationId);
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
    async ({ params: { id }, organizationId }, reply) => {
      await findSkillOrThrow(id, organizationId);
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
        const skill = await SkillModel.createWithFiles({
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
          },
          files: item.files,
        });
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
