import {
  ChatBackgroundTaskMetadataSchema,
  ChatScheduledWakeupMetadataSchema,
} from "@archestra/shared";
import { AlarmClock, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A harness wake notification: a `user`-role message the harness (not the
 * user) injected to hand control back to the model — a settled background
 * task's result, or a scheduled wakeup firing. The message text is for the
 * model; the human sees a centered chip instead of a user bubble.
 */
export type WakeNotification =
  | {
      kind: "backgroundTask";
      status: "completed" | "failed";
      label: string;
    }
  | {
      kind: "scheduledWakeup";
      recurring: boolean;
      quiet: boolean;
      label: string;
    };

/**
 * Extract the wake notification from a message's metadata, when the message
 * is one. The shapes are the shared metadata schemas the backend stamps.
 */
export function getWakeNotification(message: {
  role: string;
  metadata?: unknown;
}): WakeNotification | null {
  if (message.role !== "user") return null;
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return null;

  const backgroundTask = ChatBackgroundTaskMetadataSchema.safeParse(
    (metadata as Record<string, unknown>).backgroundTask,
  );
  if (backgroundTask.success) {
    return {
      kind: "backgroundTask",
      status: backgroundTask.data.status,
      label: backgroundTask.data.agentName,
    };
  }

  const scheduledWakeup = ChatScheduledWakeupMetadataSchema.safeParse(
    (metadata as Record<string, unknown>).scheduledWakeup,
  );
  if (scheduledWakeup.success) {
    return {
      kind: "scheduledWakeup",
      recurring: scheduledWakeup.data.recurring,
      quiet: scheduledWakeup.data.quiet === true,
      label: scheduledWakeup.data.name,
    };
  }

  return null;
}

/** Whether a message is a quiet wake's no-change assistant reply. */
export function isQuietWakeReply(message: {
  role: string;
  metadata?: unknown;
}): boolean {
  return (
    message.role === "assistant" &&
    typeof message.metadata === "object" &&
    message.metadata !== null &&
    (message.metadata as Record<string, unknown>).quietWake === true
  );
}

/**
 * One muted line for a quiet monitor check that found nothing — the wake
 * notification and its sentinel reply collapse into this.
 */
export function QuietWakeLine({ label }: { label: string }) {
  return (
    <div className="mb-4 flex justify-center">
      <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/70">
        <AlarmClock className="h-3 w-3" />
        <span>
          Checked <span className="font-medium">{label}</span> — no change
        </span>
      </div>
    </div>
  );
}

/**
 * Centered harness chip marking the moment a wake was delivered back into
 * the conversation and the agent regained control.
 */
export function WakeNotificationChip({
  notification,
}: {
  notification: WakeNotification;
}) {
  const failed =
    notification.kind === "backgroundTask" && notification.status === "failed";
  const Icon = notification.kind === "backgroundTask" ? Zap : AlarmClock;
  return (
    <div className="mb-4 flex justify-center">
      <div
        className={cn(
          "inline-flex items-center gap-2 rounded-full border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground",
          failed && "border-destructive/40",
        )}
      >
        <Icon
          className={cn(
            "h-3.5 w-3.5",
            failed
              ? "text-destructive"
              : notification.kind === "backgroundTask"
                ? "text-amber-500"
                : "text-sky-500",
          )}
        />
        {notification.kind === "backgroundTask" ? (
          <span>
            Background task{" "}
            <span className="font-medium text-foreground">
              {notification.label}
            </span>{" "}
            <span>{failed ? "failed" : "completed"}</span> — agent notified
          </span>
        ) : (
          <span>
            <span>{notification.recurring ? "Recurring" : "Scheduled"}</span>{" "}
            wakeup{" "}
            <span className="font-medium text-foreground">
              {notification.label}
            </span>{" "}
            fired — agent woken
          </span>
        )}
      </div>
    </div>
  );
}
