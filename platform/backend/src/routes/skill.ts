import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { SkillFileModel, SkillModel } from "@/models";
import {
  discoverSkills,
  importSkills,
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
  SkillWithFilesSchema,
} from "@/types";

/** A skill row plus its resource-file count, for the catalog list. */
const SkillListItemSchema = SelectSkillSchema.extend({
  fileCount: z.number(),
});

/** Raw resource file as submitted by the in-app editor. */
const SkillFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

/** Manual create/update payload: raw SKILL.md plus resource files. */
const SkillManifestInputSchema = z.object({
  content: z.string().min(1),
  files: z.array(SkillFileInputSchema).default([]),
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
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SkillListItemSchema),
        ),
      },
    },
    async ({ query: { limit, offset, search }, organizationId }, reply) => {
      const [skills, total] = await Promise.all([
        SkillModel.findByOrganization({
          organizationId,
          limit,
          offset,
          search,
        }),
        SkillModel.countByOrganization({ organizationId, search }),
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
      await assertNameAvailable(organizationId, parsed.name);

      const files = toSkillFiles(body.files);
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
        files,
      });

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
      const existing = await findSkillOrThrow(id, organizationId);
      const parsed = parseManifestOrThrow(body.content);

      if (parsed.name !== existing.name) {
        await assertNameAvailable(organizationId, parsed.name);
      }

      const updated = await SkillModel.updateWithFiles({
        id,
        skill: {
          name: parsed.name,
          description: parsed.description,
          content: parsed.content,
          license: parsed.license,
          compatibility: parsed.compatibility,
          metadata: parsed.metadata,
        },
        files: toSkillFiles(body.files),
      });

      if (!updated) {
        throw new ApiError(404, "Skill not found");
      }

      return reply.send({ ...updated, files: await loadFiles(id) });
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

      const created = [];
      const skipped: string[] = [];
      for (const item of imported) {
        const duplicate = await SkillModel.findByName(
          organizationId,
          item.parsed.name,
        );
        if (duplicate) {
          skipped.push(item.parsed.name);
          continue;
        }
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

async function assertNameAvailable(organizationId: string, name: string) {
  const existing = await SkillModel.findByName(organizationId, name);
  if (existing) {
    throw new ApiError(409, `A skill named "${name}" already exists`);
  }
}

function toSkillFiles(files: { path: string; content: string }[]) {
  return files.map((file) => ({
    path: file.path,
    content: file.content,
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
