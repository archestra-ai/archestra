import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AppRenderDiagnosticEntry } from "@/types/app-diagnostics";
import appsTable from "./app";
import usersTable from "./user";

/**
 * The latest render-loop diagnostics an owned app reported for one viewer — one
 * row per `(app_id, user_id)`. Posted by the trusted host page as a render
 * settles (runtime errors / CSP violations captured in the sandbox, or an empty
 * snapshot meaning "rendered clean"), and read back by the `get_app_diagnostics`
 * tool so an authoring agent can observe a render within the same turn. Best
 * effort and per-viewer — not durable app state — so it cascades away with the
 * app or the user.
 */
const appRenderDiagnosticsTable = pgTable(
  "app_render_diagnostics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => appsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** App version the snapshot was captured against; orders concurrent posts. */
    version: integer("version").notNull(),
    /** Captured entries (empty = rendered clean). Capped/sanitized by the model. */
    entries: jsonb("entries").$type<AppRenderDiagnosticEntry[]>().notNull(),
    renderedAt: timestamp("rendered_at", { mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("app_render_diagnostics_app_user_idx").on(
      table.appId,
      table.userId,
    ),
  ],
);

export default appRenderDiagnosticsTable;
