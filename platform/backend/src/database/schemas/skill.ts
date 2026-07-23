import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { SkillGithubSyncInterval, SkillSourceType } from "@/types/skill";
import type { ResourceVisibilityScope } from "@/types/visibility";
import githubAppConfigsTable from "./github-app-config";
import githubPatsTable from "./github-pat";
import usersTable from "./user";

/**
 * Agent Skills: reusable SKILL.md instruction sets.
 *
 * A skill belongs to an organization and carries a visibility `scope`
 * (`personal`/`team`/`org`) like agents. It holds the catalog metadata
 * (`name`/`description`, surfaced to the model) plus the SKILL.md markdown
 * body (`content`, loaded on activation). Bundled resource files live in the
 * `skill_files` table; team assignments live in `skill_team`; environment
 * assignments live in `skill_environment` (no rows = available in every
 * environment).
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
    /**
     * Head version number, pointing at the latest `skill_versions` row. Bumped
     * in the same transaction as an edit that forks a new version. Every skill
     * has at least version 1 (written on create / backfilled on migration).
     */
    latestVersion: integer("latest_version").notNull(),
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
     * Optional `agent` frontmatter field: the name of the agent the skill runs
     * in. When set, activation delegates the skill (instructions + task) to
     * that agent instead of loading the instructions into the caller's context.
     */
    agentName: text("agent_name"),
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
    /**
     * Recurring-pull frequency for a GitHub-synced skill. Non-null marks the
     * skill as synced: its content (SKILL.md + files) is read-only in
     * Archestra and a background worker re-pulls it from the source repo on
     * this schedule. Null = editable in Archestra (a one-time snapshot for
     * `github` skills). Cleared on "disconnect".
     */
    githubSyncInterval: text(
      "github_sync_interval",
    ).$type<SkillGithubSyncInterval>(),
    /**
     * Git ref (branch or tag) a synced skill tracks; null tracks the repo's
     * default branch (HEAD). Only meaningful while `githubSyncInterval` is
     * set — `sourceRef` pins the requested-ref-or-SHA at import and is
     * provenance, not the tracking target.
     */
    githubSyncRef: text("github_sync_ref"),
    /**
     * GitHub App config used to authenticate scheduled pulls; null for public
     * repos. PATs are never stored, so a PAT import cannot be synced. Deleting
     * the config nulls this and subsequent private-repo syncs fail (recorded
     * in `lastSyncError`).
     */
    githubAppConfigId: uuid("github_app_config_id").references(
      () => githubAppConfigsTable.id,
      { onDelete: "set null" },
    ),
    /**
     * Stored PAT used to authenticate scheduled pulls; the stored-token twin
     * of `githubAppConfigId` (at most one of the two is set). Deleting the
     * PAT is blocked while synced skills reference it.
     */
    githubPatId: uuid("github_pat_id").references(() => githubPatsTable.id, {
      onDelete: "set null",
    }),
    /** When the last scheduled/manual sync ran (success or failure). */
    lastSyncedAt: timestamp("last_synced_at", { mode: "date" }),
    /** Why the last sync failed; null when it succeeded. */
    lastSyncError: text("last_sync_error"),
    /**
     * Total activations: `load_skill` by name (catalog clients), slash-command
     * activation in chat, and skill-delegation dispatch each count one. File
     * reads and catalog listing don't. Incremented by `SkillModel.recordUsage`
     * without touching `updatedAt`.
     */
    usageCount: integer("usage_count").notNull().default(0),
    /** When the skill was last activated (see `usageCount`). */
    lastUsedAt: timestamp("last_used_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("skills_organization_id_idx").on(table.organizationId),
    index("skills_scope_idx").on(table.scope),
    // the sync worker's check-due scan touches only synced skills.
    index("skills_github_sync_due_idx")
      .on(table.lastSyncedAt)
      .where(sql`${table.githubSyncInterval} is not null`),
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
