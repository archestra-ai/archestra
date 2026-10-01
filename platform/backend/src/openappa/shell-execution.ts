/** Dev-only OpenAPPA execution channel carried by an external client's shell. */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RemedyExecutionSchema } from "./notice";
import { OfferJwsSchema } from "./offer-claims";

const TICKET_TTL_MS = 2 * 60_000;
const MAX_TICKET_LENGTH = 32_768;
export const SHELL_EXECUTION_PATH = "/v1/openai/openappa/execute-remedy";
export const SHELL_EXECUTION_TTL_MS = TICKET_TTL_MS;
export const SHELL_EXECUTION_HISTORY_TTL_MS = 7 * 24 * 60 * 60_000;

export function shellExecutionCacheKey(
  token: string,
): `openappa-shell-execution-${string}` {
  return `openappa-shell-execution-${createHash("sha256").update(token).digest("base64url")}`;
}

export function shellExecutionCallCacheKey(params: {
  organizationId: string;
  sessionId: string;
  callId: string;
}): `openappa-shell-execution-call-${string}` {
  const digest = createHash("sha256")
    .update(`${params.organizationId}\0${params.sessionId}\0${params.callId}`)
    .digest("base64url");
  return `openappa-shell-execution-call-${digest}`;
}
const TicketSchema = z.object({
  v: z.literal(1),
  organizationId: z.string().uuid(),
  callerId: z.string().min(1),
  sessionId: z.string().min(1),
  parentId: z.string().optional(),
  agentId: z.string().uuid(),
  callId: z.string().min(1),
  nonce: z.string().min(1),
  expiresAt: z.number().int(),
  arguments: z.record(z.string(), z.unknown()),
  execution: RemedyExecutionSchema,
  offer: OfferJwsSchema,
});

type ShellExecutionTicket = z.infer<typeof TicketSchema>;

/** Mint only from a stamped control call with an offer routed to this session. */
export function issueShellExecutionTicket(params: {
  session: Pick<
    ShellExecutionTicket,
    "organizationId" | "callerId" | "sessionId" | "parentId" | "agentId"
  >;
  callId: string;
  arguments: Record<string, unknown>;
  secret: string;
  now?: number;
}): { token: string; ticket: ShellExecutionTicket } | undefined {
  if (!params.secret || params.arguments.execution === undefined) return;
  const execution = RemedyExecutionSchema.safeParse(params.arguments.execution);
  const offer = OfferJwsSchema.safeParse(params.arguments);
  if (
    !execution.success ||
    !offer.success ||
    execution.data.call_id !== params.callId
  )
    return;
  const ticket = TicketSchema.parse({
    v: 1,
    ...params.session,
    callId: params.callId,
    nonce: randomBytes(18).toString("base64url"),
    expiresAt: (params.now ?? Date.now()) + TICKET_TTL_MS,
    arguments: params.arguments,
    execution: execution.data,
    offer: offer.data,
  });
  const payload = Buffer.from(JSON.stringify(ticket)).toString("base64url");
  const token = `${payload}.${tag("ticket", payload, params.secret)}`;
  return token.length <= MAX_TICKET_LENGTH ? { token, ticket } : undefined;
}

/** Verify the bearer ticket; the caller must also atomically consume its lease. */
export function verifyShellExecutionTicket(params: {
  token: string;
  secret: string;
  now?: number;
  checkExpiry?: boolean;
}): ShellExecutionTicket | undefined {
  if (!params.secret || params.token.length > MAX_TICKET_LENGTH) return;
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(params.token);
  if (!match || !matches(match[2], tag("ticket", match[1], params.secret)))
    return;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch {
    return;
  }
  const parsed = TicketSchema.safeParse(payload);
  if (!parsed.success) return;
  if (
    params.checkExpiry !== false &&
    parsed.data.expiresAt <= (params.now ?? Date.now())
  )
    return;
  if (parsed.data.execution.call_id !== parsed.data.callId) return;
  return parsed.data;
}

export function shellExecutionCommand(params: {
  token: string;
  endpoint: string;
}): string | undefined {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(params.token)) return;
  const url = new URL(params.endpoint);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return;
  return `curl --fail-with-body --silent --show-error --max-time 90 -H 'content-type: application/json' --data-binary '{"ticket":"${params.token}"}' '${url.toString()}'`;
}

export function ticketFromShellExecutionCommand(params: {
  command: string;
  endpoint: string;
  secret: string;
}): ShellExecutionTicket | undefined {
  const token =
    /--data-binary '\{"ticket":"([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"\}'/.exec(
      params.command,
    )?.[1];
  if (
    !token ||
    shellExecutionCommand({ token, endpoint: params.endpoint }) !==
      params.command
  )
    return;
  return verifyShellExecutionTicket({
    token,
    secret: params.secret,
    checkExpiry: false,
  });
}

type ShellExecutionResponse = {
  v: 1;
  callId: string;
  nonce: string;
  result: CallToolResult;
  tag: string;
};

export function signShellExecutionResponse(params: {
  ticket: ShellExecutionTicket;
  result: CallToolResult;
  secret: string;
}): ShellExecutionResponse {
  const value = {
    v: 1 as const,
    callId: params.ticket.callId,
    nonce: params.ticket.nonce,
    result: params.result,
  };
  return { ...value, tag: tag("result", JSON.stringify(value), params.secret) };
}

/**
 * Codex `exec_command` returns command stdout under a fixed text header, not
 * as the raw process output. Only that header is a native result. The stdout
 * after `Output:` is what a signed execution response must verify against.
 */
export function readCodexExecOutput(content: unknown):
  | {
      stdout: string;
      exitCode?: number;
      running: boolean;
    }
  | undefined {
  const text = codexOutputText(content);
  if (text === undefined) return undefined;
  const marker = "\nOutput:\n";
  const split = text.indexOf(marker);
  if (split < 0) return undefined;
  const header = text.slice(0, split);
  if (!/^Wall time: [0-9]+(?:\.[0-9]+)? seconds$/m.test(header))
    return undefined;
  const exit = /^Process exited with code (-?\d+)$/m.exec(header);
  return {
    stdout: text.slice(split + marker.length),
    ...(exit ? { exitCode: Number(exit[1]) } : {}),
    running: /^Process running with session ID \d+$/m.test(header),
  };
}

/**
 * A present Codex shell result that is not a completed exit-0 run. Missing
 * output is not a denial: an interrupted turn still owes the provider a result.
 */
export function codexExecClientDeclined(content: unknown): boolean {
  if (content === undefined || content === null) return false;
  const wrapped = readCodexExecOutput(content);
  if (!wrapped) return true;
  return wrapped.running || wrapped.exitCode !== 0;
}

export function verifyShellExecutionResponse(params: {
  ticket: ShellExecutionTicket;
  content: unknown;
  secret: string;
}): CallToolResult | undefined {
  let value: unknown = params.content;
  if (Array.isArray(value)) {
    if (
      value.length !== 1 ||
      value[0]?.type !== "text" ||
      typeof value[0]?.text !== "string"
    )
      return;
    value = value[0].text;
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return;
    }
  }
  const parsed = z
    .object({
      v: z.literal(1),
      callId: z.string(),
      nonce: z.string(),
      result: z.object({ content: z.array(z.unknown()) }).passthrough(),
      tag: z.string(),
    })
    .safeParse(value);
  if (
    !parsed.success ||
    parsed.data.callId !== params.ticket.callId ||
    parsed.data.nonce !== params.ticket.nonce
  )
    return;
  const { tag: signature, ...body } = value as Record<string, unknown>;
  if (typeof signature !== "string") return;
  if (!matches(signature, tag("result", JSON.stringify(body), params.secret)))
    return;
  return parsed.data.result as CallToolResult;
}

function codexOutputText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (
    Array.isArray(content) &&
    content.length === 1 &&
    content[0]?.type === "text" &&
    typeof content[0]?.text === "string"
  ) {
    return content[0].text;
  }
  return undefined;
}

function tag(purpose: string, payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`archestra-shell-execution-v1:${purpose}\0`)
    .update(payload)
    .digest("base64url");
}

function matches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
