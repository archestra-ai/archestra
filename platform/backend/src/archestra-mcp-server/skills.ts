import {
  TOOL_ACTIVATE_SKILL_SHORT_NAME,
  TOOL_READ_SKILL_FILE_SHORT_NAME,
} from "@shared";
import { z } from "zod";
import logger from "@/logging";
import { SkillFileModel, SkillModel } from "@/models";
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
 * `activate_skill` and `read_skill_file` implement the progressive-disclosure
 * tiers of the Agent Skills spec: the catalog is listed on a no-argument
 * `activate_skill` call, the SKILL.md body is returned when a skill is named,
 * and bundled resource files are fetched individually via `read_skill_file`.
 * Scripts are returned as readable text — they are not executed.
 *
 * @see https://agentskills.io/specification
 */

const ActivateSkillSchema = z.object({
  name: z
    .string()
    .optional()
    .describe(
      "The skill to load. Omit to list the skills available in this organization.",
    ),
});

const ReadSkillFileSchema = z.object({
  skill: z.string().describe("The skill that owns the file"),
  path: z
    .string()
    .describe("Resource path from the skill, e.g. references/REFERENCE.md"),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_ACTIVATE_SKILL_SHORT_NAME,
    title: "Activate Skill",
    description:
      "Load a specialized Agent Skill — a reusable SKILL.md instruction set. " +
      "Call with no arguments to list the skills available in this " +
      "organization, then call again with a skill name to load its full " +
      "instructions. Activate a skill before attempting the task it covers.",
    schema: ActivateSkillSchema,
    async handler({ args, context }) {
      const organizationId = requireOrganization(context);
      if (!organizationId) {
        return errorResult(
          "This tool requires organization context. It can only be used within an authenticated session.",
        );
      }

      if (!args.name) {
        return listSkillCatalog(organizationId);
      }

      const skill = await SkillModel.findByName(organizationId, args.name);
      if (!skill) {
        return errorResult(
          `No skill named "${args.name}" exists. Call activate_skill with no arguments to list available skills.`,
        );
      }

      const files = await SkillFileModel.findBySkillId(skill.id);
      logger.info(
        { organizationId, skillName: skill.name, fileCount: files.length },
        "[Skills] Skill activated",
      );

      const resources =
        files.length > 0
          ? `\n<skill_resources>\n${files
              .map((file) => `${file.path} (${file.kind})`)
              .join(
                "\n",
              )}\n</skill_resources>\nUse read_skill_file to load any resource you need.`
          : "";

      const compatibility = skill.compatibility
        ? `\n<skill_compatibility>${skill.compatibility}</skill_compatibility>\n` +
          "If this environment cannot meet that requirement, tell the user " +
          "and proceed with what is possible."
        : "";

      return successResult(
        `<skill_content name="${skill.name}">\n${skill.content}\n</skill_content>` +
          compatibility +
          resources,
      );
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
      const organizationId = requireOrganization(context);
      if (!organizationId) {
        return errorResult(
          "This tool requires organization context. It can only be used within an authenticated session.",
        );
      }

      const skill = await SkillModel.findByName(organizationId, args.skill);
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
        return successResult(
          `<skill_file skill="${skill.name}" path="${file.path}" encoding="base64">\n` +
            `Binary asset, ${file.content.length} base64 chars. ` +
            "Not loaded inline — fetch the raw bytes through the platform " +
            "if you need to use this file.\n</skill_file>",
        );
      }

      return successResult(
        `<skill_file skill="${skill.name}" path="${file.path}">\n${file.content}\n</skill_file>`,
      );
    },
  }),
] as const);

// ===== Internal helpers =====

function requireOrganization(context: ArchestraContext): string | null {
  return context.organizationId ?? null;
}

async function listSkillCatalog(organizationId: string) {
  const skills = await SkillModel.findByOrganization({ organizationId });
  if (skills.length === 0) {
    return successResult(
      "No skills are available in this organization. Skills can be added under Agents → Skills.",
    );
  }

  const catalog = skills
    .map((skill) => `<skill name="${skill.name}">${skill.description}</skill>`)
    .join("\n");

  return successResult(
    `<available_skills>\n${catalog}\n</available_skills>\n` +
      "Call activate_skill again with one of these names to load its instructions.",
  );
}

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;
