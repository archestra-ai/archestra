import config from "@/config";
import {
  createPollingNotifyHub,
  createPostgresNotifyHub,
  type PgNotifyHub,
} from "@/services/pg-notify-hub";

/**
 * One listener connection per pod, shared with every other feature that takes
 * a channel from this hub. It connects on first use.
 *
 * Polling compatibility reuses the chat setting deliberately: it describes the
 * database endpoint (a transaction-pooling PgBouncer cannot hold a
 * session-stable LISTEN for anyone), not the feature, so a deployment that
 * needs it needs it for every feature on this hub.
 */
export const sharedNotifyHub: PgNotifyHub = config.chat.activeRun
  .pollingCompatibilityEnabled
  ? createPollingNotifyHub()
  : createPostgresNotifyHub(
      config.chat.activeRun.notifyDatabaseUrl || config.database.url,
    );
