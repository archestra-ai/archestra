import logger from "@/logging";
import { BrowserTabStateModel } from "@/models";
import {
  Err,
  Ok,
  type Result,
  type SimpleBrowserState,
} from "./browser-stream.state.types";

export type ConversationStateKey = `${string}:${string}:${string}`;

export const toConversationStateKey = (
  agentId: string,
  userId: string,
  isolationKey: string,
): ConversationStateKey => `${agentId}:${userId}:${isolationKey}`;

type StateManagerError = { kind: "DatabaseError"; message: string };

/**
 * Manages browser tab state with database persistence.
 * Each agent+user+isolationKey combination gets its own tab state,
 * enabling per-agent isolation for sub-agents and A2A execution.
 */
class BrowserStateManager {
  /**
   * Get browser state for an agent/user/isolationKey from the database.
   * Returns null if no state exists.
   */
  async get(
    agentId: string,
    userId: string,
    isolationKey: string,
  ): Promise<SimpleBrowserState | null> {
    const row = await BrowserTabStateModel.get(agentId, userId, isolationKey);
    if (!row) {
      return null;
    }
    return {
      url: row.url ?? "",
      tabIndex: row.tabIndex ?? undefined,
    };
  }

  /**
   * Set browser state directly.
   * Persists the state to database via upsert.
   */
  async set(
    agentId: string,
    userId: string,
    isolationKey: string,
    state: SimpleBrowserState,
  ): Promise<Result<StateManagerError, void>> {
    try {
      await BrowserTabStateModel.upsert(agentId, userId, isolationKey, {
        url: state.url,
        tabIndex: state.tabIndex,
      });

      logger.debug(
        {
          agentId,
          userId,
          isolationKey,
          url: state.url,
          tabIndex: state.tabIndex,
        },
        "[BrowserStateManager] State set and persisted",
      );

      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { agentId, userId, isolationKey, error: message },
        "[BrowserStateManager] Failed to persist state to database",
      );
      return Err({ kind: "DatabaseError", message });
    }
  }

  /**
   * Update just the URL in browser state.
   * Creates state if it doesn't exist.
   */
  async updateUrl(
    agentId: string,
    userId: string,
    isolationKey: string,
    url: string,
  ): Promise<void> {
    await BrowserTabStateModel.updateUrl(agentId, userId, isolationKey, url);
  }

  /**
   * Clear browser state from database.
   */
  async clear(
    agentId: string,
    userId: string,
    isolationKey: string,
  ): Promise<Result<StateManagerError, void>> {
    try {
      await BrowserTabStateModel.delete(agentId, userId, isolationKey);

      logger.debug(
        { agentId, userId, isolationKey },
        "[BrowserStateManager] Cleared state from database",
      );

      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { agentId, userId, isolationKey, error: message },
        "[BrowserStateManager] Failed to clear state from database",
      );
      return Err({ kind: "DatabaseError", message });
    }
  }
}

export const browserStateManager = new BrowserStateManager();
