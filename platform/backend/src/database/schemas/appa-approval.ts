import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AppaApprovalStatus } from "@/types/appa-approval";
import appaProxySessionsTable from "./appa-proxy-session";

const appaProxyApprovalsTable = pgTable(
  "appa_proxy_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => appaProxySessionsTable.id, { onDelete: "cascade" }),
    activeTurnId: text("active_turn_id").notNull(),
    candidateCallId: text("candidate_call_id").notNull(),
    rootId: text("root_id").notNull(),
    tool: text("tool").notNull(),
    argumentsSha256: text("arguments_sha256").notNull(),
    offerId: text("offer_id").notNull(),
    status: text("status")
      .$type<AppaApprovalStatus>()
      .notNull()
      .default("pending"),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    approverId: text("approver_id"),
    decidedAt: timestamp("decided_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("appa_proxy_approvals_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("appa_proxy_approvals_session_turn_idx").on(
      table.sessionId,
      table.activeTurnId,
    ),
  ],
);

export default appaProxyApprovalsTable;
