import logger from "@/logging";
import { ConversationModel } from "@/models";
import {
  Err,
  type LegacyPersistedBrowserState,
  Ok,
  type Result,
  type SimpleBrowserState,
} from "./browser-stream.state.types";

export type ConversationStateKey = `${string}:${string}:${string}`;

export const toConversationStateKey = (
  agentId: string,
  userId: string,
  conversationId: string,
): ConversationStateKey => `${agentId}:${userId}:${conversationId}`;

type StateManagerError = { kind: "DatabaseError"; message: string };

/**
 * Manages browser tab state with database persistence.
 * Simplified to store one tab per conversation with lazy migration from legacy format.
 */
class BrowserStateManager {
  /**
   * Get browser state for a conversation from the database.
   * Returns null if no state exists for the conversation.
   * Automatically migrates legacy multi-tab format to simple format.
   */
  async get(conversationId: string): Promise<SimpleBrowserState | null> {
    const persisted = await ConversationModel.getBrowserState(conversationId);
    if (!persisted) {
      return null;
    }

    // Check if this is legacy format and migrate
    if (this.isLegacyFormat(persisted)) {
      const migrated = this.migrateLegacyFormat(persisted);
      logger.info(
        { conversationId, migratedUrl: migrated.url },
        "[BrowserStateManager] Migrated legacy state format",
      );
      return migrated;
    }

    // Already in new format
    return persisted as SimpleBrowserState;
  }

  /**
   * Set browser state directly.
   * Persists the state to database.
   */
  async set(
    conversationId: string,
    state: SimpleBrowserState,
  ): Promise<Result<StateManagerError, void>> {
    try {
      await ConversationModel.updateBrowserState(conversationId, state);

      logger.debug(
        { conversationId, url: state.url, tabIndex: state.tabIndex },
        "[BrowserStateManager] State set and persisted",
      );

      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { conversationId, error: message },
        "[BrowserStateManager] Failed to persist state to database",
      );
      return Err({ kind: "DatabaseError", message });
    }
  }

  /**
   * Update just the URL in browser state.
   * Creates state if it doesn't exist.
   */
  async updateUrl(conversationId: string, url: string): Promise<void> {
    const existing = await this.get(conversationId);
    await this.set(conversationId, {
      url,
      tabIndex: existing?.tabIndex,
    });
  }

  /**
   * Clear browser state from database.
   */
  async clear(
    conversationId: string,
  ): Promise<Result<StateManagerError, void>> {
    try {
      await ConversationModel.updateBrowserState(conversationId, null);

      logger.debug(
        { conversationId },
        "[BrowserStateManager] Cleared state from database",
      );

      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { conversationId, error: message },
        "[BrowserStateManager] Failed to clear state from database",
      );
      return Err({ kind: "DatabaseError", message });
    }
  }

  /**
   * Detect if state is in legacy multi-tab format.
   */
  private isLegacyFormat(state: unknown): state is LegacyPersistedBrowserState {
    if (typeof state !== "object" || state === null) {
      return false;
    }
    const candidate = state as Record<string, unknown>;
    return (
      typeof candidate.activeTabId === "string" &&
      Array.isArray(candidate.tabOrder) &&
      typeof candidate.tabs === "object" &&
      candidate.tabs !== null
    );
  }

  /**
   * Migrate legacy multi-tab format to simple single-tab format.
   * Extracts URL from the active tab.
   */
  private migrateLegacyFormat(
    legacy: LegacyPersistedBrowserState,
  ): SimpleBrowserState {
    const activeTab = legacy.tabs[legacy.activeTabId];
    const url = activeTab?.current ?? "about:blank";

    // tabIndex will be undefined since we don't know the current browser state
    // This will trigger new tab creation on next access
    return { url };
  }
}

export const browserStateManager = new BrowserStateManager();
