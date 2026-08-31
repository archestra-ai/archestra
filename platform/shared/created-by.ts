import { z } from "zod";

/**
 * Who created a "major" object — agents, MCP gateways, skills, apps, projects,
 * provider and virtual keys, OAuth clients, service accounts, knowledge bases,
 * connectors and files.
 *
 * One shape for every one of them so the tables that show it can share a single
 * cell renderer instead of each inventing its own "author" field. The point is
 * operational: given an object nobody recognises, who do you go and ask about
 * it.
 *
 * All three fields are carried because each answers a different question and
 * none substitutes for the others:
 * - `id` decides "is this me", which no display string can do reliably (names
 *   and even emails collide across identity providers).
 * - `name` is what a person is called, and what the cell shows.
 * - `email` is how you actually reach them — the use case this exists for — and
 *   is the fallback label for accounts that never set a name.
 *
 * Null (rather than a placeholder row) means the creator is genuinely unknown:
 * the object predates creator tracking, or was made by automation, or its
 * author's account has since been deleted. Callers render those the same way,
 * because the answer to "who do I contact" is the same in all three: nobody.
 */
export const CreatedBySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
});

export type CreatedBy = z.infer<typeof CreatedBySchema>;

/**
 * What a response schema declares: `createdBy: CreatedByNullableSchema`. Named
 * so every entity spells the field the same way and no two disagree on whether
 * the creator can be absent — it always can.
 */
export const CreatedByNullableSchema = CreatedBySchema.nullable();
