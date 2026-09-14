import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import config from "@/config";
import type { OpenAppaSession } from "./service";

export const APPA_CHAT_BLOCK_HEADER = "x-archestra-appa-chat-blocks";
export const APPA_CHAT_BLOCK_VERSION = "v1";

const PREFIX = "[archestra-appa-block:";
const Block = z.object({
  session: z.object({
    organization_id: z.string(),
    caller_id: z.string(),
    session_id: z.string(),
  }),
  requestId: z.string().uuid(),
  feedback: z.string(),
  calls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1),
});

/** A signed receipt means these attempts were withheld, never executed. */
export function encodeChatBlock(params: {
  session: OpenAppaSession;
  requestId: string;
  feedback: string;
  calls: Array<{ id: string; name: string; arguments: string | object }>;
}): string {
  const block = Block.parse({
    ...params,
    calls: params.calls.map((call) => ({
      ...call,
      arguments:
        typeof call.arguments === "string"
          ? JSON.parse(call.arguments)
          : call.arguments,
    })),
  });
  const payload = Buffer.from(JSON.stringify(block)).toString("base64url");
  return `${PREFIX}${payload}.${sign(payload)}]`;
}

export function decodeChatBlock(text: string, session: OpenAppaSession) {
  const match = /\[archestra-appa-block:([\w-]+)\.([\w-]+)\]/.exec(text);
  if (!match) return null;
  const expected = Buffer.from(sign(match[1]));
  const received = Buffer.from(match[2]);
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  )
    return null;
  try {
    const block = Block.parse(
      JSON.parse(Buffer.from(match[1], "base64url").toString()),
    );
    if (
      block.session.organization_id !== session.organization_id ||
      block.session.caller_id !== session.caller_id ||
      block.session.session_id !== session.session_id
    )
      return null;
    return { ...block, receipt: match[0] };
  } catch {
    return null;
  }
}

/** Provider adapters carry MCP outputs as JSON strings or text blocks. */
export function isChatBlockResult(params: {
  content: unknown;
  toolCallId: string;
  session: OpenAppaSession;
}): boolean {
  const text =
    typeof params.content === "string"
      ? params.content
      : JSON.stringify(params.content);
  if (!text) return false;
  const block = decodeChatBlock(text, params.session);
  return !!block?.calls.some((call) => call.id === params.toolCallId);
}

function sign(payload: string): string {
  if (!config.auth.secret)
    throw new Error(
      "OpenAPPA Chat requires the configured auth signing secret",
    );
  return createHmac("sha256", config.auth.secret)
    .update("archestra:openappa:withheld-chat-call:v1:")
    .update(payload)
    .digest("base64url");
}
