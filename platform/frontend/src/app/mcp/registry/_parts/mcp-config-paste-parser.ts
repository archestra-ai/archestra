import type { archestraCatalogTypes } from "@archestra/shared";
import { parseDockerArgsToLocalConfig } from "./docker-args-parser";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import { transformExternalCatalogToFormValues } from "./mcp-catalog-form.utils";

/**
 * Parses an MCP server configuration pasted from the wild (docs, READMEs,
 * registries) into the catalog form's value shape, so a user can copy a config
 * and have the form fields populated without manual retyping.
 *
 * Supported formats:
 *  - "vscode"         VS Code / Copilot: { servers: {...}, inputs: [...] } with ${input:id} refs
 *  - "claude_desktop" Claude Desktop / Smithery: { mcpServers: {...} } or a bare { name: {...} } map
 *  - "mcp_registry"   Official MCP registry server.json: { packages: [...], remotes: [...] }
 *  - "archestra"      Archestra's own manifest (delegated to transformExternalCatalogToFormValues)
 */

export type McpConfigFormat =
  | "vscode"
  | "claude_desktop"
  | "mcp_registry"
  | "archestra";

export interface DetectedUserInput {
  source: "env" | "header" | "input";
  key: string;
  description?: string;
  sensitive: boolean;
  required: boolean;
}

export interface ParsedMcpConfigResult {
  format: McpConfigFormat;
  serverName?: string;
  values: Partial<McpCatalogFormValues>;
  detectedUserInputs: DetectedUserInput[];
  /**
   * Number of servers present in the pasted config. The form imports the first
   * one; anything > 1 means others were skipped and the UI should say so.
   */
  serverCount: number;
}

type EnvironmentVariable = NonNullable<
  McpCatalogFormValues["localConfig"]
>["environment"][number];
type AdditionalHeader = NonNullable<
  McpCatalogFormValues["additionalHeaders"]
>[number];

// A format-agnostic intermediate representation produced by each format reader.
interface NormalizedServer {
  name?: string;
  description?: string;
  command?: string;
  args?: string[];
  env?: Array<{ key: string; raw: string }>;
  url?: string;
  transport?: string;
  headers?: Array<{ name: string; raw: string }>;
}

interface InputDefinition {
  description?: string;
  password?: boolean;
}

// ---------------------------------------------------------------------------
// Small type guards (biome forbids `any`; everything narrows from `unknown`).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) =>
    typeof item === "string" ? item : String(item ?? ""),
  );
}

// ---------------------------------------------------------------------------
// Value heuristics.
// ---------------------------------------------------------------------------

const INPUT_REF_REGEX = /\$\{input:([^}]+)\}/;

/**
 * A value the config author left for the user to fill in, e.g. "<token>",
 * "<YOUR_TOKEN>", "YOUR_TOKEN_HERE", or a "${...}" template placeholder.
 */
function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  // Real placeholders are short tokens; bound length so the patterns below can
  // never backtrack on a large pasted value.
  if (trimmed.length > 256) return false;
  if (/^<[^>]+>$/.test(trimmed)) return true;
  if (/^\$\{[^}]+\}$/.test(trimmed)) return true;
  if (/^(YOUR|MY|INSERT|ENTER|REPLACE|ADD|PUT)[_-]/i.test(trimmed)) return true;
  if (/[_-]HERE$/i.test(trimmed)) return true;
  return false;
}

/** Whether an env/header key name implies a secret (only used to pick the type). */
function isSecretKey(key: string): boolean {
  return /(TOKEN|SECRET|PASSWORD|PASSWD|_KEY|APIKEY|API_KEY|CREDENTIAL|PRIVATE|PAT|ACCESS_KEY|AUTH)/i.test(
    key,
  );
}

function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function normalizeTransportType(
  transport: string | undefined,
  hasUrl: boolean,
): "stdio" | "streamable-http" {
  if (!transport) return hasUrl ? "streamable-http" : "stdio";
  const t = transport.toLowerCase();
  if (t === "stdio") return "stdio";
  // http, streamable-http, streamable_http, sse, ... all map to streamable-http
  return "streamable-http";
}

// ---------------------------------------------------------------------------
// Field conversion (env / headers -> form shape + detected user inputs).
// ---------------------------------------------------------------------------

function convertEnv(
  key: string,
  rawValue: string,
  inputDefs: Record<string, InputDefinition>,
  detected: DetectedUserInput[],
): EnvironmentVariable {
  const value = stripSurroundingQuotes(rawValue);
  const refMatch = value.match(INPUT_REF_REGEX);

  if (refMatch) {
    const def = inputDefs[refMatch[1]];
    const sensitive = def?.password ?? isSecretKey(key);
    detected.push({
      source: "input",
      key,
      description: def?.description,
      sensitive,
      required: true,
    });
    return {
      key,
      type: sensitive ? "secret" : "plain_text",
      value: "",
      promptOnInstallation: true,
      required: true,
      description: def?.description ?? "",
    };
  }

  if (isPlaceholderValue(value)) {
    const sensitive = isSecretKey(key);
    detected.push({ source: "env", key, sensitive, required: true });
    return {
      key,
      type: sensitive ? "secret" : "plain_text",
      value: "",
      promptOnInstallation: true,
      required: true,
      description: "",
    };
  }

  // Concrete value the author committed. Still type secret-named keys as
  // "secret" so the value is masked rather than shown in plain text.
  return {
    key,
    type: isSecretKey(key) ? "secret" : "plain_text",
    value,
    promptOnInstallation: false,
    required: false,
    description: "",
  };
}

const HEADER_NAME_REGEX = /^[A-Za-z0-9-]+$/;

function convertHeader(
  name: string,
  rawValue: string,
  inputDefs: Record<string, InputDefinition>,
  detected: DetectedUserInput[],
): AdditionalHeader | null {
  if (!HEADER_NAME_REGEX.test(name)) return null;

  let value = stripSurroundingQuotes(rawValue);
  let includeBearerPrefix = false;
  if (/^Bearer\s+/i.test(value)) {
    includeBearerPrefix = true;
    value = value.replace(/^Bearer\s+/i, "");
  }

  const refMatch = value.match(INPUT_REF_REGEX);
  if (refMatch) {
    const def = inputDefs[refMatch[1]];
    const sensitive = def?.password ?? true;
    detected.push({
      source: "header",
      key: name,
      description: def?.description,
      sensitive,
      required: true,
    });
    return {
      headerName: name,
      value: "",
      promptOnInstallation: true,
      required: true,
      sensitive,
      includeBearerPrefix,
      description: def?.description ?? "",
    };
  }

  if (isPlaceholderValue(value)) {
    const sensitive = isSecretKey(name) || includeBearerPrefix;
    detected.push({ source: "header", key: name, sensitive, required: true });
    return {
      headerName: name,
      value: "",
      promptOnInstallation: true,
      required: true,
      sensitive,
      includeBearerPrefix,
      description: "",
    };
  }

  // Concrete header value. Mask secret-named or bearer headers even though the
  // value is committed, so it is not displayed in plain text.
  return {
    headerName: name,
    value,
    promptOnInstallation: false,
    required: false,
    sensitive: isSecretKey(name) || includeBearerPrefix,
    includeBearerPrefix,
    description: "",
  };
}

// ---------------------------------------------------------------------------
// NormalizedServer -> form values.
// ---------------------------------------------------------------------------

const DOCKER_VALUE_FLAGS = new Set([
  "-e",
  "--env",
  "-v",
  "--volume",
  "-p",
  "--publish",
  "--name",
  "-w",
  "--workdir",
  "--mount",
  "--network",
  "-u",
  "--user",
]);

/** Best-effort guess of the image name in a `docker run ...` arg list. */
function guessDockerImage(args: string[]): string | undefined {
  let i = args.indexOf("run");
  i = i === -1 ? 0 : i + 1;
  for (; i < args.length; i++) {
    const token = args[i];
    if (token.startsWith("-")) {
      if (DOCKER_VALUE_FLAGS.has(token) && !token.includes("=")) i++;
      continue;
    }
    return token;
  }
  return undefined;
}

function serverToFormValues(
  server: NormalizedServer,
  inputDefs: Record<string, InputDefinition>,
): { values: Partial<McpCatalogFormValues>; detected: DetectedUserInput[] } {
  const detected: DetectedUserInput[] = [];

  const environment: EnvironmentVariable[] = (server.env ?? []).map((e) =>
    convertEnv(e.key, e.raw, inputDefs, detected),
  );

  const seenHeaders = new Set<string>();
  const additionalHeaders: AdditionalHeader[] = [];
  for (const h of server.headers ?? []) {
    const header = convertHeader(h.name, h.raw, inputDefs, detected);
    if (!header) continue;
    const dedupeKey = header.headerName.toLowerCase();
    if (seenHeaders.has(dedupeKey)) continue;
    seenHeaders.add(dedupeKey);
    additionalHeaders.push(header);
  }

  const base: Partial<McpCatalogFormValues> = {};
  if (server.name) base.name = server.name;
  if (server.description) base.description = server.description;
  if (additionalHeaders.length > 0) base.additionalHeaders = additionalHeaders;

  const isLocal = Boolean(server.command) && !server.url;

  if (!isLocal && server.url) {
    return {
      values: {
        ...base,
        serverType: "remote",
        serverUrl: server.url,
      },
      detected,
    };
  }

  // Local server.
  const args = server.args ?? [];
  let command = server.command ?? "";
  let argString = args.join("\n");
  let dockerImage = "";
  let transportType = normalizeTransportType(server.transport, false);
  let httpPort = "";

  if (command === "docker") {
    const image = guessDockerImage(args);
    const docker = image
      ? parseDockerArgsToLocalConfig("docker", args, image)
      : null;
    if (docker) {
      command = docker.command ?? "";
      argString = (docker.arguments ?? []).join("\n");
      dockerImage = docker.dockerImage;
      if (docker.transportType) transportType = docker.transportType;
      if (typeof docker.httpPort === "number")
        httpPort = String(docker.httpPort);
    }
  }

  return {
    values: {
      ...base,
      serverType: "local",
      localConfig: {
        command,
        arguments: argString,
        environment,
        envFrom: [],
        dockerImage,
        transportType,
        httpPort,
        httpPath: "/mcp",
        serviceAccount: "",
        imagePullSecrets: [],
      },
    },
    detected,
  };
}

// ---------------------------------------------------------------------------
// Per-format readers (raw object -> NormalizedServer + input defs).
// ---------------------------------------------------------------------------

function readEnvRecord(
  envValue: unknown,
): Array<{ key: string; raw: string }> | undefined {
  if (!isRecord(envValue)) return undefined;
  return Object.entries(envValue).map(([key, value]) => ({
    key,
    raw: typeof value === "string" ? value : String(value ?? ""),
  }));
}

function readHeaderRecord(
  headersValue: unknown,
): Array<{ name: string; raw: string }> | undefined {
  if (!isRecord(headersValue)) return undefined;
  return Object.entries(headersValue).map(([name, value]) => ({
    name,
    raw: typeof value === "string" ? value : String(value ?? ""),
  }));
}

function readSingleServer(record: Record<string, unknown>): NormalizedServer {
  return {
    name: asString(record.name),
    description: asString(record.description),
    command: asString(record.command),
    args: asStringArray(record.args),
    env: readEnvRecord(record.env) ?? readEnvRecord(record.environment),
    url: asString(record.url),
    transport: asString(record.type) ?? asString(record.transport),
    headers: readHeaderRecord(record.headers),
  };
}

/** Pick the first server from a name->server map, attaching its name. */
function firstServerFromMap(
  map: Record<string, unknown>,
): NormalizedServer | null {
  for (const [name, value] of Object.entries(map)) {
    if (!isRecord(value)) continue;
    const server = readSingleServer(value);
    if (!server.name) server.name = name;
    return server;
  }
  return null;
}

/** Count the server entries (object values) in a name->server map. */
function countServersInMap(map: Record<string, unknown>): number {
  return Object.values(map).filter(isRecord).length;
}

function readVscodeInputs(inputs: unknown): Record<string, InputDefinition> {
  const defs: Record<string, InputDefinition> = {};
  if (!Array.isArray(inputs)) return defs;
  for (const item of inputs) {
    if (!isRecord(item)) continue;
    const id = asString(item.id);
    if (!id) continue;
    defs[id] = {
      description: asString(item.description),
      password: typeof item.password === "boolean" ? item.password : undefined,
    };
  }
  return defs;
}

// ---------------------------------------------------------------------------
// MCP registry (server.json) reader.
// ---------------------------------------------------------------------------

const REGISTRY_RUNNERS: Record<string, { command: string; flags: string[] }> = {
  npm: { command: "npx", flags: ["-y"] },
  pypi: { command: "uvx", flags: [] },
  nuget: { command: "dnx", flags: [] },
};

function readRegistryArguments(value: unknown): { args: string[] } {
  const args: string[] = [];
  if (!Array.isArray(value)) return { args };
  for (const item of value) {
    if (!isRecord(item)) continue;
    const type = asString(item.type);
    const name = asString(item.name);
    const val =
      asString(item.value) ??
      asString(item.valueHint) ??
      asString(item.default);
    if (type === "named" && name) {
      args.push(name);
      if (val) args.push(val);
    } else if (val) {
      args.push(val);
    }
  }
  return { args };
}

function readRegistryEnv(
  value: unknown,
  detected: DetectedUserInput[],
): EnvironmentVariable[] {
  const out: EnvironmentVariable[] = [];
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const key = asString(item.name);
    if (!key) continue;
    const provided = asString(item.value);
    const sensitive = item.isSecret === true || isSecretKey(key);
    const required = item.isRequired === true;
    const description = asString(item.description) ?? "";
    if (provided && !isPlaceholderValue(provided)) {
      out.push({
        key,
        type: sensitive ? "secret" : "plain_text",
        value: provided,
        promptOnInstallation: false,
        required: false,
        description,
      });
    } else {
      detected.push({ source: "env", key, description, sensitive, required });
      out.push({
        key,
        type: sensitive ? "secret" : "plain_text",
        value: "",
        promptOnInstallation: true,
        required,
        description,
      });
    }
  }
  return out;
}

/** Build a header from a registry `remotes[].headers[]` entry. */
function registryHeader(
  entry: Record<string, unknown>,
  detected: DetectedUserInput[],
): AdditionalHeader | null {
  const headerName = asString(entry.name);
  if (!headerName || !HEADER_NAME_REGEX.test(headerName)) return null;

  const provided = asString(entry.value);
  const sensitive = entry.isSecret === true || isSecretKey(headerName);

  if (provided && !isPlaceholderValue(provided)) {
    return {
      headerName,
      value: provided,
      promptOnInstallation: false,
      required: false,
      sensitive,
      includeBearerPrefix: false,
      description: "",
    };
  }

  detected.push({
    source: "header",
    key: headerName,
    sensitive,
    required: entry.isRequired === true,
  });
  return {
    headerName,
    value: "",
    promptOnInstallation: true,
    required: true,
    sensitive,
    includeBearerPrefix: false,
    description: "",
  };
}

/** A registry `server.json` `remotes[0]` -> a remote form config. */
function parseRegistryRemote(
  remote: Record<string, unknown>,
  name: string | undefined,
): ParsedMcpConfigResult | null {
  const url = asString(remote.url);
  if (!url) return null;

  const detected: DetectedUserInput[] = [];
  const seen = new Set<string>();
  const headers: AdditionalHeader[] = [];
  if (Array.isArray(remote.headers)) {
    for (const h of remote.headers) {
      if (!isRecord(h)) continue;
      const header = registryHeader(h, detected);
      if (!header) continue;
      const dedupeKey = header.headerName.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      headers.push(header);
    }
  }

  const values: Partial<McpCatalogFormValues> = {
    serverType: "remote",
    serverUrl: url,
  };
  if (name) values.name = name;
  if (headers.length > 0) values.additionalHeaders = headers;
  return {
    format: "mcp_registry",
    serverName: name,
    values,
    detectedUserInputs: detected,
    serverCount: 1,
  };
}

/** A registry `server.json` `packages[0]` -> a local form config. */
function parseRegistryPackage(
  pkg: Record<string, unknown>,
  name: string | undefined,
): ParsedMcpConfigResult {
  const detected: DetectedUserInput[] = [];
  const registryType = (
    asString(pkg.registryType) ??
    asString(pkg.registry_type) ??
    asString(pkg.registry_name) ??
    ""
  ).toLowerCase();
  const identifier = asString(pkg.identifier) ?? asString(pkg.name) ?? "";
  const version = asString(pkg.version);
  const ref = version ? `${identifier}@${version}` : identifier;

  const environment = readRegistryEnv(pkg.environmentVariables, detected);
  const runtimeArgs = readRegistryArguments(pkg.runtimeArguments).args;
  const packageArgs = readRegistryArguments(pkg.packageArguments).args;

  let command: string;
  let args: string[];
  let dockerImage = "";
  if (registryType === "oci" || registryType === "docker") {
    command = "docker";
    args = ["run", "-i", "--rm", ...runtimeArgs, ref, ...packageArgs];
    dockerImage = identifier;
  } else {
    const runner = REGISTRY_RUNNERS[registryType];
    command = runner?.command ?? registryType ?? "npx";
    args = [...(runner?.flags ?? []), ...runtimeArgs, ref, ...packageArgs];
  }

  const transportRecord = isRecord(pkg.transport) ? pkg.transport : undefined;
  const transportType = normalizeTransportType(
    transportRecord ? asString(transportRecord.type) : undefined,
    false,
  );

  const values: Partial<McpCatalogFormValues> = {
    serverType: "local",
    localConfig: {
      command,
      arguments: args.join("\n"),
      environment,
      envFrom: [],
      dockerImage,
      transportType,
      httpPort: "",
      httpPath: "/mcp",
      serviceAccount: "",
      imagePullSecrets: [],
    },
  };
  if (name) values.name = name;
  return {
    format: "mcp_registry",
    serverName: name,
    values,
    detectedUserInputs: detected,
    serverCount: 1,
  };
}

function parseRegistry(
  obj: Record<string, unknown>,
): ParsedMcpConfigResult | null {
  const name = asString(obj.name);

  // Prefer a remote endpoint when present.
  const remotes = obj.remotes;
  if (Array.isArray(remotes) && remotes.length > 0 && isRecord(remotes[0])) {
    const result = parseRegistryRemote(remotes[0], name);
    if (result) return result;
  }

  // Otherwise build a local server from the first package.
  const packages = obj.packages;
  if (Array.isArray(packages) && packages.length > 0 && isRecord(packages[0])) {
    return parseRegistryPackage(packages[0], name);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Archestra manifest reader (delegates to the existing transform).
// ---------------------------------------------------------------------------

function looksLikeArchestraManifest(obj: Record<string, unknown>): boolean {
  return (
    "user_config" in obj ||
    "oauth_config" in obj ||
    "archestra_config" in obj ||
    "display_name" in obj ||
    "last_scraped_at" in obj
  );
}

function parseArchestra(
  obj: Record<string, unknown>,
): ParsedMcpConfigResult | null {
  if (!isRecord(obj.server)) return null;
  try {
    const manifest =
      obj as unknown as archestraCatalogTypes.ArchestraMcpServerManifest;
    const values = transformExternalCatalogToFormValues(manifest);
    return {
      format: "archestra",
      serverName: asString(obj.name) ?? asString(obj.display_name),
      values,
      detectedUserInputs: [],
      serverCount: 1,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export function parseMcpServerConfig(
  raw: string,
): ParsedMcpConfigResult | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  // 1. Archestra's own manifest.
  if (looksLikeArchestraManifest(parsed)) {
    const result = parseArchestra(parsed);
    if (result) return result;
  }

  // 2. Official MCP registry server.json.
  if (Array.isArray(parsed.packages) || Array.isArray(parsed.remotes)) {
    const result = parseRegistry(parsed);
    if (result) return result;
  }

  // 3. VS Code / Copilot: { servers: {...}, inputs: [...] }.
  if (isRecord(parsed.servers) || Array.isArray(parsed.inputs)) {
    const inputDefs = readVscodeInputs(parsed.inputs);
    const map = isRecord(parsed.servers) ? parsed.servers : {};
    const server = firstServerFromMap(map);
    if (server) {
      const { values, detected } = serverToFormValues(server, inputDefs);
      return {
        format: "vscode",
        serverName: server.name,
        values,
        detectedUserInputs: detected,
        serverCount: countServersInMap(map),
      };
    }
  }

  // 4. Claude Desktop / Smithery: { mcpServers: {...} }.
  if (isRecord(parsed.mcpServers)) {
    const server = firstServerFromMap(parsed.mcpServers);
    if (server) {
      const { values, detected } = serverToFormValues(server, {});
      return {
        format: "claude_desktop",
        serverName: server.name,
        values,
        detectedUserInputs: detected,
        serverCount: countServersInMap(parsed.mcpServers),
      };
    }
  }

  // 5. A bare single server object, e.g. { command, args, env } or { url }.
  if (typeof parsed.command === "string" || typeof parsed.url === "string") {
    const server = readSingleServer(parsed);
    const { values, detected } = serverToFormValues(server, {});
    return {
      format: "claude_desktop",
      serverName: server.name,
      values,
      detectedUserInputs: detected,
      serverCount: 1,
    };
  }

  // 6. A bare name->server map without a wrapper key, e.g. { "sonarqube": {...} }.
  const server = firstServerFromMap(parsed);
  if (server && (server.command || server.url)) {
    const { values, detected } = serverToFormValues(server, {});
    return {
      format: "claude_desktop",
      serverName: server.name,
      values,
      detectedUserInputs: detected,
      serverCount: countServersInMap(parsed),
    };
  }

  return null;
}
