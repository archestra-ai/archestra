import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  TunerCandidateSource,
  TunerEvidenceRef,
  TunerFingerprint,
  TunerKind,
  TunerSeverity,
  TunerSuggestedAction,
  TunerSuggestionStatus,
} from "@/types/tuner";
import organizationsTable from "./organization";
import scheduleTriggerRunsTable from "./schedule-trigger-run";
import usersTable from "./user";

/**
 * One tuner suggestion. At most one `open` row per (organization,
 * fingerprint); closed rows stay as the tuner's memory and suppress the same
 * fingerprint for a while (services/tuners).
 */
const tunerSuggestionsTable = pgTable(
  "tuner_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    tunerKind: text("tuner_kind").$type<TunerKind>().notNull(),
    fingerprint: text("fingerprint").$type<TunerFingerprint>().notNull(),
    source: text("source").$type<TunerCandidateSource>().notNull(),
    severity: text("severity").$type<TunerSeverity>().notNull(),
    title: text("title").notNull(),
    rationale: text("rationale").notNull(),
    evidence: jsonb("evidence").$type<TunerEvidenceRef[]>().notNull(),
    action: jsonb("action").$type<TunerSuggestedAction>().notNull(),
    status: text("status").$type<TunerSuggestionStatus>().notNull(),
    statusChangedAt: timestamp("status_changed_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    statusChangedBy: text("status_changed_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    comment: text("comment"),
    scheduleTriggerRunId: uuid("schedule_trigger_run_id").references(
      () => scheduleTriggerRunsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("tuner_suggestions_open_fingerprint_uidx")
      .on(table.organizationId, table.fingerprint)
      .where(sql`${table.status} = 'open'`),
    index("tuner_suggestions_org_fingerprint_idx").on(
      table.organizationId,
      table.fingerprint,
      table.statusChangedAt,
    ),
    index("tuner_suggestions_org_status_idx").on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    index("tuner_suggestions_run_idx").on(table.scheduleTriggerRunId),
  ],
);

export default tunerSuggestionsTable;
