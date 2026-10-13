import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { OpenAppaSession } from "./service";

export const RUNTIME_TOOL_PROOF_ARGUMENT = "runtime_proof";

/** The proxy supplies the source trajectory; MCP headers may name its parent. */
export function signRuntimeToolProof(params: {
  session: OpenAppaSession;
  toolCallId: string;
  action: string;
  arguments: Record<string, unknown>;
  spawn: boolean;
  secret: string;
  now?: number;
}): string | undefined {
  if (!params.secret) return undefined;
  try {
    const now = params.now ?? Math.floor(Date.now() / 1000);
    const claims = ClaimsSchema.parse({
      v: 1,
      organization_id: params.session.organization_id,
      caller_id: params.session.caller_id ?? null,
      session_id: params.session.session_id,
      parent_id: params.session.parent_id ?? null,
      call_id: params.toolCallId,
      action: params.action,
      arguments_hash: argumentsHash(params.arguments),
      spawn: params.spawn,
      iat: now,
      exp: now + PROOF_TTL_SECONDS,
    });
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${payload}.${signature(payload, params.secret)}`;
  } catch {
    return undefined;
  }
}

export function verifyRuntimeToolProof(params: {
  proof: unknown;
  organizationId: string;
  callerId: string | undefined;
  action: string;
  arguments: Record<string, unknown>;
  secret: string;
  now?: number;
}): {
  session: OpenAppaSession;
  toolCallId: string;
  spawn: boolean;
} | null {
  if (
    !params.secret ||
    typeof params.proof !== "string" ||
    params.proof.length > 16_384
  ) {
    return null;
  }
  try {
    const parts = params.proof.split(".");
    if (parts.length !== 2) return null;
    const [payload, mac] = parts;
    const actual = Buffer.from(mac, "utf8");
    const expected = Buffer.from(signature(payload, params.secret), "utf8");
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      return null;
    }
    const claims = ClaimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    const now = params.now ?? Math.floor(Date.now() / 1000);
    if (
      claims.iat > now + 30 ||
      claims.exp <= now ||
      claims.exp !== claims.iat + PROOF_TTL_SECONDS ||
      claims.organization_id !== params.organizationId ||
      claims.caller_id !== (params.callerId ?? null) ||
      claims.action !== params.action ||
      claims.arguments_hash !== argumentsHash(params.arguments)
    ) {
      return null;
    }
    return {
      session: {
        organization_id: claims.organization_id,
        session_id: claims.session_id,
        ...(claims.caller_id ? { caller_id: claims.caller_id } : {}),
        ...(claims.parent_id ? { parent_id: claims.parent_id } : {}),
      },
      toolCallId: claims.call_id,
      spawn: claims.spawn,
    };
  } catch {
    return null;
  }
}

/** The provider sees the original arguments, never reusable host credentials. */
export function stripRuntimeToolProofs(request: unknown): void {
  const visited = new WeakSet<object>();
  function strip(value: unknown, depth: number): boolean {
    if (!value || typeof value !== "object" || visited.has(value)) return false;
    if (depth > 64) throw new Error("Runtime tool history is too deep");
    visited.add(value);
    const record = value as Record<string, unknown>;
    let changed = Object.hasOwn(record, RUNTIME_TOOL_PROOF_ARGUMENT);
    delete record[RUNTIME_TOOL_PROOF_ARGUMENT];
    for (const [key, nested] of Object.entries(record)) {
      if (
        (key === "arguments" || key === "tool_args") &&
        typeof nested === "string"
      ) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(nested);
        } catch {
          // Custom tools may carry non-JSON arguments; preserve them verbatim.
          continue;
        }
        if (strip(parsed, depth + 1)) {
          record[key] = JSON.stringify(parsed);
          changed = true;
        }
      } else {
        // Do not short-circuit: siblings may independently contain a proof.
        changed = strip(nested, depth + 1) || changed;
      }
    }
    return changed;
  }
  strip(request, 0);
}

const ClaimsSchema = z
  .object({
    v: z.literal(1),
    organization_id: z.string().min(1).max(512),
    caller_id: z.string().min(1).max(1024).nullable(),
    session_id: z.string().min(1).max(2048),
    parent_id: z.string().min(1).max(2048).nullable(),
    call_id: z.string().min(1).max(256),
    action: z.string().min(1).max(512),
    arguments_hash: z.string().regex(/^[a-f0-9]{64}$/),
    spawn: z.boolean(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
  })
  .strict();

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`archestra.appa.runtime-tool.v1.${payload}`)
    .digest("base64url");
}

function argumentsHash(args: Record<string, unknown>): string {
  const { [RUNTIME_TOOL_PROOF_ARGUMENT]: _proof, ...original } = args;
  return createHash("sha256")
    .update(canonicalJson(original, new WeakSet()))
    .digest("hex");
}

/** Hash complete JSON, not the bounded/truncated representation used for logs. */
function canonicalJson(
  value: unknown,
  visited: WeakSet<object>,
  depth = 0,
): string {
  if (depth > 64) throw new Error("Runtime tool arguments are too deep");
  if (value !== null && typeof value === "object") {
    if (visited.has(value))
      throw new Error("Runtime tool arguments must be a JSON tree");
    visited.add(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry, visited, depth + 1)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key], visited, depth + 1)}`,
      )
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new Error("Invalid runtime tool arguments");
  return serialized;
}

const PROOF_TTL_SECONDS = 5 * 60;
