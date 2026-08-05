import { parseDockerArgsToLocalConfig } from "./docker-args-parser";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";

export interface McpConfigImportCandidate {
  id: string;
  label: string;
  values: Partial<McpCatalogFormValues>;
  warnings: string[];
}

export function parseMcpConfigImport(
  input: string,
): McpConfigImportCandidate[] {
  const root = parseJsonObject(input);
  const officialServers = getOfficialServers(root);
  if (officialServers.length) {
    return officialServers.flatMap(parseOfficialServer);
  }
  if (isArchestraManifest(root)) {
    return [parseArchestraManifest(root)];
  }

  const inputs = readInputs(root.inputs);
  for (const key of ["mcpServers", "servers", "mcp", "context_servers"]) {
    if (isObject(root[key])) {
      return parseServerMap(root[key], key, inputs);
    }
  }
  if (looksLikeServer(root)) {
    return [
      parseStandardServer(
        readString(root.name) ?? "Imported server",
        root,
        inputs,
        "server:0",
      ),
    ];
  }

  const bareServers = Object.fromEntries(
    Object.entries(root).filter(
      ([, value]) => isObject(value) && looksLikeServer(value),
    ),
  );
  if (Object.keys(bareServers).length) {
    return parseServerMap(bareServers, "servers", inputs);
  }
  throw new Error("No MCP server configuration was found in this JSON.");
}

type JsonObject = Record<string, unknown>;
type LocalConfig = NonNullable<McpCatalogFormValues["localConfig"]>;
type EnvironmentRow = LocalConfig["environment"][number];
type HeaderRow = NonNullable<McpCatalogFormValues["additionalHeaders"]>[number];

interface InputDefinition {
  id: string;
  description: string;
  secret: boolean;
  required: boolean;
  defaultValue?: string | number | boolean;
}

const REMOTE_TYPES = new Set([
  "http",
  "https",
  "remote",
  "sse",
  "streamable-http",
  "streamable_http",
  "websocket",
]);
const SECRET_NAME =
  /(^|[_-])(auth|credential|key|pass|password|private|pwd|secret|token)($|[_-])/i;
const PLACEHOLDER = [
  /^<[^>]+>$/,
  /^\$\{[^}]+\}$/,
  /^\$[A-Za-z_][A-Za-z0-9_]*$/,
  /(^|[_-])(change|insert|replace)[_-]?me($|[_-])/i,
  /(^|[_-])your[_-]/i,
  /placeholder/i,
];
const DOCKER_VALUE_FLAGS = new Set([
  "--env",
  "--env-file",
  "--entrypoint",
  "--mount",
  "--name",
  "--network",
  "--publish",
  "--user",
  "--volume",
  "--workdir",
  "-e",
  "-p",
  "-u",
  "-v",
  "-w",
]);

function parseJsonObject(input: string): JsonObject {
  if (!input.trim())
    throw new Error("Paste an MCP server configuration first.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("The pasted configuration is not valid JSON.");
  }
  if (!isObject(parsed)) {
    throw new Error("The MCP configuration must be a JSON object.");
  }
  return parsed;
}

function parseServerMap(
  map: JsonObject,
  source: string,
  inputs: Map<string, InputDefinition>,
): McpConfigImportCandidate[] {
  const entries = Object.entries(map).filter(
    (entry): entry is [string, JsonObject] => isObject(entry[1]),
  );
  if (!entries.length) throw new Error(`The "${source}" object is empty.`);
  return entries.map(([name, server], index) =>
    parseStandardServer(name, server, inputs, `${source}:${index}`),
  );
}

function parseStandardServer(
  fallbackName: string,
  server: JsonObject,
  inputs: Map<string, InputDefinition>,
  id: string,
): McpConfigImportCandidate {
  const warnings: string[] = [];
  const transport = isObject(server.transport) ? server.transport : {};
  const type = (
    readString(server.type) ??
    readString(server.transportType) ??
    readString(transport.type) ??
    ""
  ).toLowerCase();
  const url =
    readString(server.url) ??
    readString(server.serverUrl) ??
    readString(server.httpUrl) ??
    readString(transport.url);
  const name = tidyName(readString(server.name) ?? fallbackName);
  const common = {
    name,
    description: readString(server.description),
    multitenant: false,
    includeBearerPrefix: true,
    authHeaderName: "",
  } satisfies Partial<McpCatalogFormValues>;

  if (url || REMOTE_TYPES.has(type)) {
    const headers = readHeaders(server.headers, inputs);
    if (!url)
      warnings.push("This remote server has no URL. Add one before saving.");
    return {
      id,
      label: name,
      values: {
        ...common,
        serverType: "remote",
        serverUrl: url ?? "",
        authMethod: hasBearerHeader(headers) ? "auth_header" : "none",
        additionalHeaders: headers,
        localConfig: undefined,
      },
      warnings,
    };
  }

  const nestedCommand = isObject(server.command) ? server.command : undefined;
  const commandParts = readCommand(server.command, nestedCommand);
  let command = commandParts[0] ?? "";
  let args = [
    ...commandParts.slice(1),
    ...readArguments(
      server.args ?? server.arguments ?? nestedCommand?.args,
      warnings,
    ),
  ];
  const environment = readEnvironment(
    server.env ?? server.environment ?? nestedCommand?.env,
    inputs,
  );
  let dockerImage =
    readString(server.dockerImage) ?? readString(server.docker_image) ?? "";
  let transportType: LocalConfig["transportType"] =
    type === "streamable-http" || type === "streamable_http"
      ? "streamable-http"
      : "stdio";
  let httpPort = readNumberString(
    server.httpPort ?? server.port ?? transport.port,
  );

  if (command === "docker") {
    dockerImage ||= findDockerImage(args) ?? "";
    const parsed = parseDockerArgsToLocalConfig(
      command,
      args,
      dockerImage || undefined,
    );
    if (parsed) {
      command = parsed.command ?? "";
      args = parsed.arguments ?? [];
      dockerImage = parsed.dockerImage;
      transportType = parsed.transportType ?? transportType;
      httpPort = parsed.httpPort?.toString() ?? httpPort;
    }
  }
  if (args.some(isPlaceholder)) {
    warnings.push("Replace the placeholder command arguments before saving.");
  }
  if (!command && !dockerImage) {
    warnings.push(
      "No command or Docker image was found. Add one before saving.",
    );
  }
  return {
    id,
    label: name,
    values: {
      ...common,
      serverType: "local",
      serverUrl: "",
      authMethod: "none",
      additionalHeaders: [],
      localConfig: makeLocalConfig({
        command,
        args,
        environment,
        dockerImage,
        transportType,
        httpPort,
        httpPath: readString(server.httpPath) ?? readString(transport.path),
      }),
    },
    warnings: [...new Set(warnings)],
  };
}

function getOfficialServers(root: JsonObject): JsonObject[] {
  if (looksOfficial(root)) return [root];
  if (isObject(root.server) && looksOfficial(root.server)) return [root.server];
  if (!Array.isArray(root.servers)) return [];
  return root.servers.flatMap((entry) => {
    if (!isObject(entry)) return [];
    const server = isObject(entry.server) ? entry.server : entry;
    return looksOfficial(server) ? [server] : [];
  });
}

function parseOfficialServer(
  server: JsonObject,
  serverIndex: number,
): McpConfigImportCandidate[] {
  const name = tidyName(
    readString(server.title) ?? readString(server.name) ?? "Imported server",
  );
  const common = {
    name,
    description: readString(server.description),
    icon:
      readString(server.icon) ??
      (Array.isArray(server.icons) && isObject(server.icons[0])
        ? readString(server.icons[0].src)
        : undefined),
    multitenant: false,
    includeBearerPrefix: true,
    authHeaderName: "",
  } satisfies Partial<McpCatalogFormValues>;
  const candidates: McpConfigImportCandidate[] = [];
  const remotes = Array.isArray(server.remotes)
    ? server.remotes.filter(isObject)
    : [];
  const packages = Array.isArray(server.packages)
    ? server.packages.filter(isObject)
    : [];

  remotes.forEach((remote, index) => {
    const headers = readHeaders(remote.headers, new Map());
    const warnings = isObject(remote.variables)
      ? [
          "Replace the variables in the remote URL with concrete values before saving.",
        ]
      : [];
    const type = readString(remote.type) ?? "remote";
    const url = readString(remote.url) ?? "";
    if (!url)
      warnings.push("This remote entry has no URL. Add one before saving.");
    candidates.push({
      id: `official:${serverIndex}:remote:${index}`,
      label: `${name} — remote (${type})`,
      values: {
        ...common,
        serverType: "remote",
        serverUrl: url,
        authMethod: hasBearerHeader(headers) ? "auth_header" : "none",
        additionalHeaders: headers,
        localConfig: undefined,
      },
      warnings,
    });
  });

  let unsupported = 0;
  packages.forEach((packageConfig, index) => {
    const parsed = parseOfficialPackage(packageConfig);
    if (!parsed) {
      unsupported += 1;
      return;
    }
    candidates.push({
      id: `official:${serverIndex}:package:${index}`,
      label: `${name} — ${parsed.label}`,
      values: {
        ...common,
        serverType: "local",
        serverUrl: "",
        authMethod: "none",
        additionalHeaders: [],
        localConfig: parsed.localConfig,
      },
      warnings: parsed.warnings,
    });
  });
  if (unsupported) {
    for (const candidate of candidates) {
      candidate.warnings.push(
        `${unsupported} unsupported package option${unsupported === 1 ? " was" : "s were"} skipped.`,
      );
    }
  }
  if (!candidates.length) {
    throw new Error(
      `The Registry entry for "${name}" has no supported option.`,
    );
  }
  return candidates;
}

function parseOfficialPackage(
  packageConfig: JsonObject,
): { label: string; localConfig: LocalConfig; warnings: string[] } | undefined {
  const registryType = (
    readString(packageConfig.registryType) ??
    readString(packageConfig.registry_type) ??
    ""
  ).toLowerCase();
  const identifier = readString(packageConfig.identifier);
  if (!identifier || !["npm", "pypi", "oci", "docker"].includes(registryType)) {
    return undefined;
  }
  const warnings: string[] = [];
  const version = readString(packageConfig.version);
  const transport = isObject(packageConfig.transport)
    ? packageConfig.transport
    : {};
  const rawTransport = (readString(transport.type) ?? "stdio").toLowerCase();
  const transportType = rawTransport === "stdio" ? "stdio" : "streamable-http";
  const environment = readOfficialEnvironment(
    packageConfig.environmentVariables ?? packageConfig.environment_variables,
  );
  const runtimeArgs = readOfficialArguments(
    packageConfig.runtimeArguments ?? packageConfig.runtime_arguments,
    warnings,
  );
  const packageArgs = readOfficialArguments(
    packageConfig.packageArguments ?? packageConfig.package_arguments,
    warnings,
  );
  const http = readTransportUrl(transport);

  if (registryType === "oci" || registryType === "docker") {
    if (runtimeArgs.length) {
      warnings.push(
        "Container runtime arguments were not imported into Kubernetes.",
      );
    }
    return {
      label: `${registryType} package`,
      localConfig: makeLocalConfig({
        args: packageArgs,
        environment,
        dockerImage: appendVersion(identifier, version, ":"),
        transportType,
        ...http,
      }),
      warnings,
    };
  }

  const runtimeHint =
    readString(packageConfig.runtimeHint) ??
    readString(packageConfig.runtime_hint);
  const command = runtimeHint ?? (registryType === "npm" ? "npx" : "uvx");
  const separator = registryType === "npm" ? "@" : "==";
  const args = [...runtimeArgs];
  if (
    command === "npx" &&
    !args.some((arg) => arg === "-y" || arg === "--yes")
  ) {
    args.push("-y");
  }
  args.push(appendVersion(identifier, version, separator), ...packageArgs);
  return {
    label: `${registryType} package`,
    localConfig: makeLocalConfig({
      command,
      args,
      environment,
      transportType,
      ...http,
    }),
    warnings,
  };
}

function readOfficialArguments(value: unknown, warnings: string[]): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((argument) => {
    if (typeof argument === "string") return [argument];
    if (!isObject(argument)) return [];
    const type = readString(argument.type) ?? "positional";
    const name = readString(argument.name);
    const fixedValue =
      readString(argument.value) ?? readString(argument.default);
    if (fixedValue) {
      return type === "named" && name ? [name, fixedValue] : [fixedValue];
    }
    if (argument.isRequired === true || type === "positional") {
      const hint =
        readString(argument.valueHint) ?? name?.replace(/^-+/, "") ?? "value";
      warnings.push(
        `Replace the <${hint}> argument placeholder before saving.`,
      );
      return type === "named" && name ? [name, `<${hint}>`] : [`<${hint}>`];
    }
    return [];
  });
}

function readOfficialEnvironment(value: unknown): EnvironmentRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).flatMap((definition) => {
    const key = readString(definition.name);
    if (!key) return [];
    return [
      makeEnvironmentRow(key, definition.value, {
        description: readString(definition.description),
        required: readBoolean(definition.isRequired ?? definition.is_required),
        secret: readBoolean(definition.isSecret ?? definition.is_secret),
        defaultValue: readPrimitive(definition.default),
        format: readString(definition.format),
      }),
    ];
  });
}

function isArchestraManifest(root: JsonObject): boolean {
  return (
    isObject(root.server) &&
    ("archestra_config" in root ||
      "oauth_config" in root ||
      "user_config" in root)
  );
}

function parseArchestraManifest(root: JsonObject): McpConfigImportCandidate {
  const server = root.server as JsonObject;
  const oauth = isObject(root.oauth_config) ? root.oauth_config : undefined;
  const name =
    readString(oauth?.name) ?? readString(root.name) ?? "Imported server";
  const candidate = parseStandardServer(name, server, new Map(), "archestra:0");
  candidate.values.description =
    readString(root.description) ?? candidate.values.description;
  if (oauth) {
    const redirectUris = readStringArray(oauth.redirect_uris);
    const usesClientCredentials = oauth.grant_type === "client_credentials";
    candidate.values.authMethod = usesClientCredentials
      ? "oauth_client_credentials"
      : "oauth";
    candidate.values.oauthConfig = {
      client_id: readString(oauth.client_id) ?? "",
      client_secret: "",
      audience: readString(oauth.audience) ?? "",
      resource: readString(oauth.resource) ?? "",
      redirect_uris: redirectUris.join(", "),
      scopes: readStringArray(oauth.scopes).join(", "),
      additional_scopes: readStringArray(oauth.additional_scopes).join(", "),
      supports_resource_metadata:
        readBoolean(oauth.supports_resource_metadata) ?? true,
      grantType: usesClientCredentials
        ? "client_credentials"
        : "authorization_code",
      authServerUrl: readString(oauth.auth_server_url) ?? "",
      authorizationEndpoint: readString(oauth.authorization_endpoint) ?? "",
      wellKnownUrl: readString(oauth.well_known_url) ?? "",
      resourceMetadataUrl: readString(oauth.resource_metadata_url) ?? "",
      tokenEndpoint: readString(oauth.token_endpoint) ?? "",
      oauthServerUrl:
        candidate.values.serverType === "local"
          ? (readString(oauth.server_url) ?? "")
          : "",
    };
    if (!redirectUris.length && !usesClientCredentials) {
      candidate.warnings.push("Add the OAuth callback URL before saving.");
    }
  } else if (
    isObject(root.user_config) &&
    isObject(root.user_config.access_token)
  ) {
    candidate.values.authMethod = "bearer";
  }
  return candidate;
}

function readInputs(value: unknown): Map<string, InputDefinition> {
  if (!Array.isArray(value)) return new Map();
  const entries = value.filter(isObject).flatMap((input) => {
    const id = readString(input.id);
    if (!id) return [];
    const definition: InputDefinition = {
      id,
      description: readString(input.description) ?? "",
      secret: readBoolean(input.password ?? input.isSecret) ?? false,
      required: readBoolean(input.isRequired) ?? true,
      defaultValue: readPrimitive(input.default),
    };
    return [[id, definition] as const];
  });
  return new Map(entries);
}

function readEnvironment(
  value: unknown,
  inputs: Map<string, InputDefinition>,
): EnvironmentRow[] {
  if (!isObject(value)) return [];
  return Object.entries(value).map(([key, rawValue]) => {
    const input = getInput(rawValue, inputs);
    return makeEnvironmentRow(key, rawValue, {
      input,
      placeholder: input !== undefined,
    });
  });
}

function makeEnvironmentRow(
  key: string,
  rawValue: unknown,
  options: {
    input?: InputDefinition;
    placeholder?: boolean;
    description?: string;
    required?: boolean;
    secret?: boolean;
    defaultValue?: string | number | boolean;
    format?: string;
  } = {},
): EnvironmentRow {
  const value = readPrimitive(rawValue);
  const secret =
    options.secret || options.input?.secret || SECRET_NAME.test(key);
  const prompt =
    secret ||
    options.placeholder ||
    value === undefined ||
    (typeof value === "string" && isPlaceholder(value));
  const type: EnvironmentRow["type"] = secret
    ? "secret"
    : options.format === "boolean" || typeof value === "boolean"
      ? "boolean"
      : options.format === "number" || typeof value === "number"
        ? "number"
        : "plain_text";
  return {
    key,
    type,
    value: prompt || value === undefined ? undefined : String(value),
    promptOnInstallation: Boolean(prompt),
    required: options.required ?? options.input?.required ?? Boolean(prompt),
    description: options.description ?? options.input?.description ?? "",
    default: options.defaultValue ?? options.input?.defaultValue,
  };
}

function readHeaders(
  value: unknown,
  inputs: Map<string, InputDefinition>,
): HeaderRow[] {
  if (Array.isArray(value)) {
    return value.filter(isObject).flatMap((header) => {
      const name = readString(header.name);
      return name ? [makeHeaderRow(name, header, inputs)] : [];
    });
  }
  if (!isObject(value)) return [];
  return Object.entries(value).map(([name, raw]) =>
    makeHeaderRow(name, raw, inputs),
  );
}

function makeHeaderRow(
  name: string,
  raw: unknown,
  inputs: Map<string, InputDefinition>,
): HeaderRow {
  const definition = isObject(raw) ? raw : undefined;
  const rawValue = definition?.value ?? raw;
  const text = readPrimitive(rawValue)?.toString();
  const bearer = Boolean(text && /^Bearer\s+/i.test(text));
  const withoutBearer = text?.replace(/^Bearer\s+/i, "");
  const input = getInput(withoutBearer, inputs);
  const secret =
    readBoolean(definition?.isSecret ?? definition?.is_secret) ||
    input?.secret ||
    isSensitiveHeaderName(name);
  const prompt =
    secret || !withoutBearer || Boolean(input) || isPlaceholder(withoutBearer);
  return {
    fieldName: input?.id,
    headerName: name,
    promptOnInstallation: Boolean(prompt),
    required:
      readBoolean(definition?.isRequired ?? definition?.is_required) ??
      input?.required ??
      Boolean(prompt),
    value: prompt ? "" : withoutBearer,
    description:
      readString(definition?.description) ?? input?.description ?? "",
    includeBearerPrefix: bearer,
    sensitive: Boolean(prompt && secret),
  };
}

function readCommand(value: unknown, nested: JsonObject | undefined): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value))
    return value.filter((part): part is string => typeof part === "string");
  if (nested)
    return [readString(nested.path) ?? readString(nested.command) ?? ""];
  return [];
}

function readArguments(value: unknown, warnings: string[]): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    const strings = value.filter(
      (item): item is string => typeof item === "string",
    );
    if (strings.length !== value.length)
      warnings.push("Non-string arguments were ignored.");
    return strings;
  }
  if (typeof value !== "string") {
    warnings.push("Arguments were not an array of strings and were ignored.");
    return [];
  }
  if (value.trim().startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        Array.isArray(parsed) &&
        parsed.every((item) => typeof item === "string")
      ) {
        return parsed;
      }
    } catch {
      warnings.push("The JSON-formatted arguments could not be parsed.");
    }
  }
  return [value];
}

function readTransportUrl(transport: JsonObject): {
  httpPort?: string;
  httpPath?: string;
} {
  const url = readString(transport.url);
  if (!url) return {};
  try {
    const parsed = new URL(url);
    return {
      httpPort: parsed.port || undefined,
      httpPath: parsed.pathname || undefined,
    };
  } catch {
    return {};
  }
}

function makeLocalConfig(params: {
  command?: string;
  args?: string[];
  environment?: EnvironmentRow[];
  dockerImage?: string;
  transportType?: LocalConfig["transportType"];
  httpPort?: string;
  httpPath?: string;
}): LocalConfig {
  return {
    command: params.command ?? "",
    arguments: (params.args ?? []).join("\n"),
    environment: params.environment ?? [],
    envFrom: [],
    dockerImage: params.dockerImage ?? "",
    transportType: params.transportType ?? "stdio",
    httpPort: params.httpPort ?? "",
    httpPath: params.httpPath ?? "/mcp",
    serviceAccount: "",
    imagePullSecrets: [],
  };
}

function findDockerImage(args: string[]): string | undefined {
  const start = args.indexOf("run") + 1;
  for (let index = Math.max(0, start); index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("-")) return arg;
    if (DOCKER_VALUE_FLAGS.has(arg)) index += 1;
  }
  return undefined;
}

function getInput(
  value: unknown,
  inputs: Map<string, InputDefinition>,
): InputDefinition | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.match(/^\$\{input:([^}]+)\}$/)?.[1];
  return id ? inputs.get(id) : undefined;
}

function hasBearerHeader(headers: HeaderRow[]): boolean {
  return headers.some(
    (header) =>
      header.headerName.toLowerCase() === "authorization" &&
      header.includeBearerPrefix,
  );
}

function isSensitiveHeaderName(name: string): boolean {
  return (
    ["authorization", "cookie", "proxy-authorization", "set-cookie"].includes(
      name.toLowerCase(),
    ) || SECRET_NAME.test(name)
  );
}

function appendVersion(
  identifier: string,
  version: string | undefined,
  separator: "@" | "==" | ":",
): string {
  if (!version) return identifier;
  if (separator === "@" && /@[^/]+$/.test(identifier)) return identifier;
  if (separator === "==" && identifier.includes("==")) return identifier;
  if (
    separator === ":" &&
    (identifier.includes("@") || /:\w[^/]*$/.test(identifier))
  ) {
    return identifier;
  }
  return `${identifier}${separator}${version}`;
}

function looksOfficial(value: JsonObject): boolean {
  return Array.isArray(value.packages) || Array.isArray(value.remotes);
}

function looksLikeServer(value: JsonObject): boolean {
  return [
    "args",
    "arguments",
    "command",
    "serverUrl",
    "transport",
    "type",
    "url",
  ].some((key) => key in value);
}

function tidyName(value: string): string {
  return value.split("/").filter(Boolean).at(-1)?.trim() || value.trim();
}

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed || PLACEHOLDER.some((pattern) => pattern.test(trimmed));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readPrimitive(value: unknown): string | number | boolean | undefined {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? value
    : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNumberString(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
