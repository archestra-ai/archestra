import { boolean, text, timestamp } from "drizzle-orm/pg-core";
import { softDeletablePgTable } from "./soft-deletable-table";

const usersTable = softDeletablePgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // Bucket A: email stays globally unique even across soft-deleted rows.
  // UserModel.delete tombstones the value so the address is freed.
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  // Although the RBAC uses members with roles, we are keeping the role on the user
  // because it's required by better-auth admin plugin.
  // If removing this field and admin plugin, make sure the seed isn't crashing.
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
});

export default usersTable;
