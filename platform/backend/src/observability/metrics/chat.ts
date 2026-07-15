/**
 * Prometheus metrics for the chat feature.
 *
 * Thumbs feedback rate over the last day, by value:
 * sum by (feedback) (increase(chat_message_feedback_total[1d]))
 *
 * This counts feedback *actions* by resulting value (`cleared` = a rating
 * retracted); it cannot reconstruct current or net sentiment — the source
 * of truth for that is the messages.feedback column.
 */

import client from "prom-client";
import logger from "@/logging";
import type { MessageFeedback } from "@/types";

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
  feedback: MessageFeedback | null,
): void {
  if (!chatMessageFeedbackTotal) return;
  chatMessageFeedbackTotal.inc({ feedback: feedback ?? "cleared" });
}
