/**
 * EXPERIMENTAL — opt-in, dev-only, not production-ready.
 *
 * Native shell remedy channel (ARCHESTRA_OPENAPPA_OPENCODE_SHELL_REMEDY).
 *
 * When OpenAPPA denies a local tool call in OpenCode, Claude Code, or Codex
 * without an MCP gateway, the proxy cannot deliver the ruling
 * through the gateway's get_remedy_plans notice tool. Under the experiment
 * flag the proxy instead rewrites the denied call — same call ID — into a
 * native shell call with a fixed proxy-generated script that prints the bound
 * ruling (the notice payload, including signed offers).
 *
 * The printed payload is byte-signed: the tag covers the session binding, the
 * call ID, a nonce, and the exact ruling bytes. On the next request the proxy
 * restores a successful shell call in history to the original denied call
 * and supplies the verified ruling. Client failures remain visible and do
 * not grant authority. A forged or tampered script fails verification and
 * stays an ordinary shell
 * call, ruled on like any other.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The session binding a shell remedy ruling is signed against. */
type ShellRemedySession = {
  organization_id: string;
  session_id: string;
  caller_id?: string;
  parent_id?: string;
};

/** OpenCode and Claude Code's shell tool, after local-name normalization. */
export const SHELL_REMEDY_TOOL_NAME = "bash";

const SHELL_REMEDY_VERSION = 1;
const TAG_DOMAIN = "archestra.opencode-shell-remedy.v1";
const DELIMITER_PREFIX = "APPA_SHELL_REMEDY_";

type ShellRemedyCommand = {
  /** The full bash command the client runs. */
  command: string;
  /** The nonce inside the payload, for the single-use cached claim. */
  nonce: string;
};

/**
 * Builds the proxy-generated script that prints the bound ruling.
 * Returns undefined when the payload cannot be embedded safely; the caller
 * then falls back to refusing the turn.
 */
export function buildShellRemedyCommand(params: {
  session: ShellRemedySession;
  callId: string;
  /** The notice arguments, as buildNoticeArguments produced them. */
  notice: unknown;
  secret: string;
}): ShellRemedyCommand | undefined {
  if (params.secret.length === 0) return undefined;
  const noticeLine = JSON.stringify(params.notice);
  // The ruling is attacker-influenced text; it must never close its own
  // heredoc. A nonce colliding with the payload is astronomically unlikely,
  // but a payload containing the delimiter is detected, not shipped.
  for (let attempt = 0; attempt < 3; attempt++) {
    const nonce = randomBytes(12).toString("base64url");
    const delimiter = `${DELIMITER_PREFIX}${nonce}`;
    if (noticeLine.includes(delimiter)) continue;
    const envelope = JSON.stringify({
      appa_shell_remedy: SHELL_REMEDY_VERSION,
      call_id: params.callId,
      nonce,
      tag: shellRemedyTag({
        session: params.session,
        callId: params.callId,
        nonce,
        noticeLine,
        secret: params.secret,
      }),
    });
    return {
      command: `cat <<'${delimiter}'\n${noticeLine}\n${envelope}\n${delimiter}\n`,
      nonce,
    };
  }
  return undefined;
}

/**
 * Reads a verified shell remedy payload from a bash call's arguments.
 * Returns the notice bytes (parsed JSON) only when the command is exactly the
 * proxy-issued script and its tag verifies against this session and call ID.
 */
export function readShellRemedyCommand(params: {
  session: ShellRemedySession;
  callId: string;
  /** The shell call's arguments: an object or its JSON string. */
  arguments: unknown;
  secret: string;
  /**
   * Argument that carries the script. OpenCode and Claude use `command`.
   * Codex `exec_command` uses `cmd`. The default stays `command` so an
   * OpenCode call that only sets `cmd` is not a remedy.
   */
  argument?: "command" | "cmd";
}): unknown | undefined {
  if (params.secret.length === 0) return undefined;
  const record = argumentRecord(params.arguments);
  const command = record?.[params.argument ?? "command"];
  if (typeof command !== "string") return undefined;
  // Strict shape: exactly the issued script, one trailing newline tolerated.
  const lines = command.replace(/\n$/, "").split("\n");
  if (lines.length !== 4) return undefined;
  const open = new RegExp(`^cat <<'(${DELIMITER_PREFIX}[A-Za-z0-9_-]+)'$`).exec(
    lines[0],
  );
  if (!open || lines[3] !== open[1]) return undefined;
  const [_, noticeLine, envelopeLine] = lines;
  const envelope = parseJson(envelopeLine);
  if (!isRecord(envelope)) return undefined;
  if (
    envelope.appa_shell_remedy !== SHELL_REMEDY_VERSION ||
    envelope.call_id !== params.callId ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.tag !== "string"
  ) {
    return undefined;
  }
  const expected = shellRemedyTag({
    session: params.session,
    callId: params.callId,
    nonce: envelope.nonce,
    noticeLine,
    secret: params.secret,
  });
  const actual = Buffer.from(envelope.tag, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
    return undefined;
  }
  return parseJson(noticeLine);
}

// === Internal helpers ===

/** The tag binds the session, the call, the nonce, and the ruling bytes. */
function shellRemedyTag(params: {
  session: ShellRemedySession;
  callId: string;
  nonce: string;
  /** The exact payload line as it will be printed and carried in history. */
  noticeLine: string;
  secret: string;
}): string {
  return createHmac("sha256", params.secret)
    .update(`${TAG_DOMAIN}\0`)
    .update(
      JSON.stringify([
        params.session.organization_id,
        params.session.caller_id ?? "",
        params.session.session_id,
        params.session.parent_id ?? "",
        params.callId,
        params.nonce,
      ]),
    )
    .update("\0")
    .update(params.noticeLine)
    .digest("base64url");
}

function argumentRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    const parsed = parseJson(value);
    return isRecord(parsed) ? parsed : undefined;
  }
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
