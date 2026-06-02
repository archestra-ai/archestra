import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  NetworkPolicyDomainPreset,
  NetworkPolicyEgressMode,
} from "@/types";
import organizationsTable from "./organization";

const networkPoliciesTable = pgTable(
  "network_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    egressMode: text("egress_mode")
      .$type<NetworkPolicyEgressMode>()
      .notNull()
      .default("restricted"),
    domainPreset: text("domain_preset")
      .$type<NetworkPolicyDomainPreset>()
      .notNull()
      .default("none"),
    allowedDomains: jsonb("allowed_domains")
      .$type<string[]>()
      .notNull()
      .default([]),
    allowedCidrs: jsonb("allowed_cidrs")
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("network_policy_org_name_unique").on(
      table.organizationId,
      table.name,
    ),
    index("network_policy_org_idx").on(table.organizationId),
  ],
);

export default networkPoliciesTable;
