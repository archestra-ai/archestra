/**
 * Parses raw pasted text into a normalised MCP server configuration that can
 * be used to pre-fill the catalog form.
 *
 * Supports the following formats found in the wild:
 *
 * 1. **Claude Desktop / Cursor** — `{ mcpServers: { name: { command, args, env } } }`
 * 2. **VS Code / inputs block** — `{ servers: { name: { type, url, headers } }, inputs: [...] }`
 * 3. **Bare single-server** — `{ command: "...", args: [...], env: {...} }`
 * 4. **Bare remote server** — `{ type: "http", url: "...", headers: {...} }`
 * 5. **Placeholder env values** — `<token>`, `YOUR_TOKEN_HERE`, `${ENV}` become
 *    `promptOnInstallation: true, type: "secret"` env vars.
 * 6. **JSON array of arguments** — `["--port", "8080"]` fills the Arguments
 *    textarea only.
 * 7. **Archestra registry format** — `{ server: { type, url }, user_config: {...}, archestra_config: {...} }`
 * 8. **MCP Registry server.json** — `{ packages: [...], server: { name, remotes: [...] } }`
 *
 * Any text that is not valid JSON or does not match a known shape returns
 * `null`, letting the caller fall back to the default paste behaviour.
 *
 * @param rawText - The raw text pasted into the textarea.
 * @returns A normalised partial form values object, or `null` if the input is
 * not a recognised MCP config.
 */

// ─── Types ──────────────────────────────────────────────────────────────

/** A single environment variable in the form's internal representation. */
export interface ParsedEnvVar {
  key: string;
  type: "plain_text" | "secret" | "boolean" | "number";
  value?: string;
  promptOnInstallation: boolean;
  required?: boolean;
  description?: string;
}

/** The normalised result of parsing an MCP server config. */
export interface ParsedMcpServerConfig {
  /** Server type: "local" for stdio/SSE processes, "remote" for HTTP URLs. */
  serverType?: "local" | "remote";
  /** For remote servers — the endpoint URL. */
  serverUrl?: string;
  /** For local servers — the executable command (e.g. "node", "npx", "docker"). */
  command?: string;
  /** For local servers — arguments as a newline-separated string (matches the form field). */
  arguments?: string;
  /** For local servers — environment variables. */
  environment?: ParsedEnvVar[];
  /** For local servers — Docker image if the command is "docker". */
  dockerImage?: string;
  /** For local servers — transport type. */
  transportType?: "stdio" | "streamable-http";
  /** For local servers — HTTP port (if detectable from args). */
  httpPort?: string;
  /** For local servers — HTTP path. */
  httpPath?: string;
  /** Additional headers for remote servers. */
  headers?: Array<{
    headerName: string;
    value?: string;
    promptOnInstallation: boolean;
    required: boolean;
    description?: string;
    sensitive?: boolean;
  }>;
}

// ─── Constants ──────────────────────────────────────────────────────────

/** Reject inputs larger than this to prevent DoS via giant JSON blobs. */
const MAX_INPUT_LENGTH = 50_000;

/** Maximum number of arguments accepted. */
const MAX_ARGS = 200;

/** Maximum number of environment variables accepted. */
const MAX_ENV_VARS = 100;

/** Env keys that must be dropped to prevent prototype pollution. */
const FORBIDDEN_ENV_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Patterns that indicate a placeholder value that should become a
 * `promptOnInstallation: true` secret field.
 */
const PLACEHOLDER_PATTERNS = [
  /^<[^>]+>$/, // <token>, <your-key>
  /^YOUR_[A-Z_]+$/, // YOUR_TOKEN, YOUR_API_KEY
  /^\$\{[^}]+\}$/, // ${ENV_VAR}, ${INPUT:github_pat}
  /^REDACTED$/i,
  /^changeme$/i,
  /^placeholder$/i,
  /^xxx+$/i,
];

/**
 * Docker run flags that consume the following argument as a value.
 * When scanning for the image name, these flag-value pairs must be skipped.
 */
const DOCKER_FLAGS_WITH_VALUE = new Set([
  "-e",
  "--env",
  "--env-file",
  "-v",
  "--volume",
  "-p",
  "--publish",
  "--name",
  "--network",
  "--user",
  "-u",
  "--workdir",
  "-w",
  "--entrypoint",
  "--label",
  "-l",
  "--pull",
  "--restart",
  "--health-cmd",
  "--health-interval",
  "--health-retries",
  "--health-start-period",
  "--health-timeout",
  "--shm-size",
  "--memory",
  "-m",
  "--cpus",
  "--cpu-shares",
  "--dns",
  "--dns-search",
  "--add-host",
  "--hostname",
  "--mount",
  "--device",
  "--gpus",
  "--security-opt",
  "--cap-add",
  "--cap-drop",
  "--ulimit",
  "--tmpfs",
  "--log-driver",
  "--log-level",
  "--pid",
  "--ipc",
  "--uts",
  "--cgroup-parent",
  "--platform",
]);

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Determines whether an env value is a placeholder that should be treated as
 * a secret prompt-on-installation field.
 */
function isPlaceholderValue(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

/**
 * Detects whether a string contains an `${input:...}` placeholder (even if
 * embedded in a larger string like `"Bearer ${input:token}"`).
 */
function containsInputPlaceholder(value: string): boolean {
  return /\$\{input:/.test(value);
}

/**
 * Extracts the input ID from an `${input:...}` placeholder. If the placeholder
 * is embedded in a larger string, returns the first match.
 */
function extractInputId(value: string): string | null {
  const match = value.match(/\$\{input:([^}]+)\}/);
  return match ? match[1] : null;
}

/**
 * Validates that a URL is http(s) only, rejecting javascript:, data:, etc.
 */
function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Sanitises an env key — drops forbidden keys that could cause prototype
 * pollution.
 */
function isSafeEnvKey(key: string): boolean {
  if (FORBIDDEN_ENV_KEYS.has(key)) return false;
  // Env keys should be valid shell variable names
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/**
 * Detects the transport type from a Docker args array (e.g. `["--transport", "stdio"]`).
 * Returns `"stdio"` or `"streamable-http"` (the default).
 */
function detectTransportType(args: string[]): {
  transportType: "stdio" | "streamable-http";
  httpPort?: string;
} {
  const transportIndex = args.indexOf("--transport");
  if (transportIndex !== -1 && args[transportIndex + 1] === "stdio") {
    return { transportType: "stdio" };
  }

  // Check for SSE transport (older MCP servers)
  const sseIndex = args.indexOf("--sse");
  if (sseIndex !== -1) {
    // SSE maps to streamable-http in our internal model
    return { transportType: "streamable-http" };
  }

  // Check for --port flag
  const portIndex = args.indexOf("--port");
  if (portIndex !== -1) {
    const port = args[portIndex + 1];
    if (port && /^\d+$/.test(port)) {
      return { transportType: "streamable-http", httpPort: port };
    }
  }

  return { transportType: "streamable-http" };
}

/**
 * Parses an env object (`{ KEY: "value" }`) into the form's environment
 * variable array format, detecting placeholder values.
 */
function parseEnvObject(env: Record<string, string>): ParsedEnvVar[] {
  const result: ParsedEnvVar[] = [];

  for (const [key, rawValue] of Object.entries(env)) {
    if (!isSafeEnvKey(key)) continue;

    const value =
      typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
    const isPlaceholder = isPlaceholderValue(value);

    result.push({
      key,
      type: isPlaceholder ? "secret" : "plain_text",
      value: isPlaceholder ? undefined : value,
      promptOnInstallation: isPlaceholder,
      required: isPlaceholder,
    });

    if (result.length >= MAX_ENV_VARS) break;
  }

  return result;
}

/**
 * Extracts a single server config object from various wrapper formats.
 * Returns the server config object and its name (if available).
 */
function extractServerObject(
  parsed: unknown,
): { server: Record<string, unknown>; name?: string } | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // Format 1: { mcpServers: { name: { ... } } } — Claude Desktop, Cursor
  if (
    "mcpServers" in obj &&
    obj.mcpServers &&
    typeof obj.mcpServers === "object"
  ) {
    const servers = obj.mcpServers as Record<string, unknown>;
    const entries = Object.entries(servers);
    if (entries.length === 0) return null;
    const [name, server] = entries[0];
    if (server && typeof server === "object" && !Array.isArray(server)) {
      return { server: server as Record<string, unknown>, name };
    }
    return null;
  }

  // Format 2: { servers: { name: { ... } } } — VS Code, with optional inputs block
  if ("servers" in obj && obj.servers && typeof obj.servers === "object") {
    const servers = obj.servers as Record<string, unknown>;
    const entries = Object.entries(servers);
    if (entries.length === 0) return null;
    const [name, server] = entries[0];
    if (server && typeof server === "object" && !Array.isArray(server)) {
      return { server: server as Record<string, unknown>, name };
    }
    return null;
  }

  // Format 3: Bare single-server object with command/args/env or type/url
  if (
    "command" in obj ||
    "args" in obj ||
    "env" in obj ||
    "url" in obj ||
    "type" in obj
  ) {
    return { server: obj };
  }

  // Format 4: Archestra registry format — { server: { type, url }, user_config: {...}, archestra_config: {...} }
  if (
    "archestra_config" in obj ||
    "user_config" in obj ||
    "oauth_config" in obj
  ) {
    if (
      "server" in obj &&
      typeof obj.server === "object" &&
      !Array.isArray(obj.server)
    ) {
      return { server: obj.server as Record<string, unknown> };
    }
    return null;
  }

  // Format 5: MCP Registry server.json — { packages: [...], server: { name, description, remotes: [...] } }
  if ("packages" in obj && Array.isArray(obj.packages)) {
    // Check for remotes (remote server) or packages (local server)
    if (
      "server" in obj &&
      typeof obj.server === "object" &&
      !Array.isArray(obj.server)
    ) {
      const serverObj = obj.server as Record<string, unknown>;
      // If server has remotes, use the first remote
      if (
        "remotes" in serverObj &&
        Array.isArray(serverObj.remotes) &&
        serverObj.remotes.length > 0
      ) {
        const firstRemote = (
          serverObj.remotes as Array<Record<string, unknown>>
        )[0];
        if (
          firstRemote &&
          typeof firstRemote === "object" &&
          "transport" in firstRemote
        ) {
          return { server: firstRemote };
        }
      }
    }
    // Otherwise use the first package
    const firstPkg = (obj.packages as Array<Record<string, unknown>>)[0];
    if (firstPkg && typeof firstPkg === "object") {
      return { server: firstPkg };
    }
    return null;
  }

  return null;
}

/**
 * Resolves `${input:...}` placeholder values against an inputs block.
 * Handles both pure `${input:...}` strings and embedded patterns like
 * `"Bearer ${input:token}"`.
 */
function resolveInputPlaceholder(
  value: string,
  inputs: Array<{ id: string; description?: string; password?: boolean }>,
): {
  value: string;
  isPlaceholder: boolean;
  description?: string;
  sensitive: boolean;
} {
  // Check for embedded ${input:...} pattern (e.g. "Bearer ${input:github_pat}")
  if (containsInputPlaceholder(value)) {
    const inputId = extractInputId(value);
    if (inputId) {
      const inputDef = inputs.find((i) => i.id === inputId);
      return {
        value: "",
        isPlaceholder: true,
        description: inputDef?.description,
        // Default to sensitive (true) unless explicitly set to false
        sensitive: inputDef?.password ?? false,
      };
    }
  }

  // Also handle ${ENV_VAR} style (non-input) — treat as placeholder
  if (/^\$\{[^}]+\}$/.test(value)) {
    return { value: "", isPlaceholder: true, sensitive: false };
  }

  const isPlaceholder = isPlaceholderValue(value);
  return { value, isPlaceholder, sensitive: isPlaceholder };
}

/**
 * Finds the Docker image in a `docker run` args array, skipping flag-value
 * pairs like `-e ENV_VAR` and `--volume /path`.
 */
function findDockerImageIndex(args: string[], startIndex: number): number {
  let i = startIndex;
  while (i < args.length) {
    const arg = args[i];

    // If this flag consumes the next argument, skip both
    if (DOCKER_FLAGS_WITH_VALUE.has(arg)) {
      i += 2;
      continue;
    }

    // Flags like --rm, -i, --init, --pull=always don't consume a value
    if (arg.startsWith("-")) {
      i++;
      continue;
    }

    // First non-flag argument (after skipping flag-value pairs) is the image
    return i;
  }

  return -1;
}

/**
 * Parses a local (stdio/SSE) server config object.
 */
function parseLocalServer(
  server: Record<string, unknown>,
): ParsedMcpServerConfig {
  const result: ParsedMcpServerConfig = {
    serverType: "local",
  };

  // Command can be at server.command (Claude/VS Code) or inferred from
  // server.runtimeHint + server.identifier (MCP Registry package format)
  let command = typeof server.command === "string" ? server.command.trim() : "";
  let rawArgs = server.args;

  // MCP Registry package format: runtimeHint (e.g. "npx") + identifier (e.g. "@scope/pkg")
  if (!command && typeof server.runtimeHint === "string") {
    command = server.runtimeHint.trim();
    const identifier =
      typeof server.identifier === "string" ? server.identifier.trim() : "";
    if (identifier && !rawArgs) {
      rawArgs = [identifier];
    }
  }

  const env = server.env;

  // Parse args — can be a JSON array or a string
  let argsArray: string[] = [];
  if (Array.isArray(rawArgs)) {
    argsArray = rawArgs
      .filter((a): a is string => typeof a === "string")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
  } else if (typeof rawArgs === "string") {
    argsArray = rawArgs
      .split("\n")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
  }

  if (argsArray.length > MAX_ARGS) {
    argsArray = argsArray.slice(0, MAX_ARGS);
  }

  // Handle Docker command — extract the image and real command
  if (command === "docker" && argsArray.length > 0) {
    // Find the docker image in the args, skipping flag-value pairs
    const runIndex = argsArray.indexOf("run");
    const startIndex = runIndex !== -1 ? runIndex + 1 : 0;
    const imageIndex = findDockerImageIndex(argsArray, startIndex);

    if (imageIndex !== -1) {
      result.dockerImage = argsArray[imageIndex];
      const commandAndArgs = argsArray.slice(imageIndex + 1);

      if (commandAndArgs.length > 0) {
        // Check if first item is a flag or a command
        if (commandAndArgs[0].startsWith("-")) {
          // Flags only — no command override
          result.arguments = commandAndArgs.join("\n");
        } else {
          // First item is the command, rest are args
          result.command = commandAndArgs[0];
          result.arguments = commandAndArgs.slice(1).join("\n");
        }
      }
    } else {
      // Can't find image — keep original command and args
      result.command = command;
      result.arguments = argsArray.join("\n");
    }
  } else {
    result.command = command || undefined;
    result.arguments = argsArray.length > 0 ? argsArray.join("\n") : undefined;
  }

  // Parse environment variables
  if (env && typeof env === "object" && !Array.isArray(env)) {
    result.environment = parseEnvObject(env as Record<string, string>);
  }

  // Detect transport type from args
  if (argsArray.length > 0) {
    const transport = detectTransportType(argsArray);
    result.transportType = transport.transportType;
    result.httpPort = transport.httpPort;
  }

  // Pick up Archestra user_config or MCP registry env vars if present
  const archestraEnv = (server as Record<string, unknown>)
    ._archestraUserConfig as ParsedEnvVar[] | undefined;
  const registryEnv = (server as Record<string, unknown>)._registryEnvVars as
    | ParsedEnvVar[]
    | undefined;
  if (archestraEnv && archestraEnv.length > 0 && !result.environment) {
    result.environment = archestraEnv;
  } else if (registryEnv && registryEnv.length > 0 && !result.environment) {
    result.environment = registryEnv;
  }

  return result;
}

/**
 * Parses a remote (HTTP) server config object.
 */
function parseRemoteServer(
  server: Record<string, unknown>,
  inputs?: Array<{ id: string; description?: string; password?: boolean }>,
): ParsedMcpServerConfig {
  const result: ParsedMcpServerConfig = {
    serverType: "remote",
  };

  // URL can be at server.url (Claude/VS Code) or server.transport.url (MCP Registry)
  let url = typeof server.url === "string" ? server.url.trim() : "";
  if (
    !url &&
    "transport" in server &&
    typeof server.transport === "object" &&
    !Array.isArray(server.transport)
  ) {
    const transport = server.transport as Record<string, unknown>;
    if (typeof transport.url === "string") {
      url = transport.url.trim();
    }
  }
  if (url && isSafeUrl(url)) {
    result.serverUrl = url;
  }

  // Parse headers
  const headers = server.headers;
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    const headersObj = headers as Record<string, string>;
    const parsed: NonNullable<ParsedMcpServerConfig["headers"]> = [];

    for (const [name, rawValue] of Object.entries(headersObj)) {
      const value =
        typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
      const resolved = resolveInputPlaceholder(value, inputs ?? []);

      parsed.push({
        headerName: name,
        value: resolved.isPlaceholder ? undefined : resolved.value,
        promptOnInstallation: resolved.isPlaceholder,
        required: resolved.isPlaceholder,
        description: resolved.description,
        sensitive: resolved.sensitive,
      });
    }

    if (parsed.length > 0) {
      result.headers = parsed;
    }
  }

  // Pick up Archestra user_config or MCP registry env vars if present
  const archestraEnv = (server as Record<string, unknown>)
    ._archestraUserConfig as ParsedEnvVar[] | undefined;
  const registryEnv = (server as Record<string, unknown>)._registryEnvVars as
    | ParsedEnvVar[]
    | undefined;
  if (archestraEnv && archestraEnv.length > 0) {
    result.environment = archestraEnv;
  } else if (registryEnv && registryEnv.length > 0) {
    result.environment = registryEnv;
  }

  return result;
}

/**
 * Parses Archestra-style user_config entries into environment variable form format.
 * Each key in user_config becomes an env var with the appropriate type and flags.
 */
function parseUserConfig(
  userConfig: Record<string, Record<string, unknown>>,
): ParsedEnvVar[] {
  const result: ParsedEnvVar[] = [];

  for (const [key, config] of Object.entries(userConfig)) {
    if (!isSafeEnvKey(key)) continue;
    if (!config || typeof config !== "object") continue;

    const isSensitive = config.sensitive === true || config.type === "secret";
    const isRequired = config.required === true;
    const description =
      typeof config.description === "string" ? config.description : undefined;

    result.push({
      key,
      type: isSensitive ? "secret" : "plain_text",
      value: undefined,
      promptOnInstallation: isSensitive || isRequired,
      required: isRequired,
      description,
    });

    if (result.length >= MAX_ENV_VARS) break;
  }

  return result;
}

/**
 * Parses MCP Registry package environment variables into the form's env format.
 */
function parseRegistryEnvVars(
  envVars: Array<Record<string, unknown>>,
): ParsedEnvVar[] {
  const result: ParsedEnvVar[] = [];

  for (const envVar of envVars) {
    const name = typeof envVar.name === "string" ? envVar.name : "";
    if (!name || !isSafeEnvKey(name)) continue;

    const isSecret = envVar.isSecret === true;
    const isRequired = envVar.isRequired === true;
    const description =
      typeof envVar.description === "string" ? envVar.description : undefined;

    result.push({
      key: name,
      type: isSecret ? "secret" : "plain_text",
      value: undefined,
      promptOnInstallation: isSecret || isRequired,
      required: isRequired,
      description,
    });

    if (result.length >= MAX_ENV_VARS) break;
  }

  return result;
}

// ─── Main Parser ────────────────────────────────────────────────────────

/**
 * Parses raw pasted text into a normalised MCP server configuration.
 *
 * Returns `null` if the input is not valid JSON or does not match a known
 * MCP server config shape. The caller should fall back to the default
 * paste behaviour in that case.
 */
export function parseMcpServerConfigJson(
  rawText: string,
): ParsedMcpServerConfig | null {
  if (!rawText || typeof rawText !== "string") return null;

  const trimmed = rawText.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INPUT_LENGTH) return null;

  // Try parsing as JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  // Format: bare JSON array of strings → arguments only
  if (Array.isArray(parsed)) {
    const args = parsed
      .filter((item): item is string => typeof item === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (args.length === 0) return null;

    return {
      serverType: "local",
      arguments: args.slice(0, MAX_ARGS).join("\n"),
    };
  }

  // Extract the server object from wrapper formats
  const extracted = extractServerObject(parsed);
  if (!extracted) return null;

  const { server } = extracted;

  // Check for Archestra registry format (user_config at top level)
  const topLevelObj = parsed as Record<string, unknown>;
  if (
    "user_config" in topLevelObj &&
    typeof topLevelObj.user_config === "object" &&
    !Array.isArray(topLevelObj.user_config)
  ) {
    const userConfigResult = parseUserConfig(
      topLevelObj.user_config as Record<string, Record<string, unknown>>,
    );
    if (userConfigResult.length > 0) {
      // Store on the server object so parseRemoteServer/parseLocalServer can pick it up
      (server as Record<string, unknown>)._archestraUserConfig =
        userConfigResult;
    }
  }

  // Check for MCP Registry format (environmentVariables on the package/server object)
  if (
    "environmentVariables" in server &&
    Array.isArray(server.environmentVariables)
  ) {
    const registryEnvResult = parseRegistryEnvVars(
      server.environmentVariables as Array<Record<string, unknown>>,
    );
    if (registryEnvResult.length > 0) {
      (server as Record<string, unknown>)._registryEnvVars = registryEnvResult;
    }
  }

  // Extract inputs block (VS Code format) if present
  const topLevel = parsed as Record<string, unknown>;
  let inputs:
    | Array<{ id: string; description?: string; password?: boolean }>
    | undefined;
  if ("inputs" in topLevel && Array.isArray(topLevel.inputs)) {
    inputs = (topLevel.inputs as Array<Record<string, unknown>>)
      .filter((item) => item && typeof item.id === "string")
      .map((item) => ({
        id: item.id as string,
        description:
          typeof item.description === "string" ? item.description : undefined,
        password:
          typeof item.password === "boolean" ? item.password : undefined,
      }));
  }

  // Determine if this is a local (stdio) or remote (HTTP) server
  // Also handle MCP Registry format where transport.url and transport.type are nested
  const hasTransportUrl =
    "transport" in server &&
    typeof server.transport === "object" &&
    !Array.isArray(server.transport) &&
    "url" in (server.transport as Record<string, unknown>);
  const transportType =
    hasTransportUrl &&
    typeof (server.transport as Record<string, unknown>).type === "string"
      ? ((server.transport as Record<string, unknown>).type as string)
      : "";
  const isRemote =
    ("type" in server &&
      (server.type === "http" ||
        server.type === "sse" ||
        server.type === "remote")) ||
    ("url" in server && !("command" in server)) ||
    hasTransportUrl ||
    transportType === "streamable-http" ||
    transportType === "sse";

  if (isRemote) {
    const remoteConfig = parseRemoteServer(server, inputs);
    // If we got a URL or headers, return the remote config
    if (remoteConfig.serverUrl || remoteConfig.headers) {
      return remoteConfig;
    }
  }

  // Otherwise treat as a local server
  const localConfig = parseLocalServer(server);

  // Return only if we found something useful
  if (
    localConfig.command ||
    localConfig.arguments ||
    localConfig.dockerImage ||
    localConfig.environment?.length
  ) {
    return localConfig;
  }

  return null;
}
