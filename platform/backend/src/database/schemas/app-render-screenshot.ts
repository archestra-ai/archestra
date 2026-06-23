import {
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import appsTable from "./app";
import usersTable from "./user";

/**
 * The latest render screenshot an owned app self-captured for one viewer — one
 * row per `(app_id, user_id)`. The host page can't capture the app (the iframe
 * is cross-origin), so the app rasterizes its own DOM and posts it; this is read
 * back by `get_app_diagnostics` so an authoring agent can see how the app looks.
 * Best effort and per-viewer — not durable app state — so it cascades away with
 * the app or the user. The image is stored as base64 (no data: prefix) plus its
 * mime type, size-capped at the ingest endpoint.
 */
const appRenderScreenshotTable = pgTable(
  "app_render_screenshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => appsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** App version the capture was taken against; orders concurrent posts. */
    version: integer("version").notNull(),
    mimeType: text("mime_type").notNull(),
    /** Base64-encoded image bytes (no `data:` prefix). */
    data: text("data").notNull(),
    renderedAt: timestamp("rendered_at", { mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("app_render_screenshots_app_user_idx").on(
      table.appId,
      table.userId,
    ),
  ],
);

export default appRenderScreenshotTable;
