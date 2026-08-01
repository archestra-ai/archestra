type JsonObject = Record<string, unknown>;

interface ImportedEnvironmentVariable {
  key: string;
  type: "plain_text" | "secret";
  value?: string;
  promptOnInstallation: boolean;
  required: boolean;
  description: string;
}

interface ImportedHeader {
  fieldName?: string;
  headerName: string;
  promptOnInstallation: boolean;
  required: boolean;
  value?: string;
  description: string;
  includeBearerPrefix: boolean;
  sensitive: boolean;
}

interface ImportedMcpConfig {
  name?: string;
  description?: string;
  serverType: "local" | "remote";
  serverUrl?: string;
  command?: string;
  arguments: string;
  dockerImage?: string;
  environment: ImportedEnvironmentVariable[];
  additionalHeaders: ImportedHeader[];
  authMethod: "none" | "bearer";
  includeBearerPrefix: boolean;
}

/** Accept both the historical one-argument-per-line form and JSON arrays. */
export function parseMcpArguments(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed
        .map(stringifyScalar)
        .filter((argument): argument is string => argument !== undefined);
    }
  } catch {
    // A normal newline-delimited value is not JSON and remains supported.
  }

  return value
    .split("\n")
    .map((argument) => argument.trim())
    .filter(Boolean);
}

export function parseMcpConfigJson(value: string): ImportedMcpConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("The pasted configuration is not valid JSON.");
  }
  if (!isObject(parsed)) {
    throw new Error("The MCP configuration must be a JSON object.");
  }

  const { config, inferredName } = selectServerConfig(parsed);
  const inputs = getInputDefinitions(parsed.inputs);
  const manifest =
    isObject(parsed.server) &&
    ("packages" in parsed.server || "remotes" in parsed.server)
      ? parsed.server
      : parsed;
  const name =
    inferredName ??
    optionalString(parsed.title) ??
    optionalString(config.title) ??
    optionalString(parsed.name) ??
    optionalString(config.name);
  const description =
    optionalString(parsed.description) ?? optionalString(config.description);

  const remote = Array.isArray(manifest.remotes)
    ? manifest.remotes.find(isObject)
    : undefined;
  const remoteUrl =
    optionalString(remote?.url) ??
    optionalString(config.url) ??
    optionalString(config.serverUrl);
  const headers = parseHeaders(remote?.headers ?? config.headers, inputs);

  if (remoteUrl) {
    return {
      name,
      description,
      serverType: "remote",
      serverUrl: remoteUrl,
      arguments: "",
      environment: [],
      ...headers,
    };
  }

  const packageConfig = packageToLocalConfig(manifest.packages);
  const command = optionalString(config.command) ?? packageConfig?.command;
  const dockerImage =
    optionalString(config.docker_image) ??
    optionalString(config.dockerImage) ??
    packageConfig?.dockerImage;

  if (!command && !dockerImage && config.type !== "local") {
    throw new Error(
      "The JSON does not contain a remote URL, local command, or supported package.",
    );
  }

  const environment = environmentFromObject({
    env: config.env,
    inputDefinitions: inputs,
    userConfig: parsed.user_config,
  });
  const firstPackage = Array.isArray(manifest.packages)
    ? manifest.packages.find(isObject)
    : undefined;
  const declared = declaredEnvironmentVariables([manifest, firstPackage]);
  const environmentByKey = new Map(
    [...environment, ...declared].map((entry) => [entry.key, entry]),
  );

  return {
    name,
    description,
    serverType: "local",
    command,
    arguments:
      normalizeArguments(config.args ?? config.arguments) ||
      packageConfig?.arguments ||
      "",
    dockerImage,
    environment: [...environmentByKey.values()],
    additionalHeaders: [],
    authMethod: "none",
    includeBearerPrefix: true,
  };
}

interface InputDefinition {
  id: string;
  description: string;
  password: boolean;
}

const INPUT_PLACEHOLDER = /^\$\{input:([^}]+)\}$/;
const USER_CONFIG_PLACEHOLDER = /^\$\{user_config\.([^}]+)\}$/;
const GENERIC_PLACEHOLDER =
  /^(?:<[^>]+>|YOUR_[A-Z0-9_]+(?:_HERE)?|REPLACE_ME)$/i;
const SENSITIVE_NAME = /(?:authorization|api[_-]?key|password|secret|token)/i;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function stringifyScalar(value: unknown): string | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return undefined;
}

function getInputDefinitions(value: unknown): Map<string, InputDefinition> {
  const definitions = new Map<string, InputDefinition>();
  if (!Array.isArray(value)) return definitions;

  for (const input of value) {
    if (!isObject(input) || typeof input.id !== "string") continue;
    definitions.set(input.id, {
      id: input.id,
      description: optionalString(input.description) ?? "",
      password: input.password === true,
    });
  }
  return definitions;
}

function getPlaceholder(value: string): string | undefined {
  return value.match(INPUT_PLACEHOLDER)?.[1];
}

function isPlaceholder(value: string): boolean {
  return (
    INPUT_PLACEHOLDER.test(value) ||
    USER_CONFIG_PLACEHOLDER.test(value) ||
    GENERIC_PLACEHOLDER.test(value)
  );
}

function normalizeArguments(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map(stringifyScalar)
      .filter((argument): argument is string => argument !== undefined)
      .join("\n");
  }
  return typeof value === "string" ? value : "";
}

function selectServerConfig(root: JsonObject): {
  config: JsonObject;
  inferredName?: string;
} {
  for (const containerKey of ["mcpServers", "servers"]) {
    const container = root[containerKey];
    if (!isObject(container)) continue;
    const entry = Object.entries(container).find(([, value]) =>
      isObject(value),
    );
    if (entry && isObject(entry[1])) {
      return { config: entry[1], inferredName: entry[0] };
    }
  }

  if (isObject(root.server)) {
    return {
      config: root.server,
      inferredName: optionalString(root.title) ?? optionalString(root.name),
    };
  }

  if (
    "command" in root ||
    "url" in root ||
    "serverUrl" in root ||
    "remotes" in root ||
    "packages" in root
  ) {
    return { config: root };
  }

  const entry = Object.entries(root).find(([, value]) => {
    if (!isObject(value)) return false;
    return (
      "command" in value ||
      "url" in value ||
      "serverUrl" in value ||
      "type" in value
    );
  });
  if (entry && isObject(entry[1])) {
    return { config: entry[1], inferredName: entry[0] };
  }

  throw new Error("No MCP server configuration was found in this JSON.");
}

function environmentFromObject(params: {
  env: unknown;
  inputDefinitions: Map<string, InputDefinition>;
  userConfig: unknown;
}): ImportedEnvironmentVariable[] {
  const { env, inputDefinitions, userConfig } = params;
  if (!isObject(env)) return [];
  const userConfigObject = isObject(userConfig) ? userConfig : {};

  return Object.entries(env).map(([key, rawValue]) => {
    const value = stringifyScalar(rawValue) ?? "";
    const inputId = getPlaceholder(value);
    const userConfigId = value.match(USER_CONFIG_PLACEHOLDER)?.[1];
    const input = inputId ? inputDefinitions.get(inputId) : undefined;
    const config =
      userConfigId && isObject(userConfigObject[userConfigId])
        ? userConfigObject[userConfigId]
        : undefined;
    const placeholder = isPlaceholder(value);
    const sensitive =
      input?.password === true ||
      config?.sensitive === true ||
      SENSITIVE_NAME.test(key);

    return {
      key,
      type: sensitive ? "secret" : "plain_text",
      value: placeholder ? "" : value,
      promptOnInstallation: placeholder,
      required: placeholder ? config?.required !== false : false,
      description:
        input?.description ?? optionalString(config?.description) ?? "",
    };
  });
}

function declaredEnvironmentVariables(
  sources: unknown[],
): ImportedEnvironmentVariable[] {
  const raw = sources.flatMap((source) => {
    if (!isObject(source)) return [];
    const declarations =
      source.environmentVariables ?? source.environment_variables;
    return Array.isArray(declarations) ? declarations : [];
  });

  return raw.flatMap((entry) => {
    if (!isObject(entry)) return [];
    const key = optionalString(entry.name);
    if (!key) return [];
    return [
      {
        key,
        type:
          entry.isSecret === true || entry.is_secret === true
            ? ("secret" as const)
            : ("plain_text" as const),
        value: "",
        promptOnInstallation: true,
        required: entry.isRequired === true || entry.is_required === true,
        description: optionalString(entry.description) ?? "",
      },
    ];
  });
}

function parseHeaders(
  headers: unknown,
  inputDefinitions: Map<string, InputDefinition>,
): {
  additionalHeaders: ImportedHeader[];
  authMethod: "none" | "bearer";
  includeBearerPrefix: boolean;
} {
  const normalized: Array<{
    name: string;
    value: string;
    description: string;
    required: boolean;
    secret: boolean;
  }> = [];

  if (isObject(headers)) {
    for (const [name, rawValue] of Object.entries(headers)) {
      normalized.push({
        name,
        value: stringifyScalar(rawValue) ?? "",
        description: "",
        required: true,
        secret: SENSITIVE_NAME.test(name),
      });
    }
  } else if (Array.isArray(headers)) {
    for (const header of headers) {
      if (!isObject(header)) continue;
      const name = optionalString(header.name);
      if (!name) continue;
      normalized.push({
        name,
        value: stringifyScalar(header.value) ?? "",
        description: optionalString(header.description) ?? "",
        required: header.isRequired !== false,
        secret: header.isSecret === true || SENSITIVE_NAME.test(name),
      });
    }
  }

  let authMethod: "none" | "bearer" = "none";
  let includeBearerPrefix = true;
  const additionalHeaders: ImportedHeader[] = [];

  for (const header of normalized) {
    if (header.name.toLowerCase() === "authorization") {
      authMethod = "bearer";
      includeBearerPrefix = /^bearer\s/i.test(header.value) || !header.value;
      continue;
    }

    const inputId = getPlaceholder(header.value);
    const input = inputId ? inputDefinitions.get(inputId) : undefined;
    const placeholder = !header.value || isPlaceholder(header.value);
    additionalHeaders.push({
      headerName: header.name,
      promptOnInstallation: placeholder,
      required: header.required,
      value: placeholder ? "" : header.value,
      description: input?.description ?? header.description,
      includeBearerPrefix: false,
      sensitive: header.secret || input?.password === true,
    });
  }

  return { additionalHeaders, authMethod, includeBearerPrefix };
}

function packageToLocalConfig(packages: unknown): {
  command?: string;
  arguments: string;
  dockerImage?: string;
} | null {
  if (!Array.isArray(packages) || !isObject(packages[0])) return null;
  const pkg = packages[0];
  const registryType = optionalString(pkg.registryType)?.toLowerCase();
  const identifier = optionalString(pkg.identifier);
  if (!identifier) return null;
  const version = optionalString(pkg.version);
  const specifier = version ? `${identifier}@${version}` : identifier;

  if (registryType === "npm") {
    return { command: "npx", arguments: `-y\n${specifier}` };
  }
  if (registryType === "pypi") {
    return {
      command: "uvx",
      arguments: version ? `${identifier}==${version}` : identifier,
    };
  }
  if (registryType === "oci" || registryType === "docker") {
    return {
      arguments: "",
      dockerImage: version ? `${identifier}:${version}` : identifier,
    };
  }
  return { command: identifier, arguments: "" };
}
