import { SkillModel } from "@/models";
import { accessGrants } from "@/test";

/** An org-scoped skill a share link can point at. */
export async function seedSkill(params: {
  organizationId: string;
  name: string;
}) {
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId: params.organizationId,
      authorId: null,
      name: params.name,
      description: `${params.name} description`,
      content: `# ${params.name}`,
      metadata: {},
      sourceType: "manual",
    },
    files: [],
    ...accessGrants("org"),
  });
  if (!skill) throw new Error("failed to seed skill");
  return skill;
}
