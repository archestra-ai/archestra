/**
 * In-memory registry of in-flight chatops agent runs, keyed by channel thread.
 *
 * ChatOps messages are processed fire-and-forget and fully concurrently: a user
 * can send several messages in a thread, each spinning up its own (potentially
 * long) agent turn, before deciding to mute the bot. Muting only dropped the
 * sticky auto-reply for FUTURE messages — the already-running turns kept going
 * and still posted their replies, so the user got answers after asking for
 * silence.
 *
 * This registry lets a mute abort those runs. Each turn registers an
 * AbortController for its thread; muting the thread aborts every controller
 * registered for it, so their model requests stop instead of running to
 * completion. The signal is threaded down into the agent execution (see
 * `A2AManager.sendMessage` → `executeA2AMessage`), which passes it to the AI SDK
 * `streamText` call.
 *
 * Scope: this is a per-process registry, so it cancels the compute of runs
 * executing on the SAME pod that received the mute — the whole story for
 * single-pod deployments and for Slack socket-mode (one pod owns the socket, so
 * a thread's messages and its mute land together). For multi-pod webhook
 * deployments a mute may land on a different pod than a given run; the durable
 * cross-pod guarantee that no reply is posted after a mute is provided
 * separately by the distributed mute marker (see `channel-activation.ts`), which
 * every pod consults before replying. This registry is the compute-saving
 * fast-path; the marker is the correctness backstop.
 */

import logger from "@/logging";
import type { ChatOpsProviderType } from "@/types/chatops";

interface ChatOpsThreadKey {
  provider: ChatOpsProviderType;
  channelId: string;
  /**
   * Thread root identifier. Callers that lack one (direct messages, which can't
   * be muted anyway) pass the channel id, matching how runs are keyed — so a DM
   * run is registered under a key a mute can never target.
   */
  threadId: string;
}

class ChatOpsRunRegistry {
  private readonly runs = new Map<string, Set<AbortController>>();

  /**
   * Register an in-flight run for a thread. Returns the run's abort signal (to
   * thread into the agent execution) and an `unregister` callback the caller
   * MUST invoke in a `finally` once the run settles, so the controller is not
   * retained after it completes.
   */
  register(key: ChatOpsThreadKey): {
    signal: AbortSignal;
    unregister: () => void;
  } {
    const cacheKey = this.threadCacheKey(key);
    const controller = new AbortController();

    let controllers = this.runs.get(cacheKey);
    if (!controllers) {
      controllers = new Set();
      this.runs.set(cacheKey, controllers);
    }
    controllers.add(controller);

    return {
      signal: controller.signal,
      unregister: () => {
        const set = this.runs.get(cacheKey);
        if (!set) {
          return;
        }
        set.delete(controller);
        if (set.size === 0) {
          this.runs.delete(cacheKey);
        }
      },
    };
  }

  /**
   * Abort every in-flight run registered for a thread on this process. Returns
   * how many runs were aborted (0 when none were running here). Safe to call for
   * a thread with no local runs.
   */
  cancelThread(key: ChatOpsThreadKey): number {
    const controllers = this.runs.get(this.threadCacheKey(key));
    if (!controllers || controllers.size === 0) {
      return 0;
    }

    let aborted = 0;
    for (const controller of controllers) {
      if (!controller.signal.aborted) {
        controller.abort();
        aborted += 1;
      }
    }

    if (aborted > 0) {
      logger.info(
        {
          provider: key.provider,
          channelId: key.channelId,
          threadId: key.threadId,
          aborted,
        },
        "[ChatOps] Cancelled in-flight runs after thread was muted",
      );
    }

    return aborted;
  }

  private threadCacheKey(key: ChatOpsThreadKey): string {
    return `${key.provider}::${key.channelId}::${key.threadId}`;
  }
}

export const chatOpsRunRegistry = new ChatOpsRunRegistry();
