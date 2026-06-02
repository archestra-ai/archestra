import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { SkillSourceType } from "@/types/skill";
import type { ResourceVisibilityScope } from "@/types/visibility";
import usersTable from "./user";

/**
 * Agent Skills: reusable SKILL.md instruction sets.
 *
 * A skill belongs to an organization and carries a visibility `scope`
 * (`personal`/`team`/`org`) like agents. It holds the catalog metadata
 * (`name`/`description`, surfaced to the model) plus the SKILL.md markdown
 * body (`content`, loaded on activation). Bundled resource files live in the
 * `skill_files` table; team assignments live in `skill_team`.
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
    /**
     * Visibility/management scope: `personal` (author only), `team` (members of
     * the assigned teams, see `skill_team`), or `org` (everyone). Mirrors the
     * `agents.scope` model.
     */
    scope: text("scope")
      .$type<ResourceVisibilityScope>()
      .notNull()
      .default("personal"),
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
    /**
     * Optional `allowed-tools` frontmatter field (agentskills.io): a
     * space-separated list of tools the skill is pre-approved to use. Populated
     * from the source agent's tools on conversion; round-trips through SKILL.md.
     */
    allowedTools: text("allowed_tools"),
    /**
     * When true, the SKILL.md body is rendered through Handlebars (with the
     * activating user's context) at activation, like an agent system prompt.
     * Set automatically when converting a templated agent; off for authored
     * skills unless they opt in via the `templated` frontmatter field.
     */
    templated: boolean("templated").notNull().default(false),
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
    index("skills_scope_idx").on(table.scope),
    // Name uniqueness mirrors visibility: a name only needs to be unique among
    // those who can see the skill. Personal skills are visible to their author
    // alone, so they are unique per (org, author); team/org skills are shared,
    // so they are unique per org to keep activation by name unambiguous.
    uniqueIndex("skills_org_personal_name_idx")
      .on(table.organizationId, table.authorId, table.name)
      .where(sql`${table.scope} = 'personal'`),
    uniqueIndex("skills_org_shared_name_idx")
      .on(table.organizationId, table.name)
      .where(sql`${table.scope} in ('team', 'org')`),
  ],
);

export default skillsTable;
