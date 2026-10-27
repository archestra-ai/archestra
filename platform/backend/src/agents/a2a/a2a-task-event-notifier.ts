import type { KeyedNotifier } from "@/services/pg-notify-hub";
import { sharedNotifyHub } from "@/services/shared-notify-hub";

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

export const a2aTaskEventNotifier: KeyedNotifier = sharedNotifyHub.channel(
  A2A_TASK_EVENT_CHANNEL,
);
