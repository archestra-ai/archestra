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

/**
 * Follow-up supersede marker: when a run registers with this option and
 * another run for the same thread AND sender is already in flight, the older
 * of the two (by `sequence`) is aborted. A user double-texting mid-generation
 * gets one reply — to their latest message, with the earlier message in
 * context — instead of a stale answer followed by a fresh one.
 *
 * `sequence` orders the sender's messages (Telegram message_id, or a
 * timestamp): registration order can invert message order when updates are
 * dispatched concurrently, so the comparison decides which run survives.
 */
interface ChatOpsRunSupersede {
  senderId: string;
  sequence: number;
}

interface ChatOpsRunEntry {
  controller: AbortController;
  supersede?: ChatOpsRunSupersede;
}

class ChatOpsRunRegistry {
  private readonly runs = new Map<string, Set<ChatOpsRunEntry>>();

  /**
   * Register an in-flight run for a thread. Returns the run's abort signal (to
   * thread into the agent execution) and an `unregister` callback the caller
   * MUST invoke in a `finally` once the run settles, so the controller is not
   * retained after it completes.
   *
   * With `supersede` set, an older in-flight run for the same thread+sender is
   * aborted — or this run is aborted immediately when the in-flight one is
   * newer (a late-dispatched stale message: its turn still gets recorded, but
   * no reply is posted for it).
   */
  register(
    key: ChatOpsThreadKey,
    options?: { supersede?: ChatOpsRunSupersede },
  ): {
    signal: AbortSignal;
    unregister: () => void;
  } {
    const cacheKey = this.threadCacheKey(key);
    const entry: ChatOpsRunEntry = {
      controller: new AbortController(),
      supersede: options?.supersede,
    };

    let entries = this.runs.get(cacheKey);
    if (!entries) {
      entries = new Set();
      this.runs.set(cacheKey, entries);
    }

    if (entry.supersede) {
      for (const existing of entries) {
        if (
          !existing.supersede ||
          existing.supersede.senderId !== entry.supersede.senderId ||
          existing.controller.signal.aborted
        ) {
          continue;
        }
        const loser =
          existing.supersede.sequence <= entry.supersede.sequence
            ? existing
            : entry;
        loser.controller.abort();
        logger.info(
          {
            provider: key.provider,
            channelId: key.channelId,
            threadId: key.threadId,
            supersededSequence: loser.supersede?.sequence,
            bySequence: (loser === existing ? entry : existing).supersede
              ?.sequence,
          },
          "[ChatOps] Superseded in-flight run by the sender's follow-up message",
        );
      }
    }

    entries.add(entry);

    return {
      signal: entry.controller.signal,
      unregister: () => {
        const set = this.runs.get(cacheKey);
        if (!set) {
          return;
        }
        set.delete(entry);
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
    const entries = this.runs.get(this.threadCacheKey(key));
    if (!entries || entries.size === 0) {
      return 0;
    }

    let aborted = 0;
    for (const entry of entries) {
      if (!entry.controller.signal.aborted) {
        entry.controller.abort();
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
