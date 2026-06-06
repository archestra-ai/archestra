/**
 * Parser for pasted MCP server JSON configuration (issue #3859).
 *
 * Most MCP server catalogs (the official MCP registry, Claude Desktop, Cursor,
 * VS Code, etc.) hand out install snippets as JSON rather than as one-argument-
 * per-line text. Re-typing those into the catalog form is tedious and error
 * prone. This module recognises the common JSON shapes and extracts the pieces
 * the form needs so a single paste can populate Command / Arguments / Env /
 * Transport / URL at once.
 *
 * Supported shapes (the wrapper key and the single-server object are both
 * accepted):
 *
 *   { "mcpServers": { "everything": { "command": "npx", "args": [...] } } }
 *   { "servers":    { "everything": { "command": "npx", "args": [...] } } }
 *   { "command": "npx", "args": ["-y", "pkg"], "env": { "API_KEY": "<token>" } }
 *   { "url": "https://example.com/mcp", "type": "http" }
 *
 * It is intentionally conservative: anything that is not valid JSON, or is valid
 * JSON but not a recognisable MCP server config (e.g. a bare arguments array),
 * returns `null` so the caller can fall back to the existing line-by-line paste
 * behaviour.
 */

export interface ParsedMcpEnvVar {
  key: string;
  value: string;
  /**
   * True when the value looks like a placeholder the user is expected to fill in
   * (e.g. `<token>`, `YOUR_API_KEY_HERE`, `${ENV}`, or empty). Callers can use
   * this to mark the field as a prompt-on-install secret instead of a literal.
   */
  isPlaceholder: boolean;
}

export interface ParsedMcpServerConfig {
  command?: string;
  arguments?: string[];
  environment?: ParsedMcpEnvVar[];
  transportType?: "stdio" | "streamable-http";
  serverUrl?: string;
  serverType?: "local" | "remote";
}

// Defense-in-depth limits: a real MCP config is tiny, so anything far larger is
// rejected rather than parsed/iterated (avoids pathological pastes).
const MAX_INPUT_LENGTH = 64_000;
const MAX_ARGS = 100;
const MAX_ARG_LENGTH = 2_000;
const MAX_ENV_VARS = 100;
const MAX_ENV_KEY_LENGTH = 256;
const MAX_ENV_VALUE_LENGTH = 4_000;

// Keys that must never be carried out of untrusted JSON into config/env data.
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const PLACEHOLDER_PATTERNS = [
  /<[^>]+>/, // <token>, <YOUR_KEY>
  /\$\{[^}]+\}/, // ${ENV_VAR}
  /^\$[A-Z0-9_]+$/, // $ENV_VAR
  /YOUR[_-].*[_-]?HERE/i, // YOUR_API_KEY_HERE
  /YOUR[_-][A-Z0-9_-]+/i, // YOUR_TOKEN
  /^(xxx+|\.\.\.|todo|changeme|placeholder)$/i,
];

function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Accept a URL only if it is a well-formed http(s) URL; reject javascript:, data:, etc. */
function asHttpUrl(value: unknown): string | undefined {
  const s = asString(value);
  if (!s) return undefined;
  try {
    const url = new URL(s);
    return url.protocol === "http:" || url.protocol === "https:"
      ? s
      : undefined;
  } catch {
    return undefined;
  }
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((v) => typeof v === "string" || typeof v === "number")
    .map((v) => String(v))
    .filter((s) => s.length <= MAX_ARG_LENGTH)
    .slice(0, MAX_ARGS);
  return out.length > 0 ? out : undefined;
}

function parseEnv(value: unknown): ParsedMcpEnvVar[] | undefined {
  if (!isPlainObject(value)) return undefined;
  const entries: ParsedMcpEnvVar[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (entries.length >= MAX_ENV_VARS) break;
    // Skip empty, oversized, or prototype-polluting keys.
    if (
      key.trim().length === 0 ||
      key.length > MAX_ENV_KEY_LENGTH ||
      DANGEROUS_KEYS.has(key)
    ) {
      continue;
    }
    // Only accept scalar values; objects/arrays would stringify to junk
    // (e.g. "[object Object]") and are not valid env values.
    if (
      raw !== null &&
      typeof raw !== "string" &&
      typeof raw !== "number" &&
      typeof raw !== "boolean"
    ) {
      continue;
    }
    const strValue = (raw === null ? "" : String(raw)).slice(
      0,
      MAX_ENV_VALUE_LENGTH,
    );
    entries.push({
      key,
      value: strValue,
      isPlaceholder: isPlaceholderValue(strValue),
    });
  }
  return entries.length > 0 ? entries : undefined;
}

/**
 * Pull a single server config object out of whatever wrapper shape was pasted.
 * Returns null when the input is not a recognisable single MCP server config.
 */
function extractServerObject(parsed: unknown): Record<string, unknown> | null {
  if (!isPlainObject(parsed)) return null;

  // Wrapper shapes: { mcpServers: { name: {...} } } or { servers: { name: {...} } }
  for (const wrapperKey of ["mcpServers", "servers"]) {
    const wrapper = parsed[wrapperKey];
    if (isPlainObject(wrapper)) {
      const firstServer = Object.values(wrapper).find(isPlainObject);
      if (firstServer) return firstServer;
      return null;
    }
  }

  // Bare single-server object: must carry at least one recognised config key.
  const hasServerKey = [
    "command",
    "args",
    "url",
    "serverUrl",
    "type",
    "env",
  ].some((k) => k in parsed);
  return hasServerKey ? parsed : null;
}

/**
 * Parse a pasted string as an MCP server JSON config. Returns null if the input
 * is not valid JSON or is not a recognisable MCP server configuration, so the
 * caller can fall back to its existing (line-by-line) handling.
 */
export function parseMcpServerConfigJson(
  input: string,
): ParsedMcpServerConfig | null {
  // Reject absurdly large pastes before any parsing/iteration.
  if (input.length > MAX_INPUT_LENGTH) return null;
  const trimmed = input.trim();
  // Cheap pre-check: a JSON config object starts with "{". A bare arguments
  // array ("[...]") is deliberately NOT treated as a config here.
  if (!trimmed.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const server = extractServerObject(parsed);
  if (!server) return null;

  const command = asString(server.command);
  const args = asStringArray(server.args ?? server.arguments);
  const environment = parseEnv(server.env ?? server.environment);
  const serverUrl = asHttpUrl(server.url ?? server.serverUrl);
  const rawType = asString(server.type)?.toLowerCase();

  // Decide local vs remote. A URL (and no command) means a remote server.
  const isRemote =
    Boolean(serverUrl) &&
    !command &&
    (rawType === undefined ||
      rawType === "http" ||
      rawType === "streamable-http" ||
      rawType === "sse" ||
      rawType === "remote");

  const result: ParsedMcpServerConfig = {};
  if (command) result.command = command;
  if (args) result.arguments = args;
  if (environment) result.environment = environment;
  if (serverUrl) result.serverUrl = serverUrl;

  if (isRemote) {
    result.serverType = "remote";
  } else if (command || args || environment) {
    result.serverType = "local";
    // http/streamable-http/sse → streamable-http; otherwise stdio.
    result.transportType =
      rawType === "http" || rawType === "streamable-http" || rawType === "sse"
        ? "streamable-http"
        : "stdio";
  }

  // Nothing useful extracted → not a config we can apply.
  if (
    result.command === undefined &&
    result.arguments === undefined &&
    result.environment === undefined &&
    result.serverUrl === undefined
  ) {
    return null;
  }

  return result;
}
