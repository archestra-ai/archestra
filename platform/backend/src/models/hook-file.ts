import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import config from "@/config";
import db, { schema, withDbTransaction } from "@/database";
import type {
  HookEvent,
  HookFile,
  InsertHookFile,
  UpdateHookFile,
} from "@/types/hook";
import {
  InsertHookFileSchema,
  SelectHookFileSchema,
  UpdateHookFileSchema,
} from "@/types/hook";
import { callRustApi } from "@/utils/rust-api";
import AgentModel from "./agent";
import AgentVersionModel from "./agent-version";

class HookFileModel {
  static async findByIdForAudit(id: string, organizationId: string) {
    const hook = await HookFileModel.findById(id, organizationId);
    if (!hook) return null;
    const { content, ...metadata } = hook;
    return {
      ...metadata,
      contentHash: createHash("sha256").update(content).digest("hex"),
    };
  }

  static async create(data: InsertHookFile): Promise<HookFile> {
    const parsed = InsertHookFileSchema.parse(data);
    const [row] = await db
      .insert(schema.hookFilesTable)
      .values(parsed)
      .returning();
    // Hooks are part of the agent config snapshot — fork a version.
    await AgentVersionModel.forkIfChangedBestEffort(row.agentId);
    return row;
  }

  static async createMcpNative(
    data: InsertHookFile,
    signal: AbortSignal,
  ): Promise<HookFile | "unique_violation" | null> {
    const input = InsertHookFileSchema.parse(data);
    return writeMcpHook({
      path: "/internal/v1/mcp/tools/create-hook",
      json: JSON.stringify({ ...input, enabled: input.enabled ?? true }),
      organizationId: input.organizationId,
      signal,
    });
  }

  static async findById(
    id: string,
    organizationId: string,
  ): Promise<HookFile | null> {
    const [row] = await db
      .select()
      .from(schema.hookFilesTable)
      .where(
        and(
          eq(schema.hookFilesTable.id, id),
          eq(schema.hookFilesTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  static async listByAgent(
    agentId: string,
    organizationId: string,
  ): Promise<HookFile[]> {
    return await db
      .select()
      .from(schema.hookFilesTable)
      .where(
        and(
          eq(schema.hookFilesTable.agentId, agentId),
          eq(schema.hookFilesTable.organizationId, organizationId),
        ),
      )
      .orderBy(
        asc(schema.hookFilesTable.event),
        asc(schema.hookFilesTable.fileName),
      );
  }

  static async listEnabledByAgentAndEvent(params: {
    agentId: string;
    organizationId: string;
    event: HookEvent;
  }): Promise<HookFile[]> {
    return await db
      .select()
      .from(schema.hookFilesTable)
      .where(
        and(
          eq(schema.hookFilesTable.agentId, params.agentId),
          eq(schema.hookFilesTable.organizationId, params.organizationId),
          eq(schema.hookFilesTable.event, params.event),
          eq(schema.hookFilesTable.enabled, true),
        ),
      )
      .orderBy(asc(schema.hookFilesTable.fileName));
  }

  static async update(params: {
    id: string;
    organizationId: string;
    data: UpdateHookFile;
  }): Promise<HookFile | null> {
    const parsed = UpdateHookFileSchema.parse(params.data);
    const [row] = await db
      .update(schema.hookFilesTable)
      .set(parsed)
      .where(
        and(
          eq(schema.hookFilesTable.id, params.id),
          eq(schema.hookFilesTable.organizationId, params.organizationId),
        ),
      )
      .returning();
    if (row) {
      await AgentVersionModel.forkIfChangedBestEffort(row.agentId);
    }
    return row ?? null;
  }

  static async updateMcpNative(params: {
    target: { id: string; agentId: string; organizationId: string };
    data: UpdateHookFile;
    signal: AbortSignal;
  }): Promise<HookFile | "unique_violation" | null> {
    const { target, data, signal } = params;
    return writeMcpHook({
      path: "/internal/v1/mcp/tools/update-hook",
      json: JSON.stringify({ target, data: UpdateHookFileSchema.parse(data) }),
      organizationId: target.organizationId,
      signal,
    });
  }

  /**
   * Replace the agent's entire hook set in one transaction. Rows are keyed by
   * `(agent_id, event, file_name)` and carry no FK referents, so a
   * delete-then-insert is safe and keeps the whole-set semantics the snapshot
   * replay needs (a hook absent from the payload must disappear).
   *
   * Takes the agent's row lock first, like the exclusions full-replace: without
   * it a concurrent `create` landing between the delete and the insert hits the
   * `(agent_id, event, file_name)` unique index, failing the replace with the
   * old hooks already gone.
   */
  static async replaceForAgent(params: {
    agentId: string;
    organizationId: string;
    hooks: Omit<InsertHookFile, "agentId" | "organizationId">[];
    /** See `AgentToolAssignmentRequest.deferVersionFork`. */
    deferVersionFork?: boolean;
  }): Promise<void> {
    const rows = params.hooks.map((hook) =>
      InsertHookFileSchema.parse({
        ...hook,
        agentId: params.agentId,
        organizationId: params.organizationId,
      }),
    );

    await withDbTransaction(async (tx) => {
      await AgentModel.lockRowForUpdate(params.agentId, tx);
      await tx
        .delete(schema.hookFilesTable)
        .where(
          and(
            eq(schema.hookFilesTable.agentId, params.agentId),
            eq(schema.hookFilesTable.organizationId, params.organizationId),
          ),
        );
      if (rows.length > 0) {
        await tx.insert(schema.hookFilesTable).values(rows);
      }
    });

    if (!params.deferVersionFork) {
      await AgentVersionModel.forkIfChangedBestEffort(params.agentId);
    }
  }

  static async delete(id: string, organizationId: string): Promise<boolean> {
    const rows = await db
      .delete(schema.hookFilesTable)
      .where(
        and(
          eq(schema.hookFilesTable.id, id),
          eq(schema.hookFilesTable.organizationId, organizationId),
        ),
      )
      // agentId is needed to fork the owning agent's config version.
      .returning({
        id: schema.hookFilesTable.id,
        agentId: schema.hookFilesTable.agentId,
      });
    if (rows.length > 0) {
      await AgentVersionModel.forkIfChangedBestEffort(rows[0].agentId);
    }
    return rows.length > 0;
  }

  static async deleteMcpNative(params: {
    id: string;
    agentId: string;
    organizationId: string;
    signal: AbortSignal;
  }): Promise<boolean> {
    const { signal, ...input } = params;
    const socketPath = config.database.rustAuditLogSocket;
    if (!socketPath) throw new Error("Rust MCP tool socket is not configured");
    signal.throwIfAborted();
    const deleted = z.boolean().parse(
      await callRustApi({
        socketPath,
        path: "/internal/v1/mcp/tools/delete-hook",
        json: JSON.stringify(input),
      }),
    );
    if (deleted) await AgentVersionModel.forkIfChangedBestEffort(input.agentId);
    return deleted;
  }
}

export default HookFileModel;

async function writeMcpHook(params: {
  path:
    | "/internal/v1/mcp/tools/create-hook"
    | "/internal/v1/mcp/tools/update-hook";
  json: string;
  organizationId: string;
  signal: AbortSignal;
}): Promise<HookFile | "unique_violation" | null> {
  const { path, json, organizationId, signal } = params;
  const socketPath = config.database.rustAuditLogSocket;
  if (!socketPath) throw new Error("Rust MCP tool socket is not configured");
  signal.throwIfAborted();
  const timestamp = z.iso.datetime().transform((value) => new Date(value));
  const hook = SelectHookFileSchema.omit({ organizationId: true })
    .extend({ createdAt: timestamp, updatedAt: timestamp })
    .nullable()
    .or(z.literal("unique_violation"))
    .parse(await callRustApi({ socketPath, path, json }));
  if (!hook || hook === "unique_violation") return hook;
  await AgentVersionModel.forkIfChangedBestEffort(hook.agentId);
  return { ...hook, organizationId };
}
