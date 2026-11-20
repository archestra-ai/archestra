import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const usersTable = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
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
  // When the identity provider deactivated or deleted the user through SCIM;
  // null while the user is active. A soft-deleted user cannot sign in or call
  // the API, and keeps their data, memberships and teams.
  softDeleted: timestamp("soft_deleted"),
  // When SCIM provisioning created the user; null for users created any other
  // way (sign-up, SSO, invitation, chat platforms).
  scimProvisioned: timestamp("scim_provisioned"),
});

export default usersTable;
