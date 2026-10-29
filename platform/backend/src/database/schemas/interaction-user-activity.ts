import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  integer,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import usersTable from "./user";

export const interactionUserActivityStateTable = pgTable(
  "interaction_user_activity_state",
  {
    id: integer("id").primaryKey(),
    generation: bigint("generation", { mode: "number" }).notNull().default(1),
    ready: boolean("ready").notNull().default(false),
    enabled: boolean("enabled").notNull().default(false),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
  },
  (table) => [
    check("interaction_user_activity_singleton", sql`${table.id} = 1`),
  ],
);

export const interactionUserActivityMissingOwnersTable = pgTable(
  "interaction_user_activity_missing_owners",
  {
    kind: text("kind").notNull(),
    ownerId: text("owner_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.kind, table.ownerId] })],
);

export const interactionUserActivityUsersTable = pgTable(
  "interaction_user_activity_users",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    generation: bigint("generation", { mode: "number" }).notNull().default(0),
  },
);

export const interactionUserActivityDeltasTable = pgTable(
  "interaction_user_activity_deltas",
  {
    organizationId: text("organization_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    generation: bigint("generation", { mode: "number" }).notNull(),
    balance: bigint("balance", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })],
);

export const interactionUserActivityTable = pgTable(
  "interaction_user_activity",
  {
    organizationId: text("organization_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    activityCount: bigint("activity_count", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    check(
      "interaction_user_activity_positive",
      sql`${table.activityCount} > 0`,
    ),
  ],
);
