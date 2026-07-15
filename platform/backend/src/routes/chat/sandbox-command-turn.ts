import {
  ApiError,
  ChatErrorCode,
  type ChatErrorResponse,
  ChatMessageMetadataSchema,
  parseSandboxCommand,
  TOOL_RUN_COMMAND_SHORT_NAME,
} from "@archestra/shared";
import { createUIMessageStream, generateId, type UIMessage } from "ai";
import type { FastifyReply } from "fastify";
import {
  archestraMcpBranding,
  executeArchestraTool,
} from "@/archestra-mcp-server";
import { buildArchestraToolOutput } from "@/clients/chat-tool-builder";
import logger from "@/logging";
import { ActiveChatRunModel } from "@/models";
import { isSkillSandboxAvailableForAgent } from "@/skills/skill-sandbox-availability";
import type { ChatMessage } from "@/types";
import { sendGatedUiMessageStreamResponse } from "./ui-stream-response";

/**
 * A `!`-prefixed composer message the user asked to run directly in the
 * conversation's sandbox (Claude Code's `!` convention). Detected only when
 * the composer attached the `sandboxCommand` metadata marker AND the text
 * still parses as a command — the marker alone never executes anything, and
 * the command is always re-derived from the visible message text.
 */
export function detectSandboxCommand(
  messages: ChatMessage[],
): { command: string } | null {
  const last = messages.at(-1);
  if (!last || last.role !== "user") {
    return null;
  }
  const metadata = ChatMessageMetadataSchema.safeParse(last.metadata);
  if (!metadata.success || metadata.data.sandboxCommand !== true) {
    return null;
  }
  // Exactly one text part — the only shape the composer produces (file parts
  // may accompany it). A multi-text-part message with the marker came from a
  // non-composer client; treat it as a normal message rather than guessing
  // how to join the parts into a command.
  const textParts = (last.parts ?? []).filter((part) => part.type === "text");
  if (textParts.length !== 1) {
    return null;
  }
  return parseSandboxCommand(textParts[0].text ?? "");
}

/**
 * Run a `!`-prefixed user message as a `run_command` execution instead of an
 * LLM turn. The result streams to the client and persists as the same
 * `tool-<run_command>` part a model-initiated call produces, so the transcript
 * renders it with the normal tool UI and later LLM turns see the command and
 * its output in history.
 *
 * Fail-closed: the composer only attaches the marker when the agent's sandbox
 * is available, but availability is re-checked here — a forged or stale marker
 * gets an error, never a silent fallback to the LLM.
 *
 * Deliberately skipped relative to a model turn: Pre/PostToolUse hooks (the
 * user, not the model, initiated this call) and the LLM-facing context build.
 * SessionStart hooks still fire at the route level on a first turn — the
 * session genuinely starts — and their runs are spliced into the persisted
 * turn by the caller. The active-run lifecycle, stop semantics, stream replay,
 * and persistence shape all match a normal turn.
 */
export async function runSandboxCommandTurn(params: {
  command: string;
  messages: ChatMessage[];
  conversationId: string;
  agent: { id: string; name: string };
  userId: string;
  organizationId: string;
  activeRunId: string;
  abortController: AbortController;
  reply: FastifyReply;
  /** Persist the finished turn (regenerate-aware; owned by the route). */
  persistTurn: (finalMessages: ChatMessage[]) => Promise<void>;
  /** Detach stop-polling and abort listeners once the stream settles. */
  onStreamSettled: () => void;
  /**
   * Serialize a stream error through the route's chat-error pipeline
   * (persistence, trace correlation, slim-mode sanitization).
   */
  buildErrorPayload: (params: {
    error: unknown;
    mappedError: ChatErrorResponse;
  }) => string;
}): Promise<FastifyReply> {
  const {
    command,
    messages,
    conversationId,
    agent,
    userId,
    organizationId,
    activeRunId,
    abortController,
    reply,
    persistTurn,
    onStreamSettled,
    buildErrorPayload,
  } = params;

  const available = await isSkillSandboxAvailableForAgent({
    userId,
    organizationId,
    agentId: agent.id,
  });
  if (!available) {
    throw new ApiError(
      403,
      "Sandbox commands are not available for this agent. The sandbox feature, your sandbox permission, or the agent's sandbox tools may have been disabled.",
    );
  }

  const toolName = archestraMcpBranding.getToolName(
    TOOL_RUN_COMMAND_SHORT_NAME,
  );

  let activeRunError: string | null = null;

  const stream = createUIMessageStream({
    originalMessages: messages as unknown as UIMessage[],
    execute: async ({ writer }) => {
      const toolCallId = generateId();
      writer.write({ type: "start" });
      writer.write({ type: "start-step" });
      writer.write({
        type: "tool-input-available",
        toolCallId,
        toolName,
        input: { command },
      });

      // Stop requested before execution began: end the turn without running.
      // Once execution starts it runs to completion (the Dagger exec is not
      // abortable mid-flight — parity with a model-initiated run_command) and
      // its output IS persisted even if a stop lands meanwhile: the command
      // was appended to the sandbox replay log, so dropping the visible part
      // would desync the transcript from the sandbox's real state.
      if (abortController.signal.aborted) {
        writer.write({
          type: "tool-output-error",
          toolCallId,
          errorText: "Stopped before the command ran.",
        });
        writer.write({ type: "finish-step" });
        writer.write({ type: "finish" });
        return;
      }

      // Heartbeat while the command runs (container materialization + replay
      // + the command itself can take minutes) so proxies with idle timeouts
      // don't cut the SSE — same cadence as the LLM path's tool executions.
      const heartbeatInterval = setInterval(() => {
        try {
          writer.write({
            type: "data-heartbeat",
            data: { timestamp: Date.now() },
            transient: true,
          });
        } catch {
          clearInterval(heartbeatInterval);
        }
      }, 5000);

      let response: Awaited<ReturnType<typeof executeArchestraTool>>;
      let output: Awaited<ReturnType<typeof buildArchestraToolOutput>>;
      try {
        // RBAC and assignment are enforced inside executeArchestraTool; errors
        // (denials, validation, sandbox runtime failures) come back as isError
        // results whose text the same output shaping turns into tool output —
        // exactly what a model-initiated call would persist.
        response = await executeArchestraTool(
          toolName,
          { command },
          {
            agent,
            conversationId,
            isolationKey: conversationId,
            userId,
            agentId: agent.id,
            organizationId,
            abortSignal: abortController.signal,
          },
        );
        output = await buildArchestraToolOutput({
          response,
          toolName,
          toolArguments: { command },
          agentId: agent.id,
          userId,
          organizationId,
        });
      } finally {
        clearInterval(heartbeatInterval);
      }

      logger.info(
        { conversationId, command, isError: response.isError ?? false },
        "[Chat] Executed user-initiated sandbox command",
      );

      writer.write({
        type: "tool-output-available",
        toolCallId,
        output,
      });
      writer.write({ type: "finish-step" });
      writer.write({ type: "finish" });
    },
    onError: (error) => {
      activeRunError = error instanceof Error ? error.message : String(error);
      logger.error(
        { error, conversationId, command },
        "[Chat] Sandbox command turn failed",
      );
      return buildErrorPayload({
        error,
        mappedError: {
          code: ChatErrorCode.Unknown,
          message: `Sandbox command failed: ${activeRunError}`,
          isRetryable: true,
        },
      });
    },
    onFinish: async ({ messages: finalMessages }) => {
      onStreamSettled();
      try {
        await persistTurn(finalMessages as unknown as ChatMessage[]);
      } catch (error) {
        // The command already ran and sits in the sandbox replay log; fail the
        // run so the desync from the visible transcript is at least surfaced
        // (the user message itself was persisted before execution).
        activeRunError = `Failed to persist the command result: ${
          error instanceof Error ? error.message : String(error)
        }`;
        logger.error(
          { error, conversationId },
          "Failed to persist sandbox command turn",
        );
      }
    },
  });

  return sendGatedUiMessageStreamResponse({
    reply,
    stream,
    runId: activeRunId,
    conversationId,
    abortController,
    getTerminalStatus: async () => {
      const latestRun = await ActiveChatRunModel.findById(activeRunId);
      if (latestRun?.stopRequestedAt) {
        return { status: "cancelled" };
      }
      if (activeRunError) {
        return { status: "failed", error: activeRunError };
      }
      if (abortController.signal.aborted) {
        return { status: "cancelled" };
      }
      return { status: "completed" };
    },
  });
}
