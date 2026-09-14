import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AppaWireAliasKind,
  AppaWireFrameKind,
  AppaWireFrameState,
} from "@/types/appa-proxy-wire";
import appaProxySessionsTable from "./appa-proxy-session";

export const appaProxyWireFramesTable = pgTable(
  "appa_proxy_wire_frames",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => appaProxySessionsTable.id, { onDelete: "cascade" }),
    parentFrameId: uuid("parent_frame_id").references(
      (): AnyPgColumn => appaProxyWireFramesTable.id,
    ),
    turnId: text("turn_id").notNull(),
    kind: text("kind").$type<AppaWireFrameKind>().notNull(),
    state: text("state").$type<AppaWireFrameState>().notNull().default("held"),
    protocol: text("protocol").notNull(),
    requestHash: text("request_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    sourceResponseId: text("source_response_id"),
    controlCallId: text("control_call_id"),
    runtimeBatchId: text("runtime_batch_id"),
    payloadCiphertext: text("payload_ciphertext").notNull(),
    payloadHash: text("payload_hash").notNull(),
    payloadBytes: integer("payload_bytes").notNull(),
    receiptCiphertext: text("receipt_ciphertext"),
    receiptHash: text("receipt_hash"),
    receiptBytes: integer("receipt_bytes").notNull().default(0),
    executionEventId: uuid("execution_event_id"),
    executionRequestHash: text("execution_request_hash"),
    issuedAt: timestamp("issued_at", { mode: "date" }),
    completedAt: timestamp("completed_at", { mode: "date" }),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("appa_proxy_wire_frames_session_idx").on(table.sessionId),
    uniqueIndex("appa_proxy_wire_frames_request_uidx").on(
      table.sessionId,
      table.idempotencyKey,
    ),
    uniqueIndex("appa_proxy_wire_frames_control_uidx").on(table.controlCallId),
    check(
      "appa_proxy_wire_frames_state_check",
      sql`${table.state} in ('held','ready','issued','running','completed','cancelled','quarantined')`,
    ),
    check(
      "appa_proxy_wire_frames_kind_check",
      sql`${table.kind} in ('model_response','inbound_hold','remedy_control')`,
    ),
    check(
      "appa_proxy_wire_frames_bytes_check",
      sql`${table.payloadBytes} >= 0 and ${table.payloadBytes} <= 16777216`,
    ),
  ],
);

export const appaProxyWireAliasesTable = pgTable(
  "appa_proxy_wire_aliases",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => appaProxySessionsTable.id, { onDelete: "cascade" }),
    frameId: uuid("frame_id")
      .notNull()
      .references(() => appaProxyWireFramesTable.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AppaWireAliasKind>().notNull(),
    position: integer("position").notNull(),
    wireId: text("wire_id").notNull(),
    logicalId: text("logical_id"),
    sourceCallId: text("source_call_id"),
    metadataCiphertext: text("metadata_ciphertext").notNull(),
    metadataBytes: integer("metadata_bytes").notNull(),
    childThreadId: text("child_thread_id"),
    consumedAt: timestamp("consumed_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("appa_proxy_wire_aliases_wire_uidx").on(
      table.sessionId,
      table.kind,
      table.wireId,
    ),
    uniqueIndex("appa_proxy_wire_aliases_position_uidx").on(
      table.frameId,
      table.kind,
      table.position,
    ),
    index("appa_proxy_wire_aliases_logical_idx").on(
      table.sessionId,
      table.kind,
      table.logicalId,
    ),
    check(
      "appa_proxy_wire_aliases_kind_check",
      sql`${table.kind} in ('call','task','process')`,
    ),
    check(
      "appa_proxy_wire_aliases_position_check",
      sql`${table.position} >= 0`,
    ),
  ],
);
