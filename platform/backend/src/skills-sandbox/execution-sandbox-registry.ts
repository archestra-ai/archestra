import { randomUUID } from "node:crypto";
import logger from "@/logging";
import { SkillSandboxModel } from "@/models";
import type { SkillSandbox } from "@/types";
import { ephemeralSandboxStore } from "./ephemeral-sandbox-store";

const EPHEMERAL_EXECUTION_PREFIX = "slack-ephemeral:";

/**
 * Per-execution sandboxes for headless runs (direct A2A, ChatOps, schedule
 * triggers, incoming email), where there is no persisted conversation to scope
 * the default sandbox to.
 *
 * Slack roots explicitly open a volatile scope. Its namespace survives release
 * so a late call cannot mistake a closed scope for a durable execution.
 * Other headless runs create rows with `conversationId: null` and `isDefault: false`: the
 * partial unique index on `(org, user, conversation_id) WHERE is_default`
 * treats NULLs as distinct, so a default-flagged null-conversation row would
 * have no uniqueness protection. Instead, single-creation is guaranteed by
 * caching the creation promise in-process, keyed by the execution's isolation
 * key — an A2A execution runs within one process, so concurrent first calls
 * from the same execution always share one entry. An execution that resumes in
 * another process (e.g. an approval continuation) gets a fresh sandbox.
 *
 * Entries are released by the root headless execution when it finishes (see
 * `executeA2AMessage`); delegated sub-agents share the parent's isolation key
 * and therefore its sandbox scope.
 */
class ExecutionSandboxRegistry {
  private entries = new Map<string, ExecutionSandboxEntry>();
  private keysByIsolationKey = new Map<string, Set<string>>();

  openEphemeralExecution(onRelease?: (isolationKey: string) => void): string {
    const isolationKey = `${EPHEMERAL_EXECUTION_PREFIX}${randomUUID()}`;
    ephemeralSandboxStore.openExecution(isolationKey, () => {
      this.dropEntries(isolationKey);
      onRelease?.(isolationKey);
    });
    return isolationKey;
  }

  isEphemeralExecution(isolationKey: string | null | undefined): boolean {
    return isolationKey?.startsWith(EPHEMERAL_EXECUTION_PREFIX) ?? false;
  }

  async createFresh(params: {
    organizationId: string;
    userId: string;
    isolationKey: string;
    defaultCwd: string;
  }): Promise<SkillSandbox> {
    const sandbox = this.isEphemeralExecution(params.isolationKey)
      ? ephemeralSandboxStore.create(params)
      : await SkillSandboxModel.create({
          organizationId: params.organizationId,
          userId: params.userId,
          conversationId: null,
          defaultCwd: params.defaultCwd,
          isDefault: false,
        });
    this.registerOwned({ ...params, sandboxId: sandbox.id });
    return sandbox;
  }

  /**
   * The execution's default sandbox, created on first call. Concurrent calls
   * share one creation promise; a failed creation is evicted so the next call
   * retries instead of caching the rejection.
   */
  async getOrCreateDefault(params: {
    organizationId: string;
    userId: string;
    isolationKey: string;
    defaultCwd: string;
  }): Promise<SkillSandbox> {
    const entry = this.ensureEntry(params);
    if (!entry.defaultSandbox) {
      entry.defaultSandbox = this.createFresh(params).then(
        (sandbox) => {
          if (this.isEphemeralExecution(params.isolationKey)) {
            ephemeralSandboxStore.assertExecutionActive(params.isolationKey);
          }
          entry.ownedSandboxIds.add(sandbox.id);
          logger.info(
            {
              organizationId: params.organizationId,
              userId: params.userId,
              sandboxId: sandbox.id,
            },
            "[Sandbox] created per-execution sandbox for headless run",
          );
          return sandbox;
        },
        (error) => {
          entry.defaultSandbox = undefined;
          throw error;
        },
      );
    }
    return await entry.defaultSandbox;
  }

  /** The execution's default sandbox if one was created, without creating. */
  async findDefault(params: {
    organizationId: string;
    userId: string;
    isolationKey: string;
  }): Promise<SkillSandbox | null> {
    if (this.isEphemeralExecution(params.isolationKey)) {
      ephemeralSandboxStore.assertExecutionActive(params.isolationKey);
    }
    const entry = this.entries.get(entryKey(params));
    if (!entry?.defaultSandbox) return null;
    return await entry.defaultSandbox;
  }

  /**
   * Record a non-default sandbox (`{fresh: true}`) as belonging to this
   * execution, so explicit `{id}` targets can be scoped to it later.
   */
  registerOwned(params: {
    organizationId: string;
    userId: string;
    isolationKey: string;
    sandboxId: string;
  }): void {
    this.ensureEntry(params).ownedSandboxIds.add(params.sandboxId);
  }

  /**
   * Whether the sandbox was created by this execution. Conversation-less
   * sandbox rows are retained after their execution ends, so explicit ids must
   * not cross execution boundaries.
   */
  isOwned(params: {
    organizationId: string;
    userId: string;
    isolationKey: string;
    sandboxId: string;
  }): boolean {
    if (
      this.isEphemeralExecution(params.isolationKey) &&
      !ephemeralSandboxStore.findById(params.sandboxId)
    ) {
      return false;
    }
    return (
      this.entries
        .get(entryKey(params))
        ?.ownedSandboxIds.has(params.sandboxId) ?? false
    );
  }

  /**
   * Drop all state for an execution. Called when the root execution ends.
   * Volatile scopes close before their indexes are dropped, rejecting late
   * sandbox calls instead of admitting new state after an abort.
   */
  release(isolationKey: string): void {
    ephemeralSandboxStore.release(isolationKey);
    this.dropEntries(isolationKey);
  }

  private dropEntries(isolationKey: string): void {
    const keys = this.keysByIsolationKey.get(isolationKey);
    if (!keys) return;
    for (const key of keys) {
      this.entries.delete(key);
    }
    this.keysByIsolationKey.delete(isolationKey);
  }

  private ensureEntry(params: {
    organizationId: string;
    userId: string;
    isolationKey: string;
  }): ExecutionSandboxEntry {
    if (this.isEphemeralExecution(params.isolationKey)) {
      ephemeralSandboxStore.assertExecutionActive(params.isolationKey);
    }
    const key = entryKey(params);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { ownedSandboxIds: new Set() };
      this.entries.set(key, entry);
      let keys = this.keysByIsolationKey.get(params.isolationKey);
      if (!keys) {
        keys = new Set();
        this.keysByIsolationKey.set(params.isolationKey, keys);
      }
      keys.add(key);
    }
    return entry;
  }
}

export const executionSandboxRegistry = new ExecutionSandboxRegistry();

// === internal helpers ===

interface ExecutionSandboxEntry {
  defaultSandbox?: Promise<SkillSandbox>;
  ownedSandboxIds: Set<string>;
}

// delegated sub-agents can run as a different user within the same isolation
// scope; each (org, user) pair gets its own sandbox, all released together.
function entryKey(params: {
  organizationId: string;
  userId: string;
  isolationKey: string;
}): string {
  return `${params.organizationId}:${params.userId}:${params.isolationKey}`;
}
