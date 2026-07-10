/**
 * Prometheus metrics for the chat feature.
 *
 * Thumbs feedback rate over the last day, by value:
 * sum by (feedback) (increase(chat_message_feedback_total[1d]))
 *
 * `cleared` counts retractions — counters cannot decrement, so dashboards
 * that want net sentiment subtract it explicitly.
 */

import client from "prom-client";
import logger from "@/logging";

let chatMessageFeedbackTotal: client.Counter<string>;

let initialized = false;

export function initializeChatMetrics(): void {
  if (initialized) return;
  initialized = true;

  chatMessageFeedbackTotal = new client.Counter({
    name: "chat_message_feedback_total",
    help: "Total thumbs feedback actions on chat assistant messages, by resulting value (up, down, cleared)",
    labelNames: ["feedback"],
  });

  logger.info("Chat metrics initialized");
}

export function reportChatMessageFeedback(
  feedback: "up" | "down" | null,
): void {
  if (!chatMessageFeedbackTotal) return;
  chatMessageFeedbackTotal.inc({ feedback: feedback ?? "cleared" });
}
