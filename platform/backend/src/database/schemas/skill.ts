import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { SkillSourceType } from "@/types/skill";
import usersTable from "./user";

/**
 * Agent Skills: reusable SKILL.md instruction sets.
 *
 * A skill is an organization-level resource. It holds the catalog metadata
 * (`name`/`description`, surfaced to the model) plus the SKILL.md markdown
 * body (`content`, loaded on activation). Bundled resource files live in the
 * `skill_files` table; agent attachments live in `agent_skill`.
 *
 * @see https://agentskills.io/specification
 */
const skillsTable = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    /** User who created/imported the skill; nulled if the user is removed. */
    authorId: text("author_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    /** Short identifier surfaced in the skill catalog. */
    name: text("name").notNull(),
    /** One-line summary the model uses to decide when to activate. */
    description: text("description").notNull(),
    /** Full markdown instructions (the SKILL.md body). */
    content: text("content").notNull(),
    /** Optional `license` frontmatter field. */
    license: text("license"),
    /** Optional `compatibility` frontmatter field (environment requirements). */
    compatibility: text("compatibility"),
    /** Optional arbitrary `metadata` frontmatter map. */
    metadata: jsonb("metadata")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    /** How the skill entered the system. */
    sourceType: text("source_type")
      .$type<SkillSourceType>()
      .notNull()
      .default("manual"),
    /** Provenance for imported skills, e.g. `owner/repo@ref:path`. */
    sourceRef: text("source_ref"),
    /** Commit SHA the skill was imported at, when known. */
    sourceCommit: text("source_commit"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("skills_organization_id_idx").on(table.organizationId),
    uniqueIndex("skills_org_name_idx").on(table.organizationId, table.name),
  ],
);

export default skillsTable;
