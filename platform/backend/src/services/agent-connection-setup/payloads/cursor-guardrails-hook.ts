/**
 * Cursor runs this Node script for each hook step in `~/.cursor/hooks.json`.
 * It forwards the step's JSON from stdin to Archestra with the connection's
 * hook credential and prints Archestra's answer for Cursor.
 *
 * A tool call that Archestra could not check is denied: `preToolUse` answers
 * `deny` itself when the request fails, and its hooks.json entry fails closed
 * when the script cannot run. Every other step answers `{}` on failure, so an
 * unreachable Archestra never blocks a prompt or a finished call.
 *
 * One chat is let through when Archestra cannot answer: the chat that is
 * disconnecting Cursor. Archestra names it by answering its steps with a
 * header that says when its exemption ends (see the disconnect reference in
 * services/connection-disconnect-reference.ts). The hook keeps that time
 * beside itself, so the cleanup can finish when Archestra becomes
 * unreachable or the connection is revoked part-way. The record only counts
 * when Archestra gave no answer, and never for longer than a reference lives.
 *
 * A Cursor CLI process that one of the web tools started carries the id of
 * the call that started it in its environment. The hook reports with that
 * id, so Archestra checks the process's steps as a subagent's of that chat.
 */
import { CONNECTION_SETUP_WINDOW_MS } from "@archestra/shared/connection-setup";
import {
  CURSOR_WEB_CALL_ENV,
  CURSOR_WEB_CALL_HEADER,
} from "./cursor-web-tools";

export const CURSOR_GUARDRAILS_HOOK_FILENAME = "guardrails-hook.mjs";
export const CURSOR_GUARDRAILS_HOOK_CONFIG_FILENAME = "guardrails.json";

/** Response header on a step of the chat that is disconnecting Cursor: when its exemption ends. */
export const CURSOR_DISCONNECT_UNTIL_HEADER = "x-archestra-disconnect-until";
/** The file beside the hook that holds those times, by chat. */
const CURSOR_DISCONNECT_CHATS_FILENAME = "disconnecting.json";

/** Hook steps that decide whether a call runs. */
export const CURSOR_GUARDRAILS_ENFORCING_STEPS = ["preToolUse"] as const;

/** Every step the hook reports, in the order Cursor fires them. */
export const CURSOR_GUARDRAILS_HOOK_STEPS = [
  "sessionStart",
  "beforeSubmitPrompt",
  "subagentStart",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStop",
  "afterAgentResponse",
  "stop",
] as const;

/** Upper bound for one step's round trip; a human review waits longer. */
export const CURSOR_GUARDRAILS_HOOK_TIMEOUT_SECONDS = 30;

export const CURSOR_GUARDRAILS_HOOK = `// Guardrails hook for Cursor. Setup writes this file; run setup again to update it.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const disconnectChats = join(here, ${JSON.stringify(CURSOR_DISCONNECT_CHATS_FILENAME)});
// A reference lives this long, so no exemption can be further off.
const disconnectWindowMs = ${CONNECTION_SETUP_WINDOW_MS + 1000};
const step = process.argv[2] ?? "";
const enforcing = ${JSON.stringify(CURSOR_GUARDRAILS_ENFORCING_STEPS)}.includes(step);
const maxOutputChars = 262144;

function answer(value) {
  process.stdout.write(JSON.stringify(value));
}

// The deployment's name, from the hook's settings: a deployment can carry its own.
let product = "";
const server = () => product || "The Guardrails server";
const setup = () => "run the " + (product ? product + " " : "") + "setup for Cursor again";

function unchecked(reason) {
  if (!enforcing) return answer({});
  // Cursor gives the model only user_message of a denied call.
  const message =
    (product ? product + " " : "") +
    "Guardrails could not check this tool call, so it did not run: " +
    reason +
    ". Tell the user, and do not retry the call until they say Guardrails are reachable again.";
  answer({ permission: "deny", user_message: message, agent_message: message });
}

// The chats the server said are disconnecting Cursor, and until when.
function liveDisconnectChats() {
  let chats;
  try {
    chats = JSON.parse(readFileSync(disconnectChats, "utf8"));
  } catch {
    return {};
  }
  const live = {};
  const now = Date.now();
  for (const [chat, until] of Object.entries(chats && typeof chats === "object" ? chats : {})) {
    if (typeof until === "number" && until > now && until - now <= disconnectWindowMs) live[chat] = until;
  }
  return live;
}

function rememberDisconnect(event, header) {
  const chat = event?.conversation_id;
  const until = Number(header);
  if (typeof chat !== "string" || !chat || !Number.isFinite(until)) return;
  try {
    const live = liveDisconnectChats();
    if (live[chat] === until) return;
    writeFileSync(disconnectChats + ".next", JSON.stringify({ ...live, [chat]: until }) + "\\n", { mode: 0o600 });
    renameSync(disconnectChats + ".next", disconnectChats);
  } catch {}
}

function disconnecting(event) {
  const chat = event?.conversation_id;
  return typeof chat === "string" && chat !== "" && liveDisconnectChats()[chat] !== undefined;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function main() {
  let config;
  try {
    config = JSON.parse(
      readFileSync(join(here, ${JSON.stringify(CURSOR_GUARDRAILS_HOOK_CONFIG_FILENAME)}), "utf8"),
    );
  } catch {
    return unchecked("its settings are missing; " + setup());
  }
  if (typeof config?.appName === "string") product = config.appName.replace(/\\s+/g, " ").trim().slice(0, 80);
  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch {
    return unchecked("Cursor sent an unreadable hook event");
  }
  if (typeof event?.tool_output === "string" && event.tool_output.length > maxOutputChars) {
    event.tool_output = event.tool_output.slice(0, maxOutputChars);
    event.tool_output_truncated = true;
  }
  const parentCall = process.env[${JSON.stringify(CURSOR_WEB_CALL_ENV)}] || undefined;
  // No answer from the server: the chat that disconnects Cursor goes on.
  const noAnswer = (reason) => (!parentCall && disconnecting(event) ? answer({}) : unchecked(reason));
  let response;
  try {
    response = await fetch(config.url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + config.token,
        "content-type": "application/json",
        ...(parentCall ? { ${JSON.stringify(CURSOR_WEB_CALL_HEADER)}: parentCall } : {}),
      },
      body: JSON.stringify({ step, event }),
      signal: AbortSignal.timeout(${(CURSOR_GUARDRAILS_HOOK_TIMEOUT_SECONDS - 2) * 1000}),
    });
  } catch (error) {
    return noAnswer(server() + " is unreachable (" + (error?.name === "TimeoutError" ? "timed out" : "connection failed") + ")");
  }
  if (response.status === 401 || response.status === 403) {
    return noAnswer("this Cursor connection is no longer valid; " + setup());
  }
  if (!response.ok) return noAnswer(server() + " answered HTTP " + response.status);
  let result;
  try {
    result = await response.json();
  } catch {
    return noAnswer(server() + " sent an unreadable answer");
  }
  const until = response.headers.get(${JSON.stringify(CURSOR_DISCONNECT_UNTIL_HEADER)});
  if (until) rememberDisconnect(event, until);
  answer(result && typeof result === "object" && !Array.isArray(result) ? result : {});
}

main().catch(() => unchecked("the hook failed"));
`;
