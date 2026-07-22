import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SkillShareLinkStatusSchema = z.enum([
  "active",
  "expired",
  "revoked",
]);
export type SkillShareLinkStatus = z.infer<typeof SkillShareLinkStatusSchema>;

export const SelectSkillShareLinkSchema = createSelectSchema(
  schema.skillShareLinksTable,
);

/**
 * Insert payload. The controller is responsible for generating the raw token
 * and derived columns (`tokenHash`, `tokenStart`); callers never set them.
 */
export const InsertSkillShareLinkSchema = createInsertSchema(
  schema.skillShareLinksTable,
).omit({
  id: true,
  tokenHash: true,
  tokenStart: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
});

export type SkillShareLink = z.infer<typeof SelectSkillShareLinkSchema>;
export type InsertSkillShareLink = z.infer<typeof InsertSkillShareLinkSchema>;

/** Skill metadata attached when listing share links (avoids N+1). */
export interface SkillShareLinkSkillSummary {
  id: string;
  name: string;
  description: string;
}

export interface SkillShareLinkWithSkills extends SkillShareLink {
  skills: SkillShareLinkSkillSummary[];
}

/**
 * Pure status derivation: revocation beats expiry, expiry beats active.
 * Shared by backend response shaping and tests.
 */
export function deriveSkillShareLinkStatus(
  link: Pick<SkillShareLink, "revokedAt" | "expiresAt">,
  now: Date = new Date(),
): SkillShareLinkStatus {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return "active";
}
