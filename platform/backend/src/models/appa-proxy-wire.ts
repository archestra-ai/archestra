import { createHmac, randomUUID } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import appaProxySessionsTable from "@/database/schemas/appa-proxy-session";
import {
  appaProxyWireAliasesTable as aliases,
  appaProxyWireFramesTable as frames,
} from "@/database/schemas/appa-proxy-wire";
import type {
  AppaWireAliasKind,
  AppaWireFrameKind,
} from "@/types/appa-proxy-wire";
import { APPA_LOCAL_REGISTRY_DISCOVERY_PROGRAM } from "@/types/appa-proxy-wire";
import {
  decryptStringWithKey,
  deriveKeyFromSecret,
  encryptStringWithKey,
} from "@/utils/crypto";
import { AppaProxySessionProtocolError } from "./appa-proxy-session";

type Scope = { sessionId: string; ownerScopeHash: string };

/** Durable wire identity and control receipts. No payload is stored in plaintext. */
export default class AppaProxyWireModel {
  static async createFrame(
    params: Scope & {
      turnId: string;
      kind: AppaWireFrameKind;
      protocol: string;
      requestHash: string;
      idempotencyKey: string;
      payload: unknown;
      sourceResponseId?: string;
      parentFrameId?: string;
      runtimeBatchId?: string;
      controlCallId?: string;
      expiresAt: Date;
    },
  ) {
    for (const value of [
      params.protocol,
      params.idempotencyKey,
      params.requestHash,
      params.sourceResponseId,
      params.controlCallId,
      params.runtimeBatchId,
      params.turnId,
    ]) {
      if (value !== undefined && value.length > 512)
        fail("APPA wire identifier is too large");
    }
    if (
      params.kind === "remedy_control" &&
      (!params.parentFrameId || !params.controlCallId)
    ) {
      fail("APPA control requires a held parent and issued call identity");
    }
    const id = randomUUID();
    const serialized = canonicalJson(params.payload);
    const payloadBytes = Buffer.byteLength(serialized);
    const receiptBytes = params.kind === "remedy_control" ? 64 * 1024 : 0;
    if (payloadBytes > 16 * 1024 * 1024)
      fail("APPA wire frame exceeds its storage limit");
    return db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(appaProxySessionsTable)
        .where(
          and(
            eq(appaProxySessionsTable.id, params.sessionId),
            eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
          ),
        )
        .for("update");
      if (
        !session ||
        session.state !== "in_turn" ||
        session.activeTurnId !== params.turnId
      ) {
        fail("APPA wire frame has no active owned turn");
      }
      const [existing] = await tx
        .select()
        .from(frames)
        .where(
          and(
            eq(frames.sessionId, params.sessionId),
            eq(frames.idempotencyKey, params.idempotencyKey),
          ),
        );
      if (existing) {
        if (
          existing.kind !== params.kind ||
          existing.turnId !== params.turnId ||
          existing.parentFrameId !== (params.parentFrameId ?? null) ||
          existing.runtimeBatchId !== (params.runtimeBatchId ?? null) ||
          existing.protocol !== params.protocol ||
          existing.requestHash !== params.requestHash ||
          existing.payloadHash !== digest(serialized) ||
          existing.sourceResponseId !== (params.sourceResponseId ?? null) ||
          existing.controlCallId !== (params.controlCallId ?? null)
        ) {
          fail("APPA wire request identity was reused with different content");
        }
        return existing;
      }
      if (params.parentFrameId) {
        const [parent] = await tx
          .select({
            id: frames.id,
            turnId: frames.turnId,
            kind: frames.kind,
            state: frames.state,
          })
          .from(frames)
          .where(
            and(
              eq(frames.id, params.parentFrameId),
              eq(frames.sessionId, params.sessionId),
            ),
          );
        if (!parent) fail("APPA wire parent belongs to another session");
        if (
          params.kind === "remedy_control" &&
          (parent.turnId !== params.turnId ||
            parent.kind === "remedy_control" ||
            !["held", "ready"].includes(parent.state))
        ) {
          fail("APPA control parent is not held in the active turn");
        }
      }
      const [usage] = await tx
        .select({
          bytes: sql<number>`coalesce(sum(${frames.payloadBytes} + ${frames.receiptBytes}), 0)::integer`,
          count: sql<number>`count(*)::integer`,
        })
        .from(frames)
        .where(eq(frames.sessionId, params.sessionId));
      const [aliasUsage] = await tx
        .select({
          bytes: sql<number>`coalesce(sum(${aliases.metadataBytes}), 0)::integer`,
        })
        .from(aliases)
        .where(eq(aliases.sessionId, params.sessionId));
      if (
        (usage?.count ?? 0) >= 4096 ||
        (usage?.bytes ?? 0) +
          (aliasUsage?.bytes ?? 0) +
          payloadBytes +
          receiptBytes >
          64 * 1024 * 1024
      ) {
        fail(
          "APPA wire history budget exhausted; existing records were preserved",
        );
      }
      const [frame] = await tx
        .insert(frames)
        .values({
          id,
          sessionId: params.sessionId,
          turnId: params.turnId,
          kind: params.kind,
          protocol: params.protocol,
          requestHash: params.requestHash,
          idempotencyKey: params.idempotencyKey,
          sourceResponseId: params.sourceResponseId,
          parentFrameId: params.parentFrameId,
          runtimeBatchId: params.runtimeBatchId,
          controlCallId: params.controlCallId,
          payloadCiphertext: seal(
            serialized,
            `frame:${params.sessionId}:${id}`,
          ),
          payloadHash: digest(serialized),
          payloadBytes,
          receiptBytes,
          expiresAt: params.expiresAt,
        })
        .returning();
      return frame;
    });
  }

  /**
   * Records the native bridge's fixed local registry discovery before model
   * execution. It creates an encrypted inbound-hold frame only; no control
   * receipt, remote event, or approval authority can be produced from it.
   */
  static async recordLocalObservation(
    params: Scope & {
      turnId: string;
      idempotencyKey: string;
      tools: Readonly<Record<string, unknown>>;
      expiresAt: Date;
    },
  ) {
    const toolNames = Object.keys(params.tools);
    if (
      toolNames.length > 10_000 ||
      toolNames.some((name) => name.length === 0 || name.length > 512)
    ) {
      fail("APPA local registry observation is too large");
    }
    const outputText = JSON.stringify(toolNames);
    if (Buffer.byteLength(outputText) > 1024 * 1024) {
      fail("APPA local registry observation is too large");
    }
    const payload = {
      version: 1 as const,
      purpose: "client_local_observation" as const,
      type: "registry_discovery" as const,
      program: APPA_LOCAL_REGISTRY_DISCOVERY_PROGRAM,
      toolNames,
      outputText,
    };
    return AppaProxyWireModel.createFrame({
      ...params,
      kind: "inbound_hold",
      protocol: "client-local-observation/v1",
      requestHash: digest(canonicalJson(payload)),
      payload,
    });
  }

  static async findOwned(params: Scope & { frameId: string }) {
    const [row] = await db
      .select({ frame: frames })
      .from(frames)
      .innerJoin(
        appaProxySessionsTable,
        eq(frames.sessionId, appaProxySessionsTable.id),
      )
      .where(
        and(
          eq(frames.id, params.frameId),
          eq(frames.sessionId, params.sessionId),
          eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
        ),
      );
    if (!row) return null;
    return {
      frame: row.frame,
      payload: unseal(
        row.frame.payloadCiphertext,
        `frame:${params.sessionId}:${row.frame.id}`,
      ),
      receipt: row.frame.receiptCiphertext
        ? unseal(
            row.frame.receiptCiphertext,
            `receipt:${params.sessionId}:${row.frame.id}`,
          )
        : null,
    };
  }

  /** Verifies the authenticated profile before a new native response is sealed. */
  static async assertOwnedProfile(
    params: Scope & { profileId: string; turnId: string },
  ): Promise<void> {
    const [session] = await db
      .select({ id: appaProxySessionsTable.id })
      .from(appaProxySessionsTable)
      .where(
        and(
          eq(appaProxySessionsTable.id, params.sessionId),
          eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
          eq(appaProxySessionsTable.profileId, params.profileId),
          eq(appaProxySessionsTable.state, "in_turn"),
          eq(appaProxySessionsTable.activeTurnId, params.turnId),
        ),
      )
      .limit(1);
    if (!session) fail("APPA wire frame has no active owned profile");
  }

  /**
   * Seals the receipt for a provider response after its full raw wire payload
   * was encrypted in a held frame. A completed retry can only repeat identical
   * receipt bytes; it cannot produce another response-side effect.
   */
  static async completeModelResponseFrame(
    params: Scope & {
      turnId: string;
      frameId: string;
      protocol: string;
      receipt: unknown;
    },
  ) {
    const serialized = canonicalJson(params.receipt);
    const receiptBytes = Buffer.byteLength(serialized);
    if (receiptBytes > 64 * 1024) {
      fail("APPA model response receipt is too large");
    }
    const receiptHash = digest(serialized);
    return db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ frame: frames, session: appaProxySessionsTable })
        .from(frames)
        .innerJoin(
          appaProxySessionsTable,
          eq(frames.sessionId, appaProxySessionsTable.id),
        )
        .where(
          and(
            eq(frames.id, params.frameId),
            eq(frames.sessionId, params.sessionId),
            eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
          ),
        )
        .for("update");
      if (
        !owned ||
        owned.frame.kind !== "model_response" ||
        owned.frame.protocol !== params.protocol ||
        owned.frame.turnId !== params.turnId
      ) {
        fail("APPA model response receipt has no owned frame");
      }
      if (owned.frame.state === "completed") {
        if (owned.frame.receiptHash !== receiptHash) {
          fail("APPA model response receipt changed on replay");
        }
        return owned.frame;
      }
      if (
        !["held", "ready", "issued"].includes(owned.frame.state) ||
        owned.frame.expiresAt <= new Date() ||
        owned.session.state !== "in_turn" ||
        owned.session.activeTurnId !== params.turnId
      ) {
        fail("APPA model response is not active");
      }
      const now = new Date();
      const [completed] = await tx
        .update(frames)
        .set({
          state: "completed",
          issuedAt: owned.frame.issuedAt ?? now,
          completedAt: now,
          receiptHash,
          receiptBytes,
          receiptCiphertext: seal(
            serialized,
            `receipt:${params.sessionId}:${params.frameId}`,
          ),
        })
        .where(
          and(eq(frames.id, params.frameId), ne(frames.state, "completed")),
        )
        .returning();
      if (!completed) fail("APPA model response receipt completion was lost");
      return completed;
    });
  }

  /** Replaces an unpublished held response with its runtime-effective calls. */
  static async replaceHeldPayload(
    params: Scope & {
      turnId: string;
      frameId: string;
      payload: unknown;
    },
  ): Promise<void> {
    const serialized = canonicalJson(params.payload);
    const payloadBytes = Buffer.byteLength(serialized);
    if (payloadBytes > 16 * 1024 * 1024) {
      fail("APPA wire frame exceeds its storage limit");
    }
    const rows = await db
      .update(frames)
      .set({
        payloadCiphertext: seal(
          serialized,
          `frame:${params.sessionId}:${params.frameId}`,
        ),
        payloadHash: digest(serialized),
        payloadBytes,
      })
      .where(
        and(
          eq(frames.id, params.frameId),
          eq(frames.sessionId, params.sessionId),
          eq(frames.turnId, params.turnId),
          eq(frames.state, "held"),
        ),
      )
      .returning({ id: frames.id });
    if (rows.length !== 1) {
      fail("APPA held response changed unexpectedly");
    }
  }

  static async findByControlCall(params: Scope & { controlCallId: string }) {
    const [frame] = await db
      .select({ id: frames.id })
      .from(frames)
      .where(
        and(
          eq(frames.sessionId, params.sessionId),
          eq(frames.controlCallId, params.controlCallId),
          ne(frames.protocol, "native-mcp-execution/v1"),
        ),
      );
    return frame
      ? AppaProxyWireModel.findOwned({ ...params, frameId: frame.id })
      : null;
  }

  /**
   * Locates a control frame without decrypting it. The caller must first
   * authorize both the MCP gateway profile and this actual LLM profile before
   * passing the returned owned scope to `findOwned`.
   */
  static async findControlMetadataForOrganization(params: {
    controlCallId: string;
    organizationId: string;
  }) {
    const [row] = await db
      .select({ frame: frames, session: appaProxySessionsTable })
      .from(frames)
      .innerJoin(
        appaProxySessionsTable,
        eq(frames.sessionId, appaProxySessionsTable.id),
      )
      .innerJoin(
        schema.agentsTable,
        eq(appaProxySessionsTable.profileId, schema.agentsTable.id),
      )
      .where(
        and(
          eq(frames.controlCallId, params.controlCallId),
          eq(schema.agentsTable.organizationId, params.organizationId),
          eq(frames.kind, "remedy_control"),
          ne(frames.protocol, "native-mcp-execution/v1"),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Returns the server-owned native thread while the alias is being issued. */
  static async getActiveNativeThreadId(params: Scope & { turnId: string }) {
    const [session] = await db
      .select({ clientSessionId: appaProxySessionsTable.clientSessionId })
      .from(appaProxySessionsTable)
      .where(
        and(
          eq(appaProxySessionsTable.id, params.sessionId),
          eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
          eq(appaProxySessionsTable.activeTurnId, params.turnId),
          eq(appaProxySessionsTable.state, "in_turn"),
        ),
      )
      .limit(1);
    return session?.clientSessionId ?? null;
  }

  /**
   * Locates a client-visible native call without decrypting its binding. The
   * gateway must authorize the originating LLM profile before calling a method
   * that decrypts alias metadata.
   */
  static async findNativeCallMetadataForOrganization(params: {
    callId: string;
    organizationId: string;
  }) {
    const [row] = await db
      .select({
        alias: aliases,
        frame: frames,
        session: appaProxySessionsTable,
      })
      .from(aliases)
      .innerJoin(
        frames,
        and(
          eq(aliases.frameId, frames.id),
          eq(aliases.sessionId, frames.sessionId),
        ),
      )
      .innerJoin(
        appaProxySessionsTable,
        eq(aliases.sessionId, appaProxySessionsTable.id),
      )
      .innerJoin(
        schema.agentsTable,
        eq(appaProxySessionsTable.profileId, schema.agentsTable.id),
      )
      .where(
        and(
          eq(aliases.kind, "call"),
          eq(aliases.wireId, params.callId),
          eq(frames.kind, "model_response"),
          eq(frames.protocol, "codex-native-response/v1"),
          eq(schema.agentsTable.organizationId, params.organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Reads the sealed binding only after an authorized caller has scoped it. */
  static readNativeCallAliasMetadata(params: Scope & { aliasId: string }) {
    return db
      .select({ alias: aliases })
      .from(aliases)
      .innerJoin(
        appaProxySessionsTable,
        eq(aliases.sessionId, appaProxySessionsTable.id),
      )
      .where(
        and(
          eq(aliases.id, params.aliasId),
          eq(aliases.sessionId, params.sessionId),
          eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
        ),
      )
      .limit(1)
      .then(([row]) =>
        row
          ? unseal(
              row.alias.metadataCiphertext,
              `alias:${params.sessionId}:${row.alias.id}`,
            )
          : null,
      );
  }

  /**
   * Claims one issued native MCP call before external execution. The alias CAS
   * is the durable execution gate; the child frame owns the bounded receipt.
   */
  static async claimNativeMcpExecution(
    params: Scope & {
      aliasId: string;
      callId: string;
      expectedExecutionArgumentsCanonical: string;
    },
  ) {
    const expectedRequestHash = digest(
      params.expectedExecutionArgumentsCanonical,
    );
    return db.transaction(async (tx) => {
      const [owned] = await tx
        .select({
          alias: aliases,
          frame: frames,
          session: appaProxySessionsTable,
        })
        .from(aliases)
        .innerJoin(
          frames,
          and(
            eq(aliases.frameId, frames.id),
            eq(aliases.sessionId, frames.sessionId),
          ),
        )
        .innerJoin(
          appaProxySessionsTable,
          eq(aliases.sessionId, appaProxySessionsTable.id),
        )
        .where(
          and(
            eq(aliases.id, params.aliasId),
            eq(aliases.sessionId, params.sessionId),
            eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
          ),
        )
        .for("update");
      if (
        !owned ||
        owned.alias.kind !== "call" ||
        owned.alias.wireId !== params.callId ||
        owned.frame.kind !== "model_response" ||
        owned.frame.protocol !== "codex-native-response/v1" ||
        !["issued", "completed"].includes(owned.frame.state) ||
        owned.frame.expiresAt <= new Date() ||
        owned.session.state === "quarantined"
      ) {
        fail("APPA native MCP call is not active");
      }
      const issued = unseal(
        owned.frame.payloadCiphertext,
        `frame:${params.sessionId}:${owned.frame.id}`,
      ) as { calls?: Array<{ id?: unknown; arguments?: unknown }> };
      const issuedCall = Array.isArray(issued.calls)
        ? issued.calls.find((call) => call.id === params.callId)
        : undefined;
      if (
        typeof issuedCall?.arguments !== "string" ||
        canonicalJson(JSON.parse(issuedCall.arguments)) !==
          params.expectedExecutionArgumentsCanonical
      ) {
        fail("APPA native MCP execution binding changed");
      }
      const aliasMetadata = unseal(
        owned.alias.metadataCiphertext,
        `alias:${params.sessionId}:${owned.alias.id}`,
      );
      const aliasExecutionArgumentsCanonical =
        isRecord(aliasMetadata) &&
        typeof aliasMetadata.executionArgumentsCanonical === "string"
          ? aliasMetadata.executionArgumentsCanonical
          : isRecord(aliasMetadata) &&
              typeof aliasMetadata.argumentsCanonical === "string"
            ? aliasMetadata.argumentsCanonical
            : undefined;
      if (
        !isRecord(aliasMetadata) ||
        aliasExecutionArgumentsCanonical !==
          params.expectedExecutionArgumentsCanonical
      ) {
        fail("APPA native MCP execution binding changed");
      }

      const [existing] = await tx
        .select()
        .from(frames)
        .where(eq(frames.controlCallId, params.callId))
        .for("update");
      if (existing) {
        if (
          existing.kind !== "remedy_control" ||
          existing.protocol !== "native-mcp-execution/v1" ||
          existing.parentFrameId !== owned.frame.id ||
          existing.executionRequestHash !== expectedRequestHash
        ) {
          fail("APPA native MCP execution binding changed");
        }
        return {
          state:
            existing.state === "completed"
              ? ("completed" as const)
              : ("running" as const),
          frame: existing,
        };
      }
      if (owned.alias.consumedAt) {
        fail("APPA native MCP call was consumed without a receipt");
      }
      const payload = canonicalJson({
        version: 1,
        purpose: "native_mcp_execution",
        callId: params.callId,
        executionArgumentsCanonical: params.expectedExecutionArgumentsCanonical,
      });
      const payloadBytes = Buffer.byteLength(payload);
      if (payloadBytes > 16 * 1024 * 1024) {
        fail("APPA wire frame exceeds its storage limit");
      }
      const [frameUsage] = await tx
        .select({
          count: sql<number>`count(*)::integer`,
          bytes: sql<number>`coalesce(sum(${frames.payloadBytes} + ${frames.receiptBytes}), 0)::integer`,
        })
        .from(frames)
        .where(eq(frames.sessionId, params.sessionId));
      const [aliasUsage] = await tx
        .select({
          bytes: sql<number>`coalesce(sum(${aliases.metadataBytes}), 0)::integer`,
        })
        .from(aliases)
        .where(eq(aliases.sessionId, params.sessionId));
      if (
        (frameUsage?.count ?? 0) >= 4096 ||
        (frameUsage?.bytes ?? 0) +
          (aliasUsage?.bytes ?? 0) +
          payloadBytes +
          64 * 1024 >
          64 * 1024 * 1024
      ) {
        fail(
          "APPA wire history budget exhausted; existing records were preserved",
        );
      }
      const [consumed] = await tx
        .update(aliases)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(aliases.id, owned.alias.id),
            sql`${aliases.consumedAt} is null`,
          ),
        )
        .returning({ id: aliases.id });
      if (!consumed) fail("APPA native MCP execution claim was lost");

      const id = randomUUID();
      const [frame] = await tx
        .insert(frames)
        .values({
          id,
          sessionId: params.sessionId,
          turnId: owned.frame.turnId,
          kind: "remedy_control",
          state: "running",
          protocol: "native-mcp-execution/v1",
          requestHash: expectedRequestHash,
          idempotencyKey: `native-mcp-execution:${params.callId}`,
          parentFrameId: owned.frame.id,
          controlCallId: params.callId,
          payloadCiphertext: seal(payload, `frame:${params.sessionId}:${id}`),
          payloadHash: digest(payload),
          payloadBytes,
          // Reserve receipt capacity at claim time so a completed side effect
          // never races the session history budget.
          receiptBytes: 64 * 1024,
          executionEventId: randomUUID(),
          executionRequestHash: expectedRequestHash,
          expiresAt: owned.frame.expiresAt,
        })
        .returning();
      return { state: "acquired" as const, frame };
    });
  }

  /** Completes a claimed native MCP call with its exact, bounded server receipt. */
  static async completeNativeMcpExecution(
    params: Scope & {
      frameId: string;
      receipt: unknown;
    },
  ) {
    const serialized = canonicalJson(params.receipt);
    const receiptBytes = Buffer.byteLength(serialized);
    if (receiptBytes > 64 * 1024) fail("APPA native MCP receipt is too large");
    const receiptHash = digest(serialized);
    return db.transaction(async (tx) => {
      const [frame] = await tx
        .select()
        .from(frames)
        .where(
          and(
            eq(frames.id, params.frameId),
            eq(frames.sessionId, params.sessionId),
          ),
        )
        .for("update");
      if (
        !frame ||
        frame.kind !== "remedy_control" ||
        frame.protocol !== "native-mcp-execution/v1"
      ) {
        fail("APPA native MCP receipt has no owned execution");
      }
      if (frame.state === "completed") {
        if (frame.receiptHash !== receiptHash)
          fail("APPA native MCP receipt changed on replay");
        return frame;
      }
      if (frame.state !== "running" || frame.expiresAt <= new Date())
        fail("APPA native MCP execution is not active");
      const [completed] = await tx
        .update(frames)
        .set({
          state: "completed",
          completedAt: new Date(),
          receiptHash,
          receiptBytes,
          receiptCiphertext: seal(
            serialized,
            `receipt:${params.sessionId}:${params.frameId}`,
          ),
        })
        .where(and(eq(frames.id, params.frameId), eq(frames.state, "running")))
        .returning();
      if (!completed) fail("APPA native MCP receipt completion was lost");
      return completed;
    });
  }

  /** Returns a completed owned native receipt; running and absent claims stay opaque. */
  static async findNativeMcpExecutionReceipt(
    params: Scope & {
      callId: string;
    },
  ) {
    const [frame] = await db
      .select({ frame: frames })
      .from(frames)
      .innerJoin(
        appaProxySessionsTable,
        eq(frames.sessionId, appaProxySessionsTable.id),
      )
      .where(
        and(
          eq(frames.sessionId, params.sessionId),
          eq(frames.controlCallId, params.callId),
          eq(frames.kind, "remedy_control"),
          eq(frames.protocol, "native-mcp-execution/v1"),
          eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
        ),
      )
      .limit(1);
    if (!frame) return null;
    return {
      state: frame.frame.state,
      receipt:
        frame.frame.state === "completed" && frame.frame.receiptCiphertext
          ? unseal(
              frame.frame.receiptCiphertext,
              `receipt:${params.sessionId}:${frame.frame.id}`,
            )
          : null,
    };
  }

  /**
   * Records a client-side Codex tool-search result exactly once. Search is only
   * discovery bookkeeping: this method never creates an MCP execution intent
   * and its sealed result cannot add to the declared gateway tool scope.
   */
  static async claimCodexToolSearchOutput(
    params: Scope & {
      callId: string;
      principalUserId?: string;
      output: Record<string, unknown>;
    },
  ): Promise<{ output: Record<string, unknown> }> {
    const serializedOutput = canonicalJson(params.output);
    const outputHash = digest(serializedOutput);
    const payload = canonicalJson({ output: params.output });
    const payloadBytes = Buffer.byteLength(payload);
    if (payloadBytes > 16 * 1024 * 1024) {
      fail("APPA wire frame exceeds its storage limit");
    }
    return db.transaction(async (tx) => {
      const [owned] = await tx
        .select({
          alias: aliases,
          parent: frames,
          session: appaProxySessionsTable,
        })
        .from(aliases)
        .innerJoin(
          frames,
          and(
            eq(aliases.frameId, frames.id),
            eq(aliases.sessionId, frames.sessionId),
          ),
        )
        .innerJoin(
          appaProxySessionsTable,
          eq(aliases.sessionId, appaProxySessionsTable.id),
        )
        .where(
          and(
            eq(aliases.sessionId, params.sessionId),
            eq(aliases.kind, "call"),
            eq(aliases.wireId, params.callId),
            eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
          ),
        )
        .for("update");
      if (
        !owned ||
        owned.parent.kind !== "model_response" ||
        owned.parent.protocol !== "codex-native-response/v1" ||
        !["issued", "completed"].includes(owned.parent.state) ||
        owned.parent.expiresAt <= new Date() ||
        owned.session.state !== "in_turn"
      ) {
        fail("Codex tool search output has no active issued binding");
      }
      const binding = unseal(
        owned.alias.metadataCiphertext,
        `alias:${params.sessionId}:${owned.alias.id}`,
      );
      if (
        !isCodexToolSearchBinding(binding) ||
        binding.profileId !== owned.session.profileId ||
        (typeof binding.principalUserId === "string" &&
          binding.principalUserId !== params.principalUserId) ||
        params.output.type !== "tool_search_output" ||
        params.output.call_id !== params.callId
      ) {
        fail("Codex tool search output does not match its issued binding");
      }
      const [existing] = await tx
        .select()
        .from(frames)
        .where(
          and(
            eq(frames.sessionId, params.sessionId),
            eq(frames.parentFrameId, owned.parent.id),
            eq(frames.controlCallId, params.callId),
            eq(frames.protocol, "codex-tool-search-output/v1"),
          ),
        )
        .for("update");
      if (existing) {
        if (
          existing.kind !== "inbound_hold" ||
          existing.state !== "completed" ||
          existing.requestHash !== outputHash
        ) {
          fail("Codex tool search output changed on replay");
        }
        const saved = unseal(
          existing.payloadCiphertext,
          `frame:${params.sessionId}:${existing.id}`,
        );
        if (!isRecord(saved) || !isRecord(saved.output)) {
          fail("Codex tool search output receipt is invalid");
        }
        return { output: saved.output };
      }
      if (owned.alias.consumedAt) {
        fail("Codex tool search binding was consumed without a receipt");
      }
      const [frameUsage] = await tx
        .select({
          count: sql<number>`count(*)::integer`,
          bytes: sql<number>`coalesce(sum(${frames.payloadBytes} + ${frames.receiptBytes}), 0)::integer`,
        })
        .from(frames)
        .where(eq(frames.sessionId, params.sessionId));
      const [aliasUsage] = await tx
        .select({
          bytes: sql<number>`coalesce(sum(${aliases.metadataBytes}), 0)::integer`,
        })
        .from(aliases)
        .where(eq(aliases.sessionId, params.sessionId));
      if (
        (frameUsage?.count ?? 0) >= 4096 ||
        (frameUsage?.bytes ?? 0) + (aliasUsage?.bytes ?? 0) + payloadBytes >
          64 * 1024 * 1024
      ) {
        fail(
          "APPA wire history budget exhausted; existing records were preserved",
        );
      }
      const [consumed] = await tx
        .update(aliases)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(aliases.id, owned.alias.id),
            sql`${aliases.consumedAt} is null`,
          ),
        )
        .returning({ id: aliases.id });
      if (!consumed) fail("Codex tool search output claim was lost");
      const id = randomUUID();
      await tx.insert(frames).values({
        id,
        sessionId: params.sessionId,
        turnId: owned.session.activeTurnId ?? owned.parent.turnId,
        parentFrameId: owned.parent.id,
        kind: "inbound_hold",
        state: "completed",
        protocol: "codex-tool-search-output/v1",
        requestHash: outputHash,
        idempotencyKey: `codex-tool-search-output:${params.callId}`,
        controlCallId: params.callId,
        payloadCiphertext: seal(payload, `frame:${params.sessionId}:${id}`),
        payloadHash: digest(payload),
        payloadBytes,
        expiresAt: owned.parent.expiresAt,
        completedAt: new Date(),
      });
      return { output: structuredClone(params.output) };
    });
  }

  /**
   * Reloads only completed, encrypted tool-search receipts for the owning
   * session. The client-provided output is never consulted after its claim.
   */
  static async listClaimedCodexToolSearchOutputs(params: Scope) {
    const rows = await db
      .select({ frame: frames })
      .from(frames)
      .innerJoin(
        appaProxySessionsTable,
        eq(frames.sessionId, appaProxySessionsTable.id),
      )
      .where(
        and(
          eq(frames.sessionId, params.sessionId),
          eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
          eq(frames.protocol, "codex-tool-search-output/v1"),
          eq(frames.kind, "inbound_hold"),
          eq(frames.state, "completed"),
        ),
      );
    return rows.flatMap(({ frame }) => {
      const payload = unseal(
        frame.payloadCiphertext,
        `frame:${params.sessionId}:${frame.id}`,
      );
      return isRecord(payload) && isRecord(payload.output)
        ? [payload.output]
        : [];
    });
  }

  static async getOwnedFrameMetadata(params: Scope & { frameId: string }) {
    const [row] = await db
      .select({ frame: frames, session: appaProxySessionsTable })
      .from(frames)
      .innerJoin(
        appaProxySessionsTable,
        eq(frames.sessionId, appaProxySessionsTable.id),
      )
      .where(
        and(
          eq(frames.id, params.frameId),
          eq(frames.sessionId, params.sessionId),
          eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Lists control receipts belonging to one held response without trusting client input. */
  static async listControlsForParent(
    params: Scope & { parentFrameId: string },
  ) {
    const rows = await db
      .select({ frame: frames })
      .from(frames)
      .innerJoin(
        appaProxySessionsTable,
        eq(frames.sessionId, appaProxySessionsTable.id),
      )
      .where(
        and(
          eq(frames.sessionId, params.sessionId),
          eq(frames.parentFrameId, params.parentFrameId),
          eq(frames.kind, "remedy_control"),
          ne(frames.protocol, "native-mcp-execution/v1"),
          eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
        ),
      );
    return Promise.all(
      rows.map(({ frame }) =>
        AppaProxyWireModel.findOwned({ ...params, frameId: frame.id }),
      ),
    ).then((owned) => owned.filter((item) => item !== null));
  }

  static async findHeldBatchForParent(
    params: Scope & { parentFrameId: string },
  ) {
    const [row] = await db
      .select({ id: frames.id })
      .from(frames)
      .innerJoin(
        appaProxySessionsTable,
        eq(frames.sessionId, appaProxySessionsTable.id),
      )
      .where(
        and(
          eq(frames.sessionId, params.sessionId),
          eq(frames.parentFrameId, params.parentFrameId),
          eq(frames.kind, "inbound_hold"),
          eq(frames.protocol, "held-response-batch/v1"),
          eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
        ),
      )
      .limit(1);
    return row
      ? AppaProxyWireModel.findOwned({ ...params, frameId: row.id })
      : null;
  }

  static async beginHeldBatchCommit(params: Scope & { frameId: string }) {
    return db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ frame: frames, session: appaProxySessionsTable })
        .from(frames)
        .innerJoin(
          appaProxySessionsTable,
          eq(frames.sessionId, appaProxySessionsTable.id),
        )
        .where(
          and(
            eq(frames.id, params.frameId),
            eq(frames.sessionId, params.sessionId),
            eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
          ),
        )
        .for("update");
      if (
        !owned ||
        owned.frame.kind !== "inbound_hold" ||
        owned.frame.protocol !== "held-response-batch/v1" ||
        owned.session.state !== "in_turn" ||
        owned.session.activeTurnId !== owned.frame.turnId
      ) {
        fail("APPA held batch is not active");
      }
      if (owned.frame.state !== "held")
        return { frame: owned.frame, acquired: false };
      const [running] = await tx
        .update(frames)
        .set({ state: "running" })
        .where(and(eq(frames.id, params.frameId), eq(frames.state, "held")))
        .returning();
      if (!running) fail("APPA held batch commit ownership was lost");
      return { frame: running, acquired: true };
    });
  }

  static async completeHeldBatchCommit(params: Scope & { frameId: string }) {
    const [completed] = await db
      .update(frames)
      .set({ state: "completed", completedAt: new Date() })
      .where(
        and(
          eq(frames.id, params.frameId),
          eq(frames.sessionId, params.sessionId),
          eq(frames.state, "running"),
          activeFrameScope(params),
        ),
      )
      .returning();
    if (!completed) fail("APPA held batch commit cannot complete");
    return completed;
  }

  static async markIssued(params: Scope & { frameId: string }) {
    const owned = await AppaProxyWireModel.findOwned(params);
    if (!owned || owned.frame.expiresAt <= new Date())
      fail("APPA wire frame is missing or expired");
    const [issued] = await db
      .update(frames)
      .set({ state: "issued", issuedAt: new Date() })
      .where(
        and(
          eq(frames.id, params.frameId),
          eq(frames.sessionId, params.sessionId),
          eq(frames.state, "ready"),
          activeFrameScope(params),
        ),
      )
      .returning();
    if (!issued) fail("APPA wire frame was already issued or stopped");
    return issued;
  }

  static async markReady(params: Scope & { frameId: string }) {
    const owned = await AppaProxyWireModel.findOwned(params);
    if (!owned || owned.frame.expiresAt <= new Date())
      fail("APPA wire frame is missing or expired");
    const [ready] = await db
      .update(frames)
      .set({ state: "ready" })
      .where(
        and(
          eq(frames.id, params.frameId),
          eq(frames.sessionId, params.sessionId),
          eq(frames.state, "held"),
          activeFrameScope(params),
        ),
      )
      .returning();
    if (!ready) fail("APPA wire frame cannot become ready twice");
    return ready;
  }

  /**
   * Seals native MCP aliases against the durable runtime-effective call bytes
   * while publishing the parent response. Keeping both writes in this
   * transaction prevents an issued frame from observing stale alias arguments.
   */
  static async finalizeNativeMcpBindingsAndMarkReady(
    params: Scope & { frameId: string },
  ) {
    return db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ frame: frames, session: appaProxySessionsTable })
        .from(frames)
        .innerJoin(
          appaProxySessionsTable,
          eq(frames.sessionId, appaProxySessionsTable.id),
        )
        .where(
          and(
            eq(frames.id, params.frameId),
            eq(frames.sessionId, params.sessionId),
            eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
          ),
        )
        .for("update");
      if (
        !owned ||
        owned.frame.kind !== "model_response" ||
        owned.frame.protocol !== "codex-native-response/v1" ||
        owned.frame.state !== "held" ||
        owned.frame.expiresAt <= new Date() ||
        owned.session.state !== "in_turn" ||
        owned.session.activeTurnId !== owned.frame.turnId ||
        owned.session.pendingRemoteEvent !== null
      ) {
        fail("APPA native response cannot become ready twice");
      }
      const calls = nativeMcpCallArguments(
        unseal(
          owned.frame.payloadCiphertext,
          `frame:${params.sessionId}:${owned.frame.id}`,
        ),
      );
      const frameAliases = await tx
        .select()
        .from(aliases)
        .where(
          and(
            eq(aliases.sessionId, params.sessionId),
            eq(aliases.frameId, params.frameId),
            eq(aliases.kind, "call"),
            sql`${aliases.consumedAt} is null`,
          ),
        )
        .for("update");
      const updates = frameAliases.flatMap((alias) => {
        const metadata = unseal(
          alias.metadataCiphertext,
          `alias:${params.sessionId}:${alias.id}`,
        );
        const argumentsText = calls.get(alias.wireId);
        const nextMetadata = isNativeMcpBinding(metadata)
          ? (() => {
              if (argumentsText === undefined) {
                fail("APPA native MCP binding has no current call");
              }
              const wrapper = parseNativeMcpRunToolWrapper({
                argumentsText,
                metadata,
                callId: alias.wireId,
              });
              return {
                ...metadata,
                argumentsCanonical: wrapper.targetArgumentsCanonical,
                executionArgumentsCanonical:
                  wrapper.executionArgumentsCanonical,
              };
            })()
          : isPendingCodexToolSearchBinding(metadata)
            ? finalizeCodexToolSearchBinding({
                metadata,
                payload: unseal(
                  owned.frame.payloadCiphertext,
                  `frame:${params.sessionId}:${owned.frame.id}`,
                ),
                callId: alias.wireId,
                profileId: owned.session.profileId,
              })
            : null;
        if (!nextMetadata) return [];
        const serialized = canonicalJson(nextMetadata);
        const metadataBytes = Buffer.byteLength(serialized);
        if (metadataBytes > 64 * 1024) {
          fail("APPA wire alias metadata is too large");
        }
        return [
          {
            alias,
            metadata: serialized,
            metadataBytes,
          },
        ];
      });
      const changed = updates.filter(
        (update) =>
          update.metadataBytes !== update.alias.metadataBytes ||
          update.metadata !==
            canonicalJson(
              unseal(
                update.alias.metadataCiphertext,
                `alias:${params.sessionId}:${update.alias.id}`,
              ),
            ),
      );
      const delta = changed.reduce(
        (total, update) =>
          total + update.metadataBytes - update.alias.metadataBytes,
        0,
      );
      if (delta > 0) {
        const [usage] = await tx
          .select({
            bytes: sql<number>`coalesce(sum(${frames.payloadBytes} + ${frames.receiptBytes}), 0)::integer`,
          })
          .from(frames)
          .where(eq(frames.sessionId, params.sessionId));
        const [aliasUsage] = await tx
          .select({
            bytes: sql<number>`coalesce(sum(${aliases.metadataBytes}), 0)::integer`,
          })
          .from(aliases)
          .where(eq(aliases.sessionId, params.sessionId));
        if (
          (usage?.bytes ?? 0) + (aliasUsage?.bytes ?? 0) + delta >
          64 * 1024 * 1024
        ) {
          fail(
            "APPA wire history budget exhausted; existing records were preserved",
          );
        }
      }
      for (const update of changed) {
        await tx
          .update(aliases)
          .set({
            metadataCiphertext: seal(
              update.metadata,
              `alias:${params.sessionId}:${update.alias.id}`,
            ),
            metadataBytes: update.metadataBytes,
          })
          .where(
            and(
              eq(aliases.id, update.alias.id),
              sql`${aliases.consumedAt} is null`,
            ),
          );
      }
      const [ready] = await tx
        .update(frames)
        .set({ state: "ready" })
        .where(
          and(
            eq(frames.id, params.frameId),
            eq(frames.sessionId, params.sessionId),
            eq(frames.state, "held"),
            activeFrameScope(params),
          ),
        )
        .returning();
      if (!ready) fail("APPA native response changed before publication");
      return ready;
    });
  }

  static async beginControlExecution(
    params: Scope & { frameId: string; selection: unknown },
  ) {
    const selectionHash = digest(canonicalJson(params.selection));
    return db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ frame: frames, session: appaProxySessionsTable })
        .from(frames)
        .innerJoin(
          appaProxySessionsTable,
          eq(frames.sessionId, appaProxySessionsTable.id),
        )
        .where(
          and(
            eq(frames.id, params.frameId),
            eq(frames.sessionId, params.sessionId),
            eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
          ),
        )
        .for("update");
      if (!owned || owned.frame.kind !== "remedy_control")
        fail("APPA control intent is not owned");
      if (
        owned.frame.state !== "completed" &&
        (owned.session.state === "quarantined" ||
          owned.session.activeTurnId !== owned.frame.turnId)
      )
        fail("APPA control turn is no longer active");
      if (
        owned.frame.state === "running" ||
        owned.frame.state === "completed"
      ) {
        if (owned.frame.executionRequestHash !== selectionHash)
          fail("APPA control selection changed on retry");
        return { frame: owned.frame, acquired: false };
      }
      if (owned.frame.state !== "issued" || owned.frame.expiresAt <= new Date())
        fail("APPA control intent is not active");
      const [running] = await tx
        .update(frames)
        .set({
          state: "running",
          executionEventId: randomUUID(),
          executionRequestHash: selectionHash,
        })
        .where(eq(frames.id, params.frameId))
        .returning();
      return { frame: running, acquired: true };
    });
  }

  /** Called only by the trusted gateway handler after its work actually settles. */
  static async completeControl(
    params: Scope & { frameId: string; receipt: unknown },
  ) {
    const serialized = canonicalJson(params.receipt);
    if (Buffer.byteLength(serialized) > 64 * 1024)
      fail("APPA control receipt is too large");
    const receiptHash = digest(serialized);
    return db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ frame: frames, session: appaProxySessionsTable })
        .from(frames)
        .innerJoin(
          appaProxySessionsTable,
          eq(frames.sessionId, appaProxySessionsTable.id),
        )
        .where(
          and(
            eq(frames.id, params.frameId),
            eq(frames.sessionId, params.sessionId),
            eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
          ),
        )
        .for("update");
      if (!owned || owned.frame.kind !== "remedy_control")
        fail("APPA control receipt has no owned intent");
      if (
        owned.frame.state !== "completed" &&
        (owned.session.state === "quarantined" ||
          owned.session.activeTurnId !== owned.frame.turnId)
      )
        fail("APPA control turn is no longer active");
      if (owned.frame.state === "completed") {
        if (owned.frame.receiptHash !== receiptHash)
          fail("APPA control receipt changed on replay");
        return owned.frame;
      }
      if (
        owned.frame.state !== "running" ||
        owned.frame.expiresAt <= new Date()
      ) {
        fail("APPA control intent is not active");
      }
      const [completed] = await tx
        .update(frames)
        .set({
          state: "completed",
          completedAt: new Date(),
          receiptHash,
          receiptBytes: Buffer.byteLength(serialized),
          receiptCiphertext: seal(
            serialized,
            `receipt:${params.sessionId}:${params.frameId}`,
          ),
        })
        .where(eq(frames.id, params.frameId))
        .returning();
      return completed;
    });
  }

  /** Persists a control-runtime envelope before its HTTP request is sent. */
  static async createControlRemoteEventIntent(
    params: Scope & {
      frameId: string;
      turnId: string;
      eventId: string;
      event: string;
      requestBody: string;
      requestSha256: string;
    },
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ frame: frames, session: appaProxySessionsTable })
        .from(frames)
        .innerJoin(
          appaProxySessionsTable,
          eq(frames.sessionId, appaProxySessionsTable.id),
        )
        .where(
          and(
            eq(frames.id, params.frameId),
            eq(frames.sessionId, params.sessionId),
            eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
          ),
        )
        .for("update");
      if (
        !owned ||
        owned.frame.kind !== "remedy_control" ||
        owned.frame.state !== "running" ||
        owned.frame.turnId !== params.turnId ||
        owned.frame.expiresAt <= new Date() ||
        owned.session.state !== "in_turn" ||
        owned.session.activeTurnId !== params.turnId ||
        owned.session.pendingRemoteEvent !== null
      ) {
        fail("APPA control cannot create a remote event");
      }
      await tx.insert(schema.appaProxyEventsTable).values({
        sessionId: params.sessionId,
        eventId: params.eventId,
        event: params.event,
        requestBody: params.requestBody,
        requestSha256: params.requestSha256,
      });
      const [updated] = await tx
        .update(appaProxySessionsTable)
        .set({ pendingRemoteEvent: params.eventId })
        .where(
          and(
            eq(appaProxySessionsTable.id, params.sessionId),
            eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
            eq(appaProxySessionsTable.state, "in_turn"),
            eq(appaProxySessionsTable.activeTurnId, params.turnId),
            sql`${appaProxySessionsTable.pendingRemoteEvent} is null`,
          ),
        )
        .returning({ id: appaProxySessionsTable.id });
      if (!updated) fail("APPA control turn ownership was lost");
    });
  }

  /** Records the exact received runtime receipt and clears the pending event. */
  static async settleControlRemoteEvent(
    params: Scope & {
      frameId: string;
      turnId: string;
      eventId: string;
      response: Record<string, unknown>;
    },
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ frame: frames, session: appaProxySessionsTable })
        .from(frames)
        .innerJoin(
          appaProxySessionsTable,
          eq(frames.sessionId, appaProxySessionsTable.id),
        )
        .where(
          and(
            eq(frames.id, params.frameId),
            eq(frames.sessionId, params.sessionId),
            eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
          ),
        )
        .for("update");
      if (
        !owned ||
        owned.frame.kind !== "remedy_control" ||
        owned.frame.state !== "running" ||
        owned.frame.turnId !== params.turnId ||
        owned.session.state !== "in_turn" ||
        owned.session.activeTurnId !== params.turnId ||
        owned.session.pendingRemoteEvent !== params.eventId
      ) {
        fail("APPA control runtime receipt is not current");
      }
      const [event] = await tx
        .update(schema.appaProxyEventsTable)
        .set({ response: params.response, settledAt: new Date() })
        .where(
          and(
            eq(schema.appaProxyEventsTable.sessionId, params.sessionId),
            eq(schema.appaProxyEventsTable.eventId, params.eventId),
            sql`${schema.appaProxyEventsTable.settledAt} is null`,
          ),
        )
        .returning({ id: schema.appaProxyEventsTable.id });
      if (!event) fail("APPA control runtime receipt changed unexpectedly");
      const [updated] = await tx
        .update(appaProxySessionsTable)
        .set({ pendingRemoteEvent: null })
        .where(
          and(
            eq(appaProxySessionsTable.id, params.sessionId),
            eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
            eq(appaProxySessionsTable.state, "in_turn"),
            eq(appaProxySessionsTable.activeTurnId, params.turnId),
            eq(appaProxySessionsTable.pendingRemoteEvent, params.eventId),
          ),
        )
        .returning({ id: appaProxySessionsTable.id });
      if (!updated) fail("APPA control turn ownership was lost");
    });
  }

  static async stopFrame(
    params: Scope & { frameId: string; state: "cancelled" | "quarantined" },
  ) {
    const owned = await AppaProxyWireModel.findOwned(params);
    if (!owned) fail("APPA wire frame is not owned");
    if (
      params.state === "cancelled" &&
      (owned.frame.state === "running" ||
        (owned.frame.kind === "model_response" &&
          owned.frame.state === "issued"))
    ) {
      fail(
        "An uncertain execution or publication must be quarantined, not cancelled",
      );
    }
    const [stopped] = await db
      .update(frames)
      .set({ state: params.state })
      .where(
        and(
          eq(frames.id, params.frameId),
          eq(frames.sessionId, params.sessionId),
          inArray(
            frames.state,
            params.state === "quarantined"
              ? ["held", "ready", "issued", "running"]
              : owned.frame.kind === "model_response"
                ? ["held", "ready"]
                : ["held", "ready", "issued"],
          ),
        ),
      )
      .returning();
    return stopped ?? null;
  }

  static async addAliases(
    params: Scope & {
      frameId: string;
      aliases: Array<{
        kind: AppaWireAliasKind;
        position: number;
        wireId: string;
        logicalId?: string;
        sourceCallId?: string;
        metadata: unknown;
      }>;
    },
  ) {
    if (params.aliases.length > 1000)
      fail("APPA wire alias batch is too large");
    return db.transaction(async (tx) => {
      // FOR UPDATE locks both joined rows, serializing the session-wide budget.
      const [owned] = await tx
        .select({ frame: frames, session: appaProxySessionsTable })
        .from(frames)
        .innerJoin(
          appaProxySessionsTable,
          eq(frames.sessionId, appaProxySessionsTable.id),
        )
        .where(
          and(
            eq(frames.id, params.frameId),
            eq(frames.sessionId, params.sessionId),
            eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
          ),
        )
        .for("update");
      if (
        !owned ||
        owned.frame.state !== "held" ||
        owned.session.state !== "in_turn" ||
        owned.session.activeTurnId !== owned.frame.turnId ||
        owned.session.pendingRemoteEvent !== null ||
        owned.frame.expiresAt <= new Date()
      )
        fail("APPA aliases must persist before frame issuance");
      if (params.aliases.length === 0) return [];
      const [usage] = await tx
        .select({
          bytes: sql<number>`coalesce(sum(${aliases.metadataBytes}), 0)::integer`,
          count: sql<number>`count(*)::integer`,
        })
        .from(aliases)
        .where(eq(aliases.sessionId, params.sessionId));
      const [frameUsage] = await tx
        .select({
          bytes: sql<number>`coalesce(sum(${frames.payloadBytes} + ${frames.receiptBytes}), 0)::integer`,
        })
        .from(frames)
        .where(eq(frames.sessionId, params.sessionId));
      if ((usage?.count ?? 0) + params.aliases.length > 4096)
        fail("APPA wire alias budget exhausted");
      const values = params.aliases.map((alias) => {
        if (
          !Number.isInteger(alias.position) ||
          alias.position < 0 ||
          !alias.wireId ||
          alias.wireId.length > 512 ||
          (alias.logicalId?.length ?? 0) > 512 ||
          (alias.sourceCallId?.length ?? 0) > 512
        ) {
          fail("APPA wire alias is invalid");
        }
        const id = randomUUID();
        const metadata = canonicalJson(alias.metadata);
        if (Buffer.byteLength(metadata) > 64 * 1024)
          fail("APPA wire alias metadata is too large");
        return {
          id,
          sessionId: params.sessionId,
          frameId: params.frameId,
          kind: alias.kind,
          position: alias.position,
          wireId: alias.wireId,
          logicalId: alias.logicalId,
          sourceCallId: alias.sourceCallId,
          metadataCiphertext: seal(metadata, `alias:${params.sessionId}:${id}`),
          metadataBytes: Buffer.byteLength(metadata),
        };
      });
      if (
        (usage?.bytes ?? 0) +
          (frameUsage?.bytes ?? 0) +
          values.reduce((sum, item) => sum + item.metadataBytes, 0) >
        64 * 1024 * 1024
      ) {
        fail(
          "APPA wire history budget exhausted; existing records were preserved",
        );
      }
      return tx.insert(aliases).values(values).returning();
    });
  }

  static async listIssuedAliases(params: Scope) {
    const rows = await db
      .select({ alias: aliases })
      .from(aliases)
      .innerJoin(
        frames,
        and(
          eq(aliases.frameId, frames.id),
          eq(aliases.sessionId, frames.sessionId),
        ),
      )
      .innerJoin(
        appaProxySessionsTable,
        eq(aliases.sessionId, appaProxySessionsTable.id),
      )
      .where(
        and(
          eq(aliases.sessionId, params.sessionId),
          eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
          inArray(frames.state, ["issued", "completed"]),
        ),
      );
    return rows.map(({ alias }) => ({
      ...alias,
      metadata: unseal(
        alias.metadataCiphertext,
        `alias:${params.sessionId}:${alias.id}`,
      ),
    }));
  }

  /** Marks one issued wire alias consumed while its owning native turn is active. */
  static async consumeIssuedAlias(
    params: Scope & { turnId: string; aliasId: string },
  ) {
    return db.transaction(async (tx) => {
      const [owned] = await tx
        .select({
          alias: aliases,
          frame: frames,
          session: appaProxySessionsTable,
        })
        .from(aliases)
        .innerJoin(
          frames,
          and(
            eq(aliases.frameId, frames.id),
            eq(aliases.sessionId, frames.sessionId),
          ),
        )
        .innerJoin(
          appaProxySessionsTable,
          eq(aliases.sessionId, appaProxySessionsTable.id),
        )
        .where(
          and(
            eq(aliases.id, params.aliasId),
            eq(aliases.sessionId, params.sessionId),
            eq(appaProxySessionsTable.ownerScopeHash, params.ownerScopeHash),
          ),
        )
        .for("update");
      if (
        !owned ||
        !["issued", "completed"].includes(owned.frame.state) ||
        owned.session.state !== "in_turn" ||
        owned.session.activeTurnId !== params.turnId
      ) {
        fail("APPA issued alias is not active");
      }
      if (owned.alias.consumedAt) return owned.alias;
      const [consumed] = await tx
        .update(aliases)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(aliases.id, params.aliasId),
            sql`${aliases.consumedAt} is null`,
          ),
        )
        .returning();
      if (!consumed) fail("APPA issued alias consumption was lost");
      return consumed;
    });
  }
}

function key(purpose: "encryption" | "fingerprint" = "encryption") {
  const secret = config.llmProxy.appaHook?.sessionHmacSecret;
  if (!secret)
    fail("APPA wire storage requires a stable configured session secret");
  return deriveKeyFromSecret(secret, `archestra-appa-proxy-wire-${purpose}-v1`);
}

function activeFrameScope(scope: Scope) {
  return sql`exists (
    select 1 from ${appaProxySessionsTable}
    where ${appaProxySessionsTable.id} = ${frames.sessionId}
      and ${appaProxySessionsTable.ownerScopeHash} = ${scope.ownerScopeHash}
      and ${appaProxySessionsTable.state} = 'in_turn'
      and ${appaProxySessionsTable.activeTurnId} = ${frames.turnId}
      and ${appaProxySessionsTable.pendingRemoteEvent} is null
  )`;
}

function canonicalJson(value: unknown): string {
  const result = JSON.stringify(value, (_name, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((name) => [name, item[name]]),
      );
    }
    return item;
  });
  if (result === undefined) fail("APPA wire payload is not serializable");
  return result;
}

function nativeMcpCallArguments(payload: unknown): Map<string, string> {
  if (!isRecord(payload)) fail("APPA native response has no current calls");
  const currentCalls = Array.isArray(payload.committedCalls)
    ? payload.committedCalls
    : Array.isArray(payload.calls)
      ? payload.calls
      : undefined;
  if (!currentCalls) fail("APPA native response has no current calls");
  const calls = new Map<string, string>();
  for (const call of currentCalls) {
    if (!isRecord(call) || typeof call.id !== "string") {
      fail("APPA native response has invalid current calls");
    }
    const argumentsText =
      typeof call.emittedArguments === "string"
        ? call.emittedArguments
        : typeof call.arguments === "string"
          ? call.arguments
          : undefined;
    if (argumentsText === undefined || calls.has(call.id)) {
      fail("APPA native response has invalid current calls");
    }
    calls.set(call.id, argumentsText);
  }
  return calls;
}

function isNativeMcpBinding(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.purpose === "native_call" &&
    typeof value.principalUserId === "string" &&
    typeof value.threadId === "string" &&
    typeof value.itemId === "string" &&
    typeof value.toolName === "string" &&
    typeof value.argumentsCanonical === "string" &&
    (value.executionArgumentsCanonical === undefined ||
      typeof value.executionArgumentsCanonical === "string")
  );
}

function parseNativeMcpRunToolWrapper(params: {
  argumentsText: string;
  metadata: Record<string, unknown>;
  callId: string;
}): {
  targetArgumentsCanonical: string;
  executionArgumentsCanonical: string;
} {
  // Frames issued before the native run_tool contract carried direct target
  // arguments. They remain sealed and can finish safely, but no new issuance
  // takes this compatibility branch.
  if (params.metadata.executionArgumentsCanonical === undefined) {
    return {
      targetArgumentsCanonical: canonicalLegacyNativeMcpArguments(
        params.argumentsText,
      ),
      executionArgumentsCanonical: canonicalLegacyNativeMcpArguments(
        params.argumentsText,
      ),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.argumentsText);
  } catch {
    fail("APPA native MCP wrapper arguments are invalid");
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["tool_name", "tool_args", "wire_context"]) ||
    parsed.tool_name !== params.metadata.toolName ||
    !isRecord(parsed.tool_args) ||
    !isRecord(parsed.wire_context) ||
    parsed.wire_context.call_id !== params.callId ||
    parsed.wire_context.thread_id !== params.metadata.threadId ||
    parsed.wire_context.item_id !== params.metadata.itemId
  ) {
    fail("APPA native MCP wrapper binding changed");
  }
  return {
    targetArgumentsCanonical: canonicalJson(parsed.tool_args),
    executionArgumentsCanonical: canonicalJson(parsed),
  };
}

function canonicalLegacyNativeMcpArguments(value: string): string {
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) throw new Error("not an object");
    return canonicalJson(parsed);
  } catch {
    fail("APPA native MCP call arguments are invalid");
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isPendingCodexToolSearchBinding(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.purpose === "codex_tool_search" &&
    typeof value.providerCallId === "string" &&
    typeof value.providerItemId === "string" &&
    typeof value.itemId === "string" &&
    typeof value.argumentsCanonical === "string" &&
    value.executionProfile === "client" &&
    (value.principalUserId === undefined ||
      typeof value.principalUserId === "string")
  );
}

function isCodexToolSearchBinding(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isPendingCodexToolSearchBinding(value) &&
    typeof value.profileId === "string"
  );
}

function finalizeCodexToolSearchBinding(params: {
  metadata: Record<string, unknown>;
  payload: unknown;
  callId: string;
  profileId: string;
}): Record<string, unknown> {
  const response = isRecord(params.payload)
    ? params.payload.response
    : undefined;
  const output =
    isRecord(response) && Array.isArray(response.output) ? response.output : [];
  const item = output.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.type === "tool_search_call" &&
      candidate.execution === "client" &&
      candidate.call_id === params.callId &&
      candidate.id === params.metadata.itemId,
  );
  if (
    !item ||
    canonicalToolSearchArguments(item.arguments) !==
      params.metadata.argumentsCanonical
  ) {
    fail("APPA Codex tool search binding has no current call");
  }
  return {
    ...params.metadata,
    profileId: params.profileId,
  };
}

function canonicalToolSearchArguments(value: unknown): string {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!isRecord(parsed)) throw new Error("not an object");
    return canonicalJson(parsed);
  } catch {
    fail("APPA Codex tool search arguments are invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function digest(value: string) {
  return createHmac("sha256", key("fingerprint")).update(value).digest("hex");
}

function seal(value: string, aad: string) {
  return encryptStringWithKey(value, key(), aad);
}

function unseal(value: string, aad: string): unknown {
  return JSON.parse(decryptStringWithKey(value, key(), aad));
}

function fail(message: string): never {
  throw new AppaProxySessionProtocolError(message);
}
