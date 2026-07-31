import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shape of the `backgroundTask` metadata the backend stamps on harness
 * notification messages (see backend chat-background-work service).
 */
export interface BackgroundTaskNotification {
  taskId: string;
  status: "completed" | "failed";
  agentName: string;
  toolName: string;
}

/**
 * Extract the background-task notification from a message's metadata, when
 * the message is one. These messages carry the task result as a user-role
 * text part for the model, but render as a harness chip instead of a user
 * bubble.
 */
export function getBackgroundTaskNotification(message: {
  role: string;
  metadata?: unknown;
}): BackgroundTaskNotification | null {
  if (message.role !== "user") return null;
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const note = (metadata as Record<string, unknown>).backgroundTask;
  if (!note || typeof note !== "object") return null;
  const { taskId, status, agentName, toolName } = note as Record<
    string,
    unknown
  >;
  if (typeof taskId !== "string" || typeof agentName !== "string") return null;
  return {
    taskId,
    status: status === "failed" ? "failed" : "completed",
    agentName,
    toolName: typeof toolName === "string" ? toolName : "",
  };
}

/**
 * Centered harness chip marking the moment a background task's result was
 * delivered back into the conversation and the agent regained control.
 */
export function BackgroundTaskNotificationChip({
  notification,
}: {
  notification: BackgroundTaskNotification;
}) {
  const failed = notification.status === "failed";
  return (
    <div className="mb-4 flex justify-center">
      <div
        className={cn(
          "inline-flex items-center gap-2 rounded-full border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground",
          failed && "border-destructive/40",
        )}
      >
        <Zap
          className={cn(
            "h-3.5 w-3.5",
            failed ? "text-destructive" : "text-amber-500",
          )}
        />
        <span>
          Background task{" "}
          <span className="font-medium text-foreground">
            {notification.agentName}
          </span>{" "}
          {failed ? "failed" : "completed"} — agent notified
        </span>
      </div>
    </div>
  );
}
