import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const agentsTable = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  isDemo: boolean("is_demo").notNull().default(false),
  isDefault: boolean("is_default").notNull().default(false),
  considerContextUntrusted: boolean("consider_context_untrusted")
    .notNull()
    .default(false),
  // Incoming email settings
  incomingEmailEnabled: boolean("incoming_email_enabled")
    .notNull()
    .default(false),
  // Security mode: 'private' (user auth), 'internal' (domain), 'public' (no restriction)
  incomingEmailSecurityMode: text("incoming_email_security_mode")
    .notNull()
    .default("private"),
  // Allowed email domain for 'internal' mode (e.g., 'company.com')
  incomingEmailAllowedDomain: text("incoming_email_allowed_domain"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default agentsTable;
