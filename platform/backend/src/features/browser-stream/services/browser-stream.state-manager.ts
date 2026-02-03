import logger from "@/logging";
import { ConversationModel } from "@/models";
import {
  toPersistedState,
  toRuntimeState,
} from "./browser-stream.state.conversion";
import { isErr } from "./browser-stream.state.helpers";
import {
  type BrowserState,
  type BrowserStateError,
  Err,
  Ok,
  type Result,
} from "./browser-stream.state.types";

export type ConversationStateKey = `${string}:${string}:${string}`;

export const toConversationStateKey = (
  agentId: string,
  userId: string,
  conversationId: string,
): ConversationStateKey => `${agentId}:${userId}:${conversationId}`;

type StateManagerError =
  | { kind: "DatabaseError"; message: string }
  | { kind: "StateError"; error: BrowserStateError };

/**
 * Manages browser tab state with in-memory cache and database persistence.
 * Replaces the simple conversationTabMap with full logical tab state management.
 */
class BrowserStateManager {
  private cache = new Map<ConversationStateKey, BrowserState>();

  /**
   * Get browser state for a conversation, loading from DB if not cached.
   * Returns null if no state exists for the conversation.
   */
  async getOrLoad(params: {
    agentId: string;
    userId: string;
    conversationId: string;
  }): Promise<Result<StateManagerError, BrowserState | null>> {
    const { agentId, userId, conversationId } = params;
    const key = toConversationStateKey(agentId, userId, conversationId);

    const cached = this.cache.get(key);
    if (cached) {
      return Ok(cached);
    }

    try {
      const persisted = await ConversationModel.getBrowserState(conversationId);
      if (!persisted) {
        return Ok(null);
      }

      const runtime = toRuntimeState(persisted);
      this.cache.set(key, runtime);

      logger.info(
        {
          agentId,
          userId,
          conversationId,
          tabCount: runtime.tabs.length,
          activeTabId: runtime.activeTabId,
          tabOrder: runtime.tabOrder,
          tabs: runtime.tabs.map((t) => ({
            id: t.id,
            current: t.current,
          })),
        },
        "[BrowserStateManager] Loaded state from database",
      );

      return Ok(runtime);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { agentId, userId, conversationId, error: message },
        "[BrowserStateManager] Failed to load state from database",
      );
      return Err({ kind: "DatabaseError", message });
    }
  }

  /**
   * Update browser state by applying a pure transformation function.
   * Caches the result and persists to database.
   */
  async update(params: {
    agentId: string;
    userId: string;
    conversationId: string;
    updateFn: (state: BrowserState) => Result<BrowserStateError, BrowserState>;
  }): Promise<Result<StateManagerError, BrowserState>> {
    const { agentId, userId, conversationId, updateFn } = params;
    const key = toConversationStateKey(agentId, userId, conversationId);

    const loadResult = await this.getOrLoad({
      agentId,
      userId,
      conversationId,
    });
    if (isErr(loadResult)) {
      return loadResult;
    }

    const currentState = loadResult.value;
    if (!currentState) {
      return Err({
        kind: "StateError",
        error: { kind: "TabNotFound", tabId: "none" },
      });
    }

    const updateResult = updateFn(currentState);
    if (isErr(updateResult)) {
      return Err({ kind: "StateError", error: updateResult.error });
    }

    const newState = updateResult.value;
    this.cache.set(key, newState);

    const persistResult = await this.persist({
      agentId,
      userId,
      conversationId,
    });
    if (isErr(persistResult)) {
      return persistResult;
    }

    return Ok(newState);
  }

  /**
   * Set browser state directly (for initialization or restoration).
   * Caches and persists the state.
   */
  async set(params: {
    agentId: string;
    userId: string;
    conversationId: string;
    state: BrowserState;
  }): Promise<Result<StateManagerError, BrowserState>> {
    const { agentId, userId, conversationId, state } = params;
    const key = toConversationStateKey(agentId, userId, conversationId);

    this.cache.set(key, state);

    const persistResult = await this.persist({
      agentId,
      userId,
      conversationId,
    });
    if (isErr(persistResult)) {
      return persistResult;
    }

    logger.info(
      {
        agentId,
        userId,
        conversationId,
        tabCount: state.tabs.length,
        activeTabId: state.activeTabId,
        tabOrder: state.tabOrder,
        tabs: state.tabs.map((t) => ({
          id: t.id,
          current: t.current,
        })),
      },
      "[BrowserStateManager] State set and persisted",
    );

    return Ok(state);
  }

  /**
   * Persist current cached state to database.
   */
  async persist(params: {
    agentId: string;
    userId: string;
    conversationId: string;
  }): Promise<Result<StateManagerError, void>> {
    const { agentId, userId, conversationId } = params;
    const key = toConversationStateKey(agentId, userId, conversationId);

    const cached = this.cache.get(key);
    if (!cached) {
      return Ok(undefined);
    }

    try {
      const persisted = toPersistedState(cached);
      await ConversationModel.updateBrowserState(conversationId, persisted);

      logger.info(
        {
          agentId,
          userId,
          conversationId,
          tabCount: cached.tabs.length,
          activeTabId: cached.activeTabId,
        },
        "[BrowserStateManager] Persisted state to database",
      );

      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { agentId, userId, conversationId, error: message },
        "[BrowserStateManager] Failed to persist state to database",
      );
      return Err({ kind: "DatabaseError", message });
    }
  }

  /**
   * Get cached state without loading from database.
   */
  getCached(params: {
    agentId: string;
    userId: string;
    conversationId: string;
  }): BrowserState | undefined {
    const { agentId, userId, conversationId } = params;
    const key = toConversationStateKey(agentId, userId, conversationId);
    return this.cache.get(key);
  }

  /**
   * Clear cache entry for a conversation.
   */
  clearCache(params: {
    agentId: string;
    userId: string;
    conversationId: string;
  }): void {
    const { agentId, userId, conversationId } = params;
    const key = toConversationStateKey(agentId, userId, conversationId);
    this.cache.delete(key);

    logger.debug(
      { agentId, userId, conversationId },
      "[BrowserStateManager] Cleared cache entry",
    );
  }

  /**
   * Clear browser state from both cache and database.
   */
  async clear(params: {
    agentId: string;
    userId: string;
    conversationId: string;
  }): Promise<Result<StateManagerError, void>> {
    const { agentId, userId, conversationId } = params;
    const key = toConversationStateKey(agentId, userId, conversationId);

    this.cache.delete(key);

    try {
      await ConversationModel.updateBrowserState(conversationId, null);

      logger.info(
        { agentId, userId, conversationId },
        "[BrowserStateManager] Cleared state from cache and database",
      );

      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { agentId, userId, conversationId, error: message },
        "[BrowserStateManager] Failed to clear state from database",
      );
      return Err({ kind: "DatabaseError", message });
    }
  }
}

export const browserStateManager = new BrowserStateManager();
