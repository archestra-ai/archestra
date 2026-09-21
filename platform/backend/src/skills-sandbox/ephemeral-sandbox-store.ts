import { randomUUID } from "node:crypto";
import type { ReplayCommand, ReplayEntry } from "@archestra/sandbox-rs";
import { LRUCacheManager } from "@/cache-manager";
import {
  asSandboxId,
  type SkillSandbox,
  type SkillSandboxSkillMount,
} from "@/types";
import {
  type SkillMountInput,
  SkillSandboxError,
  type UploadRef,
} from "./types";

const EXECUTION_TTL_MS = 60 * 60 * 1000;
const MAX_EXECUTIONS = 128;
const MAX_SANDBOXES = 1024;
const MAX_SANDBOXES_PER_EXECUTION = 16;
const MAX_ENTRIES_PER_EXECUTION = 256;
const MAX_ENTRIES = 2048;
// Include the UTF-16 upper bound for replay strings, including base64 expansion.
const MAX_BYTES_PER_EXECUTION = 160 * 1024 * 1024;
const MAX_BYTES = 320 * 1024 * 1024;

interface ExecutionState {
  active: boolean;
  sandboxes: Set<EphemeralSandboxState>;
  bytes: number;
  entries: number;
  timer: NodeJS.Timeout;
  onRelease?: () => void;
}

/** An execution-owned recipe. It is never backed by a database or host spool. */
export class EphemeralSandboxState {
  private readonly replay: ReplayEntry[] = [];
  private readonly uploads = new Map<string, UploadRef>();
  private readonly mounts = new Map<string, SkillSandboxSkillMount>();

  readonly sandbox: SkillSandbox;
  readonly isolationKey: string;
  private readonly execution: ExecutionState;
  private readonly admit: (entries: ReplayEntry[]) => void;

  constructor(params: {
    sandbox: SkillSandbox;
    isolationKey: string;
    execution: ExecutionState;
    admit: (entries: ReplayEntry[]) => void;
  }) {
    this.sandbox = params.sandbox;
    this.isolationKey = params.isolationKey;
    this.execution = params.execution;
    this.admit = params.admit;
  }

  assertActive(): void {
    if (!this.execution.active) {
      throw new SkillSandboxError(
        "This temporary execution has ended. Fetch the file again in a new execution.",
      );
    }
  }

  get skillIds(): string[] {
    this.assertActive();
    return [...this.mounts.keys()];
  }

  get replayEntries(): ReplayEntry[] {
    this.assertActive();
    return this.replay.slice();
  }

  findMountBySkill(skillId: string): SkillSandboxSkillMount | null {
    this.assertActive();
    return this.mounts.get(skillId) ?? null;
  }

  appendCommand(command: ReplayCommand): string {
    this.append([{ kind: "command", command }]);
    return randomUUID();
  }

  appendUpload(params: {
    path: string;
    mimeType: string;
    data: Buffer;
    dedupeId?: string;
  }): UploadRef {
    this.assertActive();
    const existing = params.dedupeId
      ? this.uploads.get(params.dedupeId)
      : undefined;
    if (existing) return existing;
    const ref: UploadRef = {
      uploadId: randomUUID(),
      sandboxId: asSandboxId(this.sandbox.id),
      path: params.path,
      mimeType: params.mimeType,
      sizeBytes: params.data.byteLength,
    };
    this.append([
      {
        kind: "file",
        file: {
          path: params.path,
          encoding: "base64",
          content: params.data.toString("base64"),
        },
      },
    ]);
    if (params.dedupeId) this.uploads.set(params.dedupeId, ref);
    return ref;
  }

  appendMount(params: {
    skill: SkillMountInput;
    entry: ReplayEntry;
    installCommands: ReplayCommand[];
  }): SkillSandboxSkillMount | null {
    this.assertActive();
    if (this.mounts.has(params.skill.skillId)) return null;
    if (
      [...this.mounts.values()].some(
        (mount) => mount.skillName === params.skill.skillName,
      )
    ) {
      throw new SkillSandboxError(
        `A different skill is already mounted as "${params.skill.skillName}". Start a fresh sandbox to load it.`,
      );
    }
    const mount: SkillSandboxSkillMount = {
      id: randomUUID(),
      sandboxId: this.sandbox.id,
      ...params.skill,
      createdAt: new Date(),
    };
    this.append([
      params.entry,
      ...params.installCommands.map((command) => ({
        kind: "command",
        command,
      })),
    ]);
    this.mounts.set(mount.skillId, mount);
    return mount;
  }

  /** Drop references, including on a lease captured by an in-flight operation. */
  clear(): void {
    this.replay.length = 0;
    this.uploads.clear();
    this.mounts.clear();
  }

  private append(entries: ReplayEntry[]): void {
    this.assertActive();
    this.admit(entries);
    this.replay.push(...entries);
  }
}

class EphemeralSandboxStore {
  // Cache primitives provide bounded indexes. Admission rejects before capacity
  // eviction; these are live leases, so silently evicting one would lose a run.
  private readonly executions = new LRUCacheManager<ExecutionState>({
    maxSize: MAX_EXECUTIONS,
    defaultTtl: 0,
  });
  private readonly sandboxes = new LRUCacheManager<EphemeralSandboxState>({
    maxSize: MAX_SANDBOXES,
    defaultTtl: 0,
  });
  private retainedBytes = 0;
  private retainedEntries = 0;

  openExecution(isolationKey: string, onRelease?: () => void): void {
    if (this.executions.has(isolationKey)) {
      throw new SkillSandboxError("The temporary execution is already open.");
    }
    if (this.executions.size >= MAX_EXECUTIONS) throw capacityError();
    // A real timer is deliberate: shared cache TTLs are lazy and would keep
    // idle file bytes indefinitely when callers disappear without cleanup.
    const timer = setTimeout(
      () => this.release(isolationKey),
      EXECUTION_TTL_MS,
    );
    timer.unref();
    this.executions.set(isolationKey, {
      active: true,
      sandboxes: new Set(),
      bytes: 0,
      entries: 0,
      timer,
      onRelease,
    });
  }

  assertExecutionActive(isolationKey: string): void {
    this.execution(isolationKey);
  }

  create(params: {
    isolationKey: string;
    organizationId: string;
    userId: string;
    defaultCwd: string;
  }): SkillSandbox {
    const execution = this.execution(params.isolationKey);
    if (
      execution.sandboxes.size >= MAX_SANDBOXES_PER_EXECUTION ||
      this.sandboxes.size >= MAX_SANDBOXES
    )
      throw capacityError();
    const sandbox: SkillSandbox = {
      id: randomUUID(),
      organizationId: params.organizationId,
      userId: params.userId,
      defaultCwd: params.defaultCwd,
      conversationId: null,
      appId: null,
      isDefault: false,
      nextReplaySequence: 0,
      createdAt: new Date(),
    };
    const state = new EphemeralSandboxState({
      sandbox,
      isolationKey: params.isolationKey,
      execution,
      admit: (entries) => {
        // Strings may occupy two bytes per code unit. Count the complete replay
        // object as well, so command bodies and configured skill assets are bounded.
        const bytes = JSON.stringify(entries).length * 2;
        if (
          execution.bytes + bytes > MAX_BYTES_PER_EXECUTION ||
          this.retainedBytes + bytes > MAX_BYTES ||
          execution.entries + entries.length > MAX_ENTRIES_PER_EXECUTION ||
          this.retainedEntries + entries.length > MAX_ENTRIES
        )
          throw capacityError();
        execution.bytes += bytes;
        execution.entries += entries.length;
        this.retainedBytes += bytes;
        this.retainedEntries += entries.length;
      },
    });
    execution.sandboxes.add(state);
    this.sandboxes.set(sandbox.id, state);
    return sandbox;
  }

  findById(id: string): EphemeralSandboxState | undefined {
    return this.sandboxes.get(id);
  }

  release(isolationKey: string): void {
    const execution = this.executions.get(isolationKey);
    if (!execution) return;
    execution.active = false;
    clearTimeout(execution.timer);
    for (const state of execution.sandboxes) {
      this.sandboxes.delete(state.sandbox.id);
      state.clear();
    }
    execution.sandboxes.clear();
    this.retainedBytes -= execution.bytes;
    this.retainedEntries -= execution.entries;
    this.executions.delete(isolationKey);
    // Remove admission before notifying the other execution-owned stores.
    // Their cleanup can safely call release again without recursive callbacks.
    execution.onRelease?.();
  }

  private execution(isolationKey: string): ExecutionState {
    const execution = this.executions.get(isolationKey);
    if (!execution?.active) {
      throw new SkillSandboxError(
        "This temporary execution has ended. Fetch the file again in a new execution.",
      );
    }
    return execution;
  }
}

export const ephemeralSandboxStore = new EphemeralSandboxStore();

function capacityError(): SkillSandboxError {
  return new SkillSandboxError(
    "Temporary sandbox storage is full. Use fewer or smaller files, or retry in a new execution.",
  );
}
