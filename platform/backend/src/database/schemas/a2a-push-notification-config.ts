import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import a2aTaskTable from "./a2a-task";

/**
 * A2A push-notification configs (`TaskPushNotificationConfig`): where to POST
 * a task's stream events for a client that cannot hold a connection open.
 *
 * Configs are per-task, and cascade with the task — a deleted task can have no
 * deliveries. The row id doubles as the protocol config id, so one task can
 * carry several webhooks (the spec allows a list).
 *
 * `authCredentials` is the caller's own secret for their endpoint, so it is
 * stored encrypted at rest with the platform's secret key, exactly like
 * provider API keys. It is never returned by the read RPCs.
 */
const a2aPushNotificationConfigsTable = pgTable(
  "a2a_push_notification_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => a2aTaskTable.id, { onDelete: "cascade" }),
    /** Absolute https URL the events are POSTed to (validated before insert). */
    url: text("url").notNull(),
    /**
     * Opaque client token echoed back in the `X-A2A-Notification-Token`
     * header so the receiver can correlate the delivery with its own request.
     */
    token: text("token"),
    /** Authorization scheme for the outbound call, e.g. "Bearer". */
    authScheme: text("auth_scheme"),
    /** Encrypted credentials; shape matches encryptSecretValue's envelope. */
    authCredentials: jsonb("auth_credentials").$type<Record<
      string,
      unknown
    > | null>(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("a2a_push_notification_config_task_id_idx").on(table.taskId),
  ],
);

export default a2aPushNotificationConfigsTable;
