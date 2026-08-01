import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import usersTable from "./user";

const twoFactor = pgTable("two_factor", {
  id: text("id").primaryKey(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  /**
   * Whether the enrollment's first TOTP code was verified. Required by
   * better-auth's twoFactor plugin schema; enrollments predating the column
   * are backfilled as verified iff the user completed enrollment
   * (user.two_factor_enabled).
   */
  verified: boolean("verified").notNull().default(false),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export default twoFactor;
