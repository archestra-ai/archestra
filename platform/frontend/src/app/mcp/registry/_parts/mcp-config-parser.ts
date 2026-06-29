import { parseDockerArgsToLocalConfig } from "./docker-args-parser";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";

type LocalConfig = NonNullable<McpCatalogFormValues["localConfig"]>;
type EnvironmentEntry = NonNullable<LocalConfig["environment"]>[number];

/**
 * Result of importing a pasted MCP server configuration.
 */
export interface ParsedMcpServerConfig {
  /**
   * Partial form values to merge onto the create-form defaults. Only the
   * fields the pasted config actually describes are populated — everything
   * else is left to the form's existing defaults.
   */
  values: Partial<McpCatalogFormValues>;
  /** The server key/name detected in the config, if any. */
  serverName?: string;
  /**
   * Non-fatal notes worth surfacing to the user — e.g. when the pasted blob
   * held several servers and only the first was imported, or when a field
   * needs manual attention.
   */
  warnings: string[];
}

/** Thrown when the pasted text can't be recognized as an MCP server config. */
export class McpConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigParseError";
  }
}

// Transport `type` values that mean "this is a remote (HTTP-reachable) server".
const REMOTE_TRANSPORT_TYPES = new Set([
  "http",
  "https",
  "sse",
  "streamable-http",
  "streamablehttp",
  "streamable_http",
  "ws",
  "websocket",
]);

// Env var keys whose values are credentials — never stored statically in a
// (shared) catalog item; always turned into a prompt-on-install field instead.
const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|credential|auth)/i;

// Heuristics for "this value is a placeholder, not a real value" — copy-pasted
// configs from docs are full of these. A placeholder becomes a prompt-on-install
// field with no baked-in value.
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^<.*>$/, // <your-token>
  /^\$\{.*\}$/, // ${ENV_VAR}
  /^\$[A-Za-z_][A-Za-z0-9_]*$/, // $ENV_VAR
  /your[_-]?\w*[_-]?(token|key|secret|password|id|value|name)/i, // YOUR_API_KEY
  /\b(here|placeholder|change[_-]?me|replace[_-]?me|todo|example|insert)\b/i,
  /^x{3,}$/i, // xxxx
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function looksLikePlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return true;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Maps one `env`/`environment_variables` entry to a form environment row.
 * Secret-looking keys and placeholder values become prompt-on-install fields
 * (no value persisted); concrete non-secret values are kept as static defaults.
 */
function buildEnvironmentEntry(
  key: string,
  rawValue: unknown,
  options: { required?: boolean; description?: string } = {},
): EnvironmentEntry {
  const value =
    typeof rawValue === "string"
      ? rawValue
      : rawValue == null
        ? ""
        : String(rawValue);
  const isSecret = SECRET_KEY_PATTERN.test(key);
  const isPlaceholder = looksLikePlaceholder(value);
  const promptOnInstallation = isSecret || isPlaceholder;
  return {
    key,
    type: isSecret ? "secret" : "plain_text",
    value: promptOnInstallation ? undefined : value,
    promptOnInstallation,
    required: options.required ?? promptOnInstallation,
    description: options.description ?? "",
  };
}

// Tidy a server name for the catalog's required Name field. Registry ids like
// "io.github.owner/server" collapse to their last path segment.
function tidyName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.includes("/")) {
    const last = trimmed.split("/").filter(Boolean).pop();
    if (last) return last;
  }
  return trimmed;
}

// Best-effort extraction of the image from a raw `docker run …` arg list, so we
// can hand it to the repo's existing `parseDockerArgsToLocalConfig`.
const DOCKER_VALUE_FLAGS = new Set([
  "-e",
  "--env",
  "-v",
  "--volume",
  "--mount",
  "--name",
  "-p",
  "--publish",
  "-w",
  "--workdir",
  "--network",
  "--entrypoint",
  "-u",
  "--user",
]);

function guessDockerImage(args: string[]): string | undefined {
  const runIndex = args.indexOf("run");
  const search = runIndex >= 0 ? args.slice(runIndex + 1) : args;
  for (let i = 0; i < search.length; i++) {
    const token = search[i];
    if (token.startsWith("-")) {
      if (DOCKER_VALUE_FLAGS.has(token)) i++; // skip the flag's value
      continue;
    }
    return token; // first bare token after the flags is the image
  }
  return undefined;
}

/**
 * Normalizes one "standard" server entry — the shape used by Claude Desktop /
 * Cursor / VS Code `mcpServers` configs and most catalogs:
 *   local:  { command, args?, env? }
 *   remote: { url | type:"http"|"sse"|…, headers? }
 */
function normalizeStandardServer(
  name: string,
  rawEntry: unknown,
): { values: Partial<McpCatalogFormValues>; warnings: string[] } {
  if (!isPlainObject(rawEntry)) {
    throw new McpConfigParseError(`Server "${name}" is not a JSON object.`);
  }
  const entry = rawEntry;
  const warnings: string[] = [];
  const values: Partial<McpCatalogFormValues> = {};

  const displayName = readString(entry.name) ?? name;
  if (displayName) values.name = tidyName(displayName);
  const description = readString(entry.description);
  if (description) values.description = description;

  const transportRecord = isPlainObject(entry.transport) ? entry.transport : {};
  const transportType = (
    readString(entry.type) ?? readString(transportRecord.type)
  )?.toLowerCase();
  const url =
    readString(entry.url) ??
    readString(transportRecord.url) ??
    readString(entry.serverUrl);
  const isRemote =
    Boolean(url) ||
    (transportType ? REMOTE_TRANSPORT_TYPES.has(transportType) : false);

  if (isRemote) {
    values.serverType = "remote";
    if (url) {
      values.serverUrl = url;
    } else {
      warnings.push(
        "Remote server had no URL — add the Server URL before saving.",
      );
    }
    const headers = isPlainObject(entry.headers) ? entry.headers : {};
    const headerNames = Object.keys(headers);
    if (headerNames.length > 0) {
      // Header → auth mapping is deliberately left to the user: the form has
      // dedicated, validated Authentication controls, and silently importing an
      // Authorization header can collide with them. Flag, don't guess.
      warnings.push(
        `Detected ${headerNames.length} header(s) (${headerNames.join(", ")}). Configure them under Authentication.`,
      );
    }
    return { values, warnings };
  }

  // Local (stdio / self-hosted) server.
  const command = readString(entry.command);
  const args = readStringArray(entry.args);
  const env = isPlainObject(entry.env) ? entry.env : {};
  const environment = Object.entries(env).map(([key, value]) =>
    buildEnvironmentEntry(key, value),
  );

  let localCommand = command ?? "";
  let argumentList = args;
  let dockerImage =
    readString(entry.dockerImage) ?? readString(entry.docker_image) ?? "";
  let localTransport: "stdio" | "streamable-http" = "stdio";
  let httpPort = "";

  // Reuse the repo's tested docker parser when this is a `docker run …` command.
  if (command === "docker") {
    const image = dockerImage || guessDockerImage(args);
    const parsed = image
      ? parseDockerArgsToLocalConfig(command, args, image)
      : null;
    if (parsed) {
      localCommand = parsed.command ?? "";
      argumentList = parsed.arguments ?? [];
      dockerImage = parsed.dockerImage;
      if (parsed.transportType) localTransport = parsed.transportType;
      if (parsed.httpPort != null) httpPort = String(parsed.httpPort);
    }
  }

  if (!localCommand && !dockerImage) {
    warnings.push("No command or Docker image found — set one before saving.");
  }

  values.serverType = "local";
  values.localConfig = {
    command: localCommand,
    arguments: argumentList.join("\n"),
    environment,
    envFrom: [],
    dockerImage,
    transportType: localTransport,
    httpPort,
    httpPath: "/mcp",
    serviceAccount: "",
    imagePullSecrets: [],
  };
  return { values, warnings };
}

/**
 * Normalizes an official MCP Registry `server.json`
 * (https://registry.modelcontextprotocol.io). Best-effort: imports the first
 * package (or first remote) plus its environment variables, and flags advanced
 * runtime/package arguments for manual review rather than guessing their order.
 */
function normalizeOfficialRegistry(root: Record<string, unknown>): {
  values: Partial<McpCatalogFormValues>;
  warnings: string[];
  serverName?: string;
} {
  const warnings: string[] = [];
  const values: Partial<McpCatalogFormValues> = {};

  const registryName = readString(root.name);
  if (registryName) values.name = tidyName(registryName);
  const description = readString(root.description);
  if (description) values.description = description;

  const packages = Array.isArray(root.packages) ? root.packages : [];
  const remotes = Array.isArray(root.remotes) ? root.remotes : [];

  if (packages.length > 1) {
    warnings.push(
      `Found ${packages.length} packages; imported the first. Import the others separately.`,
    );
  }

  const pkg = packages.find(isPlainObject);
  if (pkg) {
    const registryType = readString(pkg.registry_type)?.toLowerCase();
    const identifier = readString(pkg.identifier) ?? "";
    const version = readString(pkg.version);
    const runtimeHint = readString(pkg.runtime_hint);
    const transportRecord = isPlainObject(pkg.transport) ? pkg.transport : {};
    const transportType = readString(transportRecord.type)?.toLowerCase();

    const environment = (
      Array.isArray(pkg.environment_variables) ? pkg.environment_variables : []
    )
      .filter(isPlainObject)
      .map((variable) => {
        const key = readString(variable.name) ?? "";
        const isSecret = variable.is_secret === true;
        const isRequired = variable.is_required === true;
        const defaultValue = variable.default;
        const value =
          !isSecret && typeof defaultValue === "string"
            ? defaultValue
            : undefined;
        const promptOnInstallation = isSecret || isRequired || value == null;
        return {
          key,
          type: isSecret ? "secret" : "plain_text",
          value: promptOnInstallation ? undefined : value,
          promptOnInstallation,
          required: isRequired,
          description: readString(variable.description) ?? "",
        } as EnvironmentEntry;
      })
      .filter((entry) => entry.key !== "");

    if (
      (Array.isArray(pkg.runtime_arguments) && pkg.runtime_arguments.length) ||
      (Array.isArray(pkg.package_arguments) && pkg.package_arguments.length)
    ) {
      warnings.push(
        "Package has structured runtime/package arguments — review the Arguments field after importing.",
      );
    }

    values.serverType = "local";

    if (registryType === "oci" || registryType === "docker") {
      const image = version ? `${identifier}:${version}` : identifier;
      values.localConfig = makeLocalConfig({
        dockerImage: image,
        transportType:
          transportType === "streamable-http" ? "streamable-http" : "stdio",
        environment,
      });
    } else {
      const { command, args } = runtimeInvocation(
        registryType,
        runtimeHint,
        identifier,
        version,
      );
      values.localConfig = makeLocalConfig({
        command,
        argumentList: args,
        transportType:
          transportType === "streamable-http" ? "streamable-http" : "stdio",
        environment,
      });
    }
    return { values, warnings, serverName: registryName };
  }

  const remote = remotes.find(isPlainObject);
  if (remote) {
    values.serverType = "remote";
    const url = readString(remote.url);
    if (url) {
      values.serverUrl = url;
    } else {
      warnings.push(
        "Remote entry had no URL — add the Server URL before saving.",
      );
    }
    if (Array.isArray(remote.headers) && remote.headers.length > 0) {
      warnings.push(
        "Remote entry declares headers — configure them under Authentication.",
      );
    }
    return { values, warnings, serverName: registryName };
  }

  throw new McpConfigParseError(
    "Registry server has no importable packages or remotes.",
  );
}

// npm/pypi/etc. → a (command, args) pair. Only the package identifier is wired
// up; structured runtime/package arguments are surfaced as a warning instead.
function runtimeInvocation(
  registryType: string | undefined,
  runtimeHint: string | undefined,
  identifier: string,
  version: string | undefined,
): { command: string; args: string[] } {
  const versioned =
    version && registryType === "npm" ? `${identifier}@${version}` : identifier;
  if (registryType === "npm") {
    return { command: runtimeHint || "npx", args: ["-y", versioned] };
  }
  if (registryType === "pypi") {
    return { command: runtimeHint || "uvx", args: [identifier] };
  }
  // Unknown registry type: pass the hint/identifier through as-is.
  return { command: runtimeHint || identifier, args: [] };
}

function makeLocalConfig(params: {
  command?: string;
  argumentList?: string[];
  dockerImage?: string;
  transportType?: "stdio" | "streamable-http";
  environment?: EnvironmentEntry[];
}): LocalConfig {
  return {
    command: params.command ?? "",
    arguments: (params.argumentList ?? []).join("\n"),
    environment: params.environment ?? [],
    envFrom: [],
    dockerImage: params.dockerImage ?? "",
    transportType: params.transportType ?? "stdio",
    httpPort: "",
    httpPath: "/mcp",
    serviceAccount: "",
    imagePullSecrets: [],
  };
}

/**
 * Parses a pasted MCP server configuration (in any of the common "wild"
 * formats) into partial catalog-form values, so a user can copy-paste a config
 * from the internet and create a server without re-typing every field.
 *
 * Supported inputs:
 *  - `{ "mcpServers": { "<name>": {…} } }` (also `{ "servers": {…} }`)
 *  - a single bare server object: `{ command, args, env }` or `{ url, type }`
 *  - an official MCP Registry `server.json` (`{ name, packages, remotes }`)
 *
 * @throws {McpConfigParseError} when the text is empty, not JSON, or not a
 *   recognizable server config.
 */
export function parseMcpServerConfig(input: string): ParsedMcpServerConfig {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new McpConfigParseError(
      "Paste an MCP server configuration to import.",
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new McpConfigParseError(
      "That doesn't look like valid JSON — paste the server configuration as JSON.",
    );
  }

  if (!isPlainObject(json)) {
    throw new McpConfigParseError(
      "Expected a JSON object describing an MCP server.",
    );
  }
  const root = json;

  // 1. `{ "mcpServers": {…} }` / `{ "servers": {…} }` map.
  const mapKey = isPlainObject(root.mcpServers)
    ? "mcpServers"
    : isPlainObject(root.servers)
      ? "servers"
      : undefined;
  if (mapKey) {
    const entries = Object.entries(root[mapKey] as Record<string, unknown>);
    if (entries.length === 0) {
      throw new McpConfigParseError(
        `"${mapKey}" was empty — there is no server to import.`,
      );
    }
    const [name, entry] = entries[0];
    const result = normalizeStandardServer(name, entry);
    const warnings = result.warnings;
    if (entries.length > 1) {
      warnings.unshift(
        `Found ${entries.length} servers; imported "${name}". Import the others separately.`,
      );
    }
    return { values: result.values, serverName: name, warnings };
  }

  // 2. Official MCP Registry server.json.
  if (Array.isArray(root.packages) || Array.isArray(root.remotes)) {
    return normalizeOfficialRegistry(root);
  }

  // 3. A single bare server object.
  if (
    "command" in root ||
    "url" in root ||
    "type" in root ||
    "transport" in root
  ) {
    const name = readString(root.name) ?? "imported-server";
    const result = normalizeStandardServer(name, root);
    return {
      values: result.values,
      serverName: readString(root.name),
      warnings: result.warnings,
    };
  }

  // 4. A bare `{ "<name>": {…} }` map without the `mcpServers` wrapper.
  const objectEntries = Object.entries(root).filter(([, value]) =>
    isPlainObject(value),
  );
  if (objectEntries.length > 0) {
    const [name, entry] = objectEntries[0];
    const result = normalizeStandardServer(name, entry);
    const warnings = result.warnings;
    if (objectEntries.length > 1) {
      warnings.unshift(
        `Found ${objectEntries.length} servers; imported "${name}". Import the others separately.`,
      );
    }
    return { values: result.values, serverName: name, warnings };
  }

  throw new McpConfigParseError(
    "Couldn't recognize this as an MCP server configuration.",
  );
}
