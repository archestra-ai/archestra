import { z } from "zod";

export const McpSkillResourceSchema = z.object({
  uri: z.string(),
  digest: z.string(),
});
export type McpSkillResource = z.infer<typeof McpSkillResourceSchema>;

export interface McpSkillMetadataInput {
  uri: string;
  name: string;
  description: string;
  frontmatter: Record<string, unknown>;
  resources: McpSkillResource[] | null;
}
