/**
 * Parse copy-pasted MCP server config JSON into form-ready local/remote fields.
 *
 * Supported shapes (from catalogs / Claude Desktop / VS Code / docs):
 *  - `{ "servers": { "<name>": { command, args, env } } }`
 *  - `{ "mcpServers": { "<name>": { ... } } }`
 *  - `{ "servers": { "<name>": { type: "http"|"sse", url, headers } } }`
 *  - bare single server: `{ command, args, env }` / `{ dockerImage, ... }`
 *  - named map without wrapper: `{ "sonarqube": { command, args, env } }`
 *
 * Non-JSON / unrecognized shapes return null so callers keep plain
 * "one argument per line" behavior.
 */

export type ParsedEnvVar = {
  key: string;
  type: "plain_text" | "secret" | "boolean" | "number";
  value?: string;
  promptOnInstallation: boolean;
  required?: boolean;
  description?: string;
};

export type ParsedHeader = {
  headerName: string;
  value?: string;
  promptOnInstallation: boolean;
  required: boolean;
  sensitive?: boolean;
  includeBearerPrefix?: boolean;
  description?: string;
};

export type ParsedMcpConfig = {
  /** Name of the first server entry when a map was pasted. */
  name?: string;
  serverType: "local" | "remote";
  /** Local command (form: localConfig.command). */
  command?: string;
  /** Newline-separated arguments string (form: localConfig.arguments). */
  arguments?: string;
  environment?: ParsedEnvVar[];
  dockerImage?: string;
  transportType?: "stdio" | "streamable-http";
  httpPort?: string;
  httpPath?: string;
  /** Remote server URL (form: serverUrl). */
  serverUrl?: string;
  /** Remote auth/extra headers. */
  headers?: ParsedHeader[];
};

const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;

function looksLikePlaceholder(value: string): boolean {
  return (
    value === "" ||
    value === "***" ||
    /^\$\{input:/i.test(value) ||
    /^YOUR[_-]/i.test(value) ||
    /^<.*>$/.test(value) ||
    /placeholder/i.test(value) ||
    /^REDACTED$/i.test(value)
  );
}

function looksLikeSecretKey(key: string): boolean {
  const k = key.toUpperCase();
  return (
    k.includes("TOKEN") ||
    k.includes("SECRET") ||
    k.includes("PASSWORD") ||
    k.includes("API_KEY") ||
    k.includes("APIKEY") ||
    k.includes("PAT") ||
    k.includes("AUTH") ||
    k.includes("CREDENTIAL") ||
    k.includes("PRIVATE")
  );
}

function looksLikeSecret(key: string, value: string): boolean {
  return looksLikeSecretKey(key) || looksLikePlaceholder(value);
}

function argsToLines(args: unknown): string | undefined {
  if (Array.isArray(args)) {
    return args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join("\n");
  }
  if (typeof args === "string") return args;
  return undefined;
}

function parseEnv(envRaw: unknown): ParsedEnvVar[] | undefined {
  if (!envRaw) return undefined;

  if (typeof envRaw === "object" && !Array.isArray(envRaw)) {
    const envs: ParsedEnvVar[] = [];
    for (const [k, v] of Object.entries(envRaw as Record<string, unknown>)) {
      if (!ENV_VAR_RE.test(k)) continue;
      const value =
        typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
      const secret = looksLikeSecret(k, value);
      const placeholder = looksLikePlaceholder(value);
      envs.push({
        key: k,
        type: secret ? "secret" : "plain_text",
        value: secret && placeholder ? undefined : value,
        promptOnInstallation: secret && placeholder,
        required: secret,
      });
    }
    return envs.length ? envs : undefined;
  }

  if (Array.isArray(envRaw)) {
    const envs: ParsedEnvVar[] = [];
    for (const item of envRaw as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      const key = String(e.key ?? e.name ?? "");
      if (!ENV_VAR_RE.test(key)) continue;
      const value =
        typeof e.value === "string"
          ? e.value
          : e.value == null
            ? ""
            : JSON.stringify(e.value);
      const secret = e.type === "secret" || looksLikeSecret(key, value);
      const placeholder = looksLikePlaceholder(value);
      envs.push({
        key,
        type: secret ? "secret" : "plain_text",
        value: secret && placeholder ? undefined : value,
        promptOnInstallation:
          typeof e.promptOnInstallation === "boolean"
            ? e.promptOnInstallation
            : secret && placeholder,
        required:
          typeof e.required === "boolean" ? e.required : secret || undefined,
        description:
          typeof e.description === "string" ? e.description : undefined,
      });
    }
    return envs.length ? envs : undefined;
  }

  return undefined;
}

function parseHeaders(headersRaw: unknown): ParsedHeader[] | undefined {
  if (!headersRaw || typeof headersRaw !== "object" || Array.isArray(headersRaw)) {
    return undefined;
  }
  const headers: ParsedHeader[] = [];
  for (const [name, raw] of Object.entries(
    headersRaw as Record<string, unknown>,
  )) {
    if (!HEADER_NAME_RE.test(name)) continue;
    const value =
      typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw);
    let cleaned = value;
    let includeBearerPrefix: boolean | undefined;
    if (/^Bearer\s+/i.test(value)) {
      includeBearerPrefix = true;
      cleaned = value.replace(/^Bearer\s+/i, "");
    }
    const placeholder =
      looksLikePlaceholder(value) || looksLikePlaceholder(cleaned);
    const sensitive =
      looksLikeSecretKey(name) ||
      /bearer|token|secret|password|authorization/i.test(name) ||
      placeholder;
    headers.push({
      headerName: name,
      value: placeholder ? undefined : cleaned,
      promptOnInstallation: placeholder || sensitive,
      required: true,
      sensitive,
      includeBearerPrefix,
    });
  }
  return headers.length ? headers : undefined;
}

/**
 * Extract docker image + container command/args from a `docker run ...` args list.
 * Mirrors the spirit of the frontend docker-args-parser without requiring the
 * image to be known ahead of time.
 */
function parseDockerRunArgs(args: string[]): {
  dockerImage?: string;
  command?: string;
  arguments?: string;
} {
  // Skip docker CLI flags until we hit a non-flag token that is not a flag value.
  // Keep this list aligned with common `docker run` options that take a separate
  // value; anything missing here would be mis-read as the image name.
  const flagWithValue = new Set([
    "-e",
    "--env",
    "--env-file",
    "-v",
    "--volume",
    "-p",
    "--publish",
    "-u",
    "--user",
    "-w",
    "--workdir",
    "--name",
    "--network",
    "--entrypoint",
    "--platform",
    "-m",
    "--memory",
    "--memory-reservation",
    "--memory-swap",
    "--cpus",
    "--cpu-shares",
    "--cpuset-cpus",
    "--cpuset-mems",
    "--label",
    "-l",
    "--cidfile",
    "--hostname",
    "-h",
    "--add-host",
    "--device",
    "--gpus",
    "--runtime",
    "--security-opt",
    "--storage-opt",
    "--sysctl",
    "--tmpfs",
    "--ulimit",
    "--group-add",
    "--ip",
    "--ip6",
    "--mac-address",
    "--shm-size",
    "--stop-signal",
    "--stop-timeout",
    "--restart",
    "--log-driver",
    "--log-opt",
    "--network-alias",
    "--pull",
    "--cgroup-parent",
    "--cgroupns",
    "--blkio-weight",
    "--blkio-weight-device",
    "--device-read-bps",
    "--device-read-iops",
    "--device-write-bps",
    "--device-write-iops",
    "--pids-limit",
  ]);

  let i = 0;
  // optional leading "run"
  if (args[i] === "run") i++;

  while (i < args.length) {
    const tok = args[i];
    if (tok === "--") {
      i++;
      break;
    }
    if (tok.startsWith("-")) {
      const eqIdx = tok.indexOf("=");
      if (eqIdx > 0) {
        i++;
        continue;
      }
      // short flags that take a value may be glued (-eVAR=val) or separate
      const base = tok.includes("=") ? tok : tok;
      if (flagWithValue.has(base) || /^-[epuvwml]$/.test(base)) {
        i += 2;
        continue;
      }
      // boolean-ish flags: -i, -t, -it, --rm, --init, --pull=always already handled
      i++;
      continue;
    }
    break;
  }

  if (i >= args.length) return {};
  const dockerImage = args[i];
  const rest = args.slice(i + 1);
  if (rest.length === 0) return { dockerImage };
  if (rest[0].startsWith("-")) {
    return { dockerImage, arguments: rest.join("\n") };
  }
  return {
    dockerImage,
    command: rest[0],
    arguments: rest.length > 1 ? rest.slice(1).join("\n") : undefined,
  };
}

function isServerConfig(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return Boolean(
    c.command ||
      c.dockerImage ||
      c.args ||
      c.arguments ||
      c.env ||
      c.environment ||
      c.url ||
      c.serverUrl ||
      c.type === "http" ||
      c.type === "sse" ||
      c.type === "stdio" ||
      c.transportType ||
      c.headers,
  );
}

function unwrapServerEntry(
  json: Record<string, unknown>,
): { name?: string; cfg: Record<string, unknown> } | null {
  for (const key of ["servers", "mcpServers"] as const) {
    const map = json[key];
    if (map && typeof map === "object" && !Array.isArray(map)) {
      const firstKey = Object.keys(map as Record<string, unknown>)[0];
      if (firstKey) {
        const cfg = (map as Record<string, unknown>)[firstKey];
        if (cfg && typeof cfg === "object") {
          return { name: firstKey, cfg: cfg as Record<string, unknown> };
        }
      }
    }
  }

  // bare single server
  if (isServerConfig(json)) {
    return { cfg: json };
  }

  // named map without wrapper: { "sonarqube": { command, args, env } }
  const keys = Object.keys(json);
  if (keys.length > 0 && keys.every((k) => isServerConfig(json[k]))) {
    const firstKey = keys[0];
    return {
      name: firstKey,
      cfg: json[firstKey] as Record<string, unknown>,
    };
  }

  return null;
}

function parseSingleServer(
  name: string | undefined,
  c: Record<string, unknown>,
): ParsedMcpConfig | null {
  const type = c.type;
  const url =
    typeof c.url === "string"
      ? c.url
      : typeof c.serverUrl === "string"
        ? c.serverUrl
        : undefined;

  // Remote / HTTP-style configs
  if (
    type === "http" ||
    type === "sse" ||
    (url && !c.command && !c.dockerImage && !c.args)
  ) {
    const headers = parseHeaders(c.headers);
    return {
      name,
      serverType: "remote",
      serverUrl: url,
      headers,
      transportType: "streamable-http",
    };
  }

  const result: ParsedMcpConfig = {
    name,
    serverType: "local",
  };

  if (typeof c.command === "string") result.command = c.command;
  if (typeof c.dockerImage === "string") result.dockerImage = c.dockerImage;

  const argsRaw = c.args ?? c.arguments;
  const argLines = argsToLines(argsRaw);
  if (argLines !== undefined) result.arguments = argLines;

  // docker run expansion
  if (result.command === "docker" && Array.isArray(argsRaw)) {
    const docker = parseDockerRunArgs(argsRaw.map(String));
    if (docker.dockerImage) {
      result.dockerImage = docker.dockerImage;
      result.command = docker.command;
      result.arguments = docker.arguments;
    }
  }

  const environment = parseEnv(c.env ?? c.environment);
  if (environment) result.environment = environment;

  if (c.transportType === "stdio" || c.transportType === "streamable-http") {
    result.transportType = c.transportType;
  } else if (type === "stdio") {
    result.transportType = "stdio";
  } else if (type === "http" || type === "sse") {
    result.transportType = "streamable-http";
  }

  if (typeof c.httpPort === "number" || typeof c.httpPort === "string") {
    result.httpPort = String(c.httpPort);
  }
  if (typeof c.httpPath === "string") result.httpPath = c.httpPath;

  // meaningful local config?
  if (
    !result.command &&
    !result.dockerImage &&
    !result.arguments &&
    !result.environment
  ) {
    return null;
  }

  return result;
}

/**
 * Try to parse raw textarea / clipboard content as an MCP JSON config.
 * Returns null if not valid JSON or not a known config shape.
 */
export function parseMcpJsonInput(raw: string): ParsedMcpConfig | null {
  if (!raw || raw.trim().length === 0) return null;

  let json: unknown;
  try {
    json = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;

  const unwrapped = unwrapServerEntry(json as Record<string, unknown>);
  if (!unwrapped) return null;
  return parseSingleServer(unwrapped.name, unwrapped.cfg);
}

export function argumentsToLines(
  args: string[] | string | undefined,
): string {
  if (!args) return "";
  if (Array.isArray(args)) return args.join("\n");
  return args;
}
