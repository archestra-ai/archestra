import config from "@/config";
import {
  createPollingNotifyHub,
  createPostgresNotifyHub,
  type KeyedNotifier,
  type PgNotifyHub,
} from "@/services/pg-notify-hub";

/**
 * Channel A2A task-event wake-ups travel on, keyed by task id.
 *
 * A `SubscribeToTask` stream reads the task's durable event log; the run
 * writing those events may be on a different replica. `NOTIFY` reaches every
 * pod listening on this channel, so a subscriber wakes when the writer
 * commits instead of on its next poll. Delivery is best-effort — the poll in
 * the follow loop is what makes the stream correct.
 */
const A2A_TASK_EVENT_CHANNEL = "a2a_task_events";

/**
 * One listener connection per pod, shared with every other feature that takes
 * a channel from this hub.
 *
 * Polling compatibility reuses the chat setting deliberately: it describes the
 * database endpoint (a transaction-pooling PgBouncer cannot hold a
 * session-stable LISTEN for anyone), not the feature, so a deployment that
 * needs it needs it for both.
 */
const hub: PgNotifyHub = config.chat.activeRun.pollingCompatibilityEnabled
  ? createPollingNotifyHub()
  : createPostgresNotifyHub(
      config.chat.activeRun.notifyDatabaseUrl || config.database.url,
    );

export const a2aTaskEventNotifier: KeyedNotifier = hub.channel(
  A2A_TASK_EVENT_CHANNEL,
);
