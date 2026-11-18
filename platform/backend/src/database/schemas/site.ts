import { boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { SiteCapabilities, SiteRole } from "@/types/site";

/**
 * The installs ("sites") sharing this database, one row each. A site writes
 * its own row on startup and refreshes `lastSeenAt` on a heartbeat; nothing
 * else writes here except an admin toggling `draining`. See `sites/README.md`.
 */
const sitesTable = pgTable("sites", {
  /** ARCHESTRA_SITE_NAME; unique among the sites. */
  name: text("name").primaryKey(),
  role: text("role").$type<SiteRole>().notNull(),
  /** Base URL other sites call this site's internal channel on. */
  internalUrl: text("internal_url"),
  /** Platform version the site last reported. */
  version: text("version").notNull(),
  /** What the site can reach, detected from its environment on startup. */
  capabilities: jsonb("capabilities")
    .$type<SiteCapabilities>()
    .notNull()
    .default({ keylessProviders: [] }),
  /** Set by an admin to stop other sites relaying work here. */
  draining: boolean("draining").notNull().default(false),
  startedAt: timestamp("started_at", { mode: "date" }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { mode: "date" })
    .notNull()
    .defaultNow(),
});

export default sitesTable;
