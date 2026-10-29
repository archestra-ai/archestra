import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LRUCacheManager } from "@/cache-manager";
import logger from "@/logging";
import { BrowserStorageStateModel } from "@/models";
import { extractRunCodeResult } from "./run-code-result";

// Declared before the class: the singleton below is built at module load
//   restored        - got the saved state; may only update the saved row, so a
//                     row an admin deleted is never re-created
//   restored-empty  - nothing was saved; its first save may create the row
//   stopped         - never saves (restore failed or the row was deleted)
type SessionStatus = "restored" | "restored-empty" | "stopped";

const SAVE_DELAY_MS = 3_000;
const SESSION_STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STATE_BYTES = 1_000_000;

/**
 * Keeps a user's browser logins across Playwright browser contexts.
 *
 * Playwright runs with --isolated, so every MCP session is a fresh in-memory
 * browser context: a new conversation or a Playwright pod restart starts
 * logged out. This restores the user's saved storageState (cookies and
 * localStorage) into each new context before its first tool call, and saves
 * the context's state back after tool calls, debounced.
 *
 * Saved state is per user and shared across all of the user's agents.
 */
class BrowserStorageSync {
  // Per MCP session: whether its context received the saved state. Only
  // restored sessions may save, so an unrestored empty context can never
  // overwrite a saved login.
  private sessionStatus = new LRUCacheManager<SessionStatus>({
    maxSize: 10_000,
    defaultTtl: SESSION_STATUS_TTL_MS,
  });
  private restoresInFlight = new Map<string, Promise<void>>();
  private pendingSaves = new Map<string, NodeJS.Timeout>();

  /**
   * Restore the user's saved state into the session's browser context the
   * first time this backend sees the session. Idempotent: the restore is a
   * no-op for a context that already has cookies.
   */
  async ensureRestored(params: {
    client: Client;
    sessionId: string;
    userId: string;
  }): Promise<void> {
    const { sessionId } = params;
    if (this.sessionStatus.get(sessionId)) return;

    const inFlight = this.restoresInFlight.get(sessionId);
    if (inFlight) return inFlight;

    const restore = this.restore(params).finally(() => {
      this.restoresInFlight.delete(sessionId);
    });
    this.restoresInFlight.set(sessionId, restore);
    return restore;
  }

  /**
   * Save the session's browser state shortly after a tool call. At most one
   * save per window: the preview's screenshot calls arrive every couple of
   * seconds, so a timer reset on each call would never fire.
   */
  scheduleSave(params: {
    client: Client;
    sessionId: string;
    userId: string;
  }): void {
    const { sessionId } = params;
    const status = this.sessionStatus.get(sessionId);
    if (status !== "restored" && status !== "restored-empty") return;

    if (this.pendingSaves.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.pendingSaves.delete(sessionId);
      void this.save(params);
    }, SAVE_DELAY_MS);
    timer.unref?.();
    this.pendingSaves.set(sessionId, timer);
  }

  // ===

  private async restore(params: {
    client: Client;
    sessionId: string;
    userId: string;
  }): Promise<void> {
    const { client, sessionId, userId } = params;
    try {
      const state = await BrowserStorageStateModel.get(userId);
      if (state) {
        // JSON is a valid JS literal and JSON.stringify escapes every quote and
        // backslash, so site-controlled cookie values cannot break out of it.
        await runCode(client, buildRestoreCode(state));
      }
      this.sessionStatus.set(sessionId, state ? "restored" : "restored-empty");
      logger.debug(
        { userId, sessionId, hadSavedState: !!state },
        "[BrowserStorageSync] Browser context restored",
      );
    } catch (error) {
      // Don't retry on every tool call, and never let this context save
      this.sessionStatus.set(sessionId, "stopped");
      logger.warn(
        { userId, sessionId, error },
        "[BrowserStorageSync] Failed to restore saved browser state",
      );
    }
  }

  private async save(params: {
    client: Client;
    sessionId: string;
    userId: string;
  }): Promise<void> {
    const { client, sessionId, userId } = params;
    try {
      const state = await runCode(
        client,
        "async (page) => await page.context().storageState()",
      );
      if (state === null) return;
      if (state.length > MAX_STATE_BYTES) {
        logger.warn(
          { userId, sessionId, bytes: state.length },
          "[BrowserStorageSync] Browser state too large to save; skipped",
        );
        return;
      }
      if (this.sessionStatus.get(sessionId) === "restored-empty") {
        await BrowserStorageStateModel.upsert(userId, state);
        this.sessionStatus.set(sessionId, "restored");
        return;
      }
      const updated = await BrowserStorageStateModel.update(userId, state);
      if (!updated) {
        // An admin signed the user out: keep this browser's state unsaved
        this.sessionStatus.set(sessionId, "stopped");
        logger.debug(
          { userId, sessionId },
          "[BrowserStorageSync] Saved browser state was deleted; stopped saving this session",
        );
      }
    } catch (error) {
      // The session may have closed since the tool call; next call retries
      logger.debug(
        { userId, sessionId, error },
        "[BrowserStorageSync] Failed to save browser state",
      );
    }
  }
}

export const browserStorageSync = new BrowserStorageSync();

// ===

function buildRestoreCode(state: string): string {
  return `async (page) => {
  const context = page.context();
  if ((await context.cookies()).length > 0) return "skipped";
  const state = ${state};
  if (state.cookies?.length) await context.addCookies(state.cookies);
  for (const { origin, localStorage: items } of state.origins ?? []) {
    await context.addInitScript(({ origin, items }) => {
      if (location.origin !== origin) return;
      for (const { name, value } of items) {
        if (localStorage.getItem(name) === null) localStorage.setItem(name, value);
      }
    }, { origin, items });
  }
  return "restored";
}`;
}

/**
 * Run Playwright code over the session's raw MCP client. Internal state sync,
 * so it bypasses the gateway's tool-call pipeline on purpose. Returns the
 * function's JSON-serialized return value, or null if it returned nothing.
 */
async function runCode(client: Client, code: string): Promise<string | null> {
  // MCP 0.0.83 renamed this tool; use the server's advertised contract so
  // upgrades preserve saved logins and older runtimes remain compatible.
  const { tools } = await client.listTools();
  const tool =
    tools.find((tool) => tool.name === "browser_run_code") ??
    tools.find((tool) => tool.name === "browser_run_code_unsafe");
  if (!tool) throw new Error("Playwright browser code tool is unavailable");
  const result = await client.callTool(
    { name: tool.name, arguments: { code } },
    undefined,
    { timeout: RUN_CODE_TIMEOUT_MS },
  );
  const text = (result.content as Array<{ type: string; text?: string }>)
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  if (result.isError) {
    throw new Error(text || "browser_run_code failed");
  }
  return extractRunCodeResult(text);
}

const RUN_CODE_TIMEOUT_MS = 30_000;
