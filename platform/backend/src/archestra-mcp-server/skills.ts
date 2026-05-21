import {
  TOOL_ACTIVATE_SKILL_SHORT_NAME,
  TOOL_LIST_SKILLS_SHORT_NAME,
  TOOL_READ_SKILL_FILE_SHORT_NAME,
} from "@shared";
import { z } from "zod";
import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import logger from "@/logging";
import { SkillFileModel, SkillModel, SkillTeamModel } from "@/models";
import {
  escapeXmlAttr,
  escapeXmlText,
  formatSkillActivation,
} from "@/skills/skill-activation";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  successResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

/**
 * Agent Skills chat tools.
 *
 * `list_skills`, `activate_skill`, and `read_skill_file` implement the
 * progressive-disclosure tiers of the Agent Skills spec: `list_skills` returns
 * the catalog, `activate_skill` returns a named skill's SKILL.md body, and
 * bundled resource files are fetched individually via `read_skill_file`.
 * Scripts are returned as readable text — they are not executed.
 *
 * @see https://agentskills.io/specification
 */

const ListSkillsSchema = z.object({});

const ActivateSkillSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .describe("The skill to load, as named by list_skills."),
});

const ReadSkillFileSchema = z.object({
  skill: z.string().describe("The skill that owns the file"),
  path: z
    .string()
    .describe("Resource path from the skill, e.g. references/REFERENCE.md"),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_LIST_SKILLS_SHORT_NAME,
    title: "List Skills",
    description:
      "List the Agent Skills available in this organization — one line per " +
      "skill (name and description). Call activate_skill with a skill name " +
      "to load its full instructions.",
    schema: ListSkillsSchema,
    async handler({ context }) {
      const ctx = requireUserContext(context);
      if (!ctx) {
        return errorResult("This tool requires an authenticated user session.");
      }

      return listSkillCatalog(ctx);
    },
  }),
  defineArchestraTool({
    shortName: TOOL_ACTIVATE_SKILL_SHORT_NAME,
    title: "Activate Skill",
    description:
      "Load a specialized Agent Skill — a reusable SKILL.md instruction set. " +
      "Call list_skills first to discover what is available, then call this " +
      "with a skill name to load its full instructions. Activate a skill " +
      "before attempting the task it covers.",
    schema: ActivateSkillSchema,
    async handler({ args, context }) {
      const ctx = requireUserContext(context);
      if (!ctx) {
        return errorResult("This tool requires an authenticated user session.");
      }

      const skill = await findAccessibleSkill(ctx, args.name);
      if (!skill) {
        return errorResult(
          `No skill named "${args.name}" exists. Call list_skills to see available skills.`,
        );
      }

      const files = await SkillFileModel.findBySkillId(skill.id);
      logger.info(
        {
          organizationId: ctx.organizationId,
          skillName: skill.name,
          fileCount: files.length,
        },
        "[Skills] Skill activated",
      );

      return successResult(formatSkillActivation({ skill, files }));
    },
  }),
  defineArchestraTool({
    shortName: TOOL_READ_SKILL_FILE_SHORT_NAME,
    title: "Read Skill File",
    description:
      "Read a bundled resource file from a skill. Paths come from the " +
      "<skill_resources> list returned by activate_skill. Scripts are " +
      "returned as readable text — they are not executed.",
    schema: ReadSkillFileSchema,
    async handler({ args, context }) {
      const ctx = requireUserContext(context);
      if (!ctx) {
        return errorResult("This tool requires an authenticated user session.");
      }

      const skill = await findAccessibleSkill(ctx, args.skill);
      if (!skill) {
        return errorResult(`No skill named "${args.skill}" exists.`);
      }

      const file = await SkillFileModel.findBySkillAndPath(skill.id, args.path);
      if (!file) {
        return errorResult(
          `Skill "${args.skill}" has no file at "${args.path}".`,
        );
      }

      if (file.encoding === "base64") {
        const approxKb = Math.round((file.content.length * 3) / 4 / 1024);
        return successResult(
          `<skill_file skill="${escapeXmlAttr(skill.name)}" path="${escapeXmlAttr(file.path)}" encoding="base64">\n` +
            `This is a binary asset (~${approxKb} KB) and cannot be read as ` +
            "text. It is bundled with the skill for redistribution, not for " +
            "inline use by the model.\n</skill_file>",
        );
      }

      return successResult(
        `<skill_file skill="${escapeXmlAttr(skill.name)}" path="${escapeXmlAttr(file.path)}">\n${file.content}\n</skill_file>`,
      );
    },
  }),
] as const);

// ===== Internal helpers =====

interface UserContext {
  organizationId: string;
  userId: string;
}

/** A skill MCP tool needs both an org and a user to enforce scope. */
function requireUserContext(context: ArchestraContext): UserContext | null {
  if (!context.organizationId || !context.userId) return null;
  return { organizationId: context.organizationId, userId: context.userId };
}

/**
 * Look up a skill by name and return it only if the user can access it under
 * the skill's scope. Returns null otherwise — callers surface a generic
 * "no skill named …" so an inaccessible skill's existence is not leaked.
 */
async function findAccessibleSkill(ctx: UserContext, name: string) {
  const skill = await SkillModel.findByName(ctx.organizationId, name);
  if (!skill) return null;

  const checker = await getSkillPermissionChecker(ctx);
  const hasAccess = await SkillTeamModel.userHasSkillAccess({
    userId: ctx.userId,
    skill,
    isSkillAdmin: checker.isAdmin,
  });
  return hasAccess ? skill : null;
}

async function listSkillCatalog(ctx: UserContext) {
  const checker = await getSkillPermissionChecker(ctx);
  const accessibleSkillIds = checker.isAdmin
    ? undefined
    : await SkillTeamModel.getUserAccessibleSkillIds(ctx.userId);

  const skills = await SkillModel.findByOrganization({
    organizationId: ctx.organizationId,
    accessibleSkillIds,
  });
  if (skills.length === 0) {
    return successResult(
      "No skills are available in this organization. Skills can be added under Agents → Skills.",
    );
  }

  const catalog = skills
    .map(
      (skill) =>
        `<skill name="${escapeXmlAttr(skill.name)}">${escapeXmlText(
          skill.description,
        )}</skill>`,
    )
    .join("\n");

  return successResult(
    `<available_skills>\n${catalog}\n</available_skills>\n` +
      "Call activate_skill with one of these names to load its instructions.",
  );
}

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;
