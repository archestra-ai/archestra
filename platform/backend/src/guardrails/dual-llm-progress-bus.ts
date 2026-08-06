import { EventEmitter } from "node:events";
import type { DualLlmAnalysis } from "@/types";

export type DualLlmProgressEvent =
  | { kind: "start"; toolCallId: string; toolName: string }
  | {
      kind: "qa";
      toolCallId: string;
      toolName: string;
      question: string;
      options: string[];
      answer: string;
    }
  | {
      kind: "complete";
      toolCallId: string;
      toolName: string;
      analysis: DualLlmAnalysis;
      cached: boolean;
    }
  | { kind: "error"; toolCallId: string; toolName: string; message: string };

/**
 * In-process channel for dual LLM analysis progress between the LLM proxy
 * handler (publisher, during trusted-data evaluation of a loopback request)
 * and the chat turn that issued the request (subscriber, rendering the
 * analysis as a structured UI part). Channel ids are per-turn UUIDs carried on
 * `DUAL_LLM_PROGRESS_CHANNEL_HEADER`; chat and proxy always share a process,
 * so no cross-instance delivery is needed. Events on a channel nobody
 * subscribed to are dropped.
 */
class DualLlmProgressBus {
  private emitter = new EventEmitter();

  constructor() {
    // One listener per concurrent chat turn; the default cap of 10 would warn
    // under normal parallel load.
    this.emitter.setMaxListeners(0);
  }

  publish(channelId: string, event: DualLlmProgressEvent): void {
    this.emitter.emit(channelId, event);
  }

  /** Returns the unsubscribe function; call it when the turn's stream settles. */
  subscribe(
    channelId: string,
    listener: (event: DualLlmProgressEvent) => void,
  ): () => void {
    this.emitter.on(channelId, listener);
    return () => this.emitter.off(channelId, listener);
  }
}

export const dualLlmProgressBus = new DualLlmProgressBus();
