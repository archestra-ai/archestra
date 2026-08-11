import type { archestraCatalogTypes } from "@archestra/shared";
import type { UseFormReturn } from "react-hook-form";
import { parseDockerArgsToLocalConfig } from "./docker-args-parser";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import { transformExternalCatalogToFormValues } from "./mcp-catalog-form.utils";

/**
 * Parses MCP server configurations pasted from the wild — READMEs, docs and
 * other MCP clients — and maps them onto the catalog form.
 *
 * Recognized shapes:
 * - Claude Desktop / Cursor / Smithery:  { "mcpServers": { "<name>": {...} } }
 * - VS Code / Copilot:                   { "servers": { "<name>": {...} }, "inputs": [...] }
 * - Official MCP registry server.json:   { "name", "packages": [...], "remotes": [...] }
 * - Archestra catalog manifest:          { "server": {...}, "user_config": {...} }
 * - A bare server object:                { "command", "args", "env" } or { "type", "url", "headers" }
 * - A bare JSON array of arguments:      ["-y", "@scope/server"]
 *
 * Placeholder values (`<token>`, `${input:id}`, `YOUR_..._HERE`) are never
 * imported literally — they become install-time prompts instead.
 */

export interface ImportedMcpServer {
  /** Server key in the pasted wrapper, or a derived display name. */
  key: string;
  values: McpCatalogFormValues;
  /** Anything that was skipped or needs the user's attention before saving. */
  warnings: string[];
}

export type McpConfigParseResult =
  | { status: "empty" }
  | { status: "invalid-json"; error: string }
  | { status: "unrecognized" }
  | { status: "args-array"; args: string[] }
  | {
      status: "servers";
      formatLabel: string;
      /** The matching export format when the pasted shape is one of them —
       * lets the dialog's format select follow a paste automatically. */
      format?: McpJsonExportFormat;
      servers: ImportedMcpServer[];
    };

export function parseMcpConfigText(text: string): McpConfigParseResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { status: "empty" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      status: "invalid-json",
      error: error instanceof Error ? error.message : "Invalid JSON",
    };
  }

  if (Array.isArray(parsed)) {
    if (
      parsed.length > 0 &&
      parsed.every(
        (item) => typeof item === "string" || typeof item === "number",
      )
    ) {
      return { status: "args-array", args: parsed.map(String) };
    }
    return { status: "unrecognized" };
  }

  if (!isRecord(parsed)) {
    return { status: "unrecognized" };
  }

  // Archestra's own catalog manifest — reuse the existing transformer.
  if (isArchestraManifest(parsed)) {
    try {
      const values = transformExternalCatalogToFormValues(
        parsed as unknown as archestraCatalogTypes.ArchestraMcpServerManifest,
      );
      return {
        status: "servers",
        // white-label-ok: names the vendor-defined manifest schema (a wire
        // format shared by every deployment), not this deployment's brand
        formatLabel: "Archestra catalog manifest",
        servers: [{ key: values.name, values, warnings: [] }],
      };
    } catch {
      return { status: "unrecognized" };
    }
  }

  const inputs = readInputDefinitions(parsed);

  if (isRecord(parsed.mcpServers)) {
    return buildServersResult(parsed.mcpServers, inputs, {
      formatLabel: "Claude Desktop / Cursor format",
      format: "mcpServers",
    });
  }

  if (isRecord(parsed.servers)) {
    return buildServersResult(parsed.servers, inputs, {
      formatLabel: "VS Code / Copilot format",
      format: "servers",
    });
  }

  if (isRegistryServerJson(parsed)) {
    return mapRegistryServer(parsed);
  }

  if (looksLikeServerEntry(parsed)) {
    return buildServersResult({ "": parsed }, inputs, {
      formatLabel: "MCP server object",
    });
  }

  // Wrapper without a marker key: { "github": { "command": ... } }
  const entries = Object.entries(parsed).filter(([key]) => key !== "inputs");
  if (
    entries.length > 0 &&
    entries.every(([, value]) => isRecord(value) && looksLikeServerEntry(value))
  ) {
    return buildServersResult(Object.fromEntries(entries), inputs, {
      formatLabel: "MCP server object",
    });
  }

  return { status: "unrecognized" };
}

/** Placeholder written for values that are requested at install time. */
export const PROMPTED_PLACEHOLDER = "<prompted-on-install>";
/** Placeholder written instead of a stored secret value — never the secret. */
export const SECRET_PLACEHOLDER = "<secret>";

/**
 * Output formats for the serialized connection config. Every entry is a
 * shape `parseMcpConfigText` recognizes, so exported text can always be
 * pasted back in — the export select and the import parser stay one
 * contract.
 */
export type McpJsonExportFormat = "mcpServers" | "servers" | "registry";

/**
 * The official registry schema this export targets — the same one live
 * registry.modelcontextprotocol.io entries carry in `$schema`.
 */
const REGISTRY_SCHEMA_URL =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

/**
 * Whether the connection config can be exported as an official registry
 * `server.json`. Remotes always can (`remotes`); local servers can when the
 * command matches a shape the registry's `packages` express — an npm run
 * (`npx`), a PyPI run (`uvx`), or a plain image reference. An arbitrary
 * command (`node server.js`) has no official package shape.
 */
export function canExportRegistryJson(values: McpCatalogFormValues): boolean {
  if (values.serverType === "remote") return true;
  return registryPackageFromLocalConfig(values) !== null;
}

/**
 * Whether the config can be exported as a VALID VS Code `mcp.json`. VS
 * Code's schema sets `additionalProperties: false` on server entries, so
 * the Archestra `dockerImage` extension key an image-based local needs is a
 * hard validation error there — remotes and command locals qualify.
 */
export function canExportServersJson(values: McpCatalogFormValues): boolean {
  if (values.serverType === "remote") return true;
  return !values.localConfig?.dockerImage;
}

export function mcpJsonExportFileName(
  format: McpJsonExportFormat,
  key: string,
): string {
  switch (format) {
    case "servers":
      // VS Code reads this file as `.vscode/mcp.json`.
      return "mcp.json";
    case "registry":
      return "server.json";
    default:
      return `${key}.mcp.json`;
  }
}

/**
 * Serializes form values into a portable JSON shape for the form's JSON
 * surfaces (default: the `mcpServers` wrapper). Secret values are replaced
 * with placeholders; applying the JSON back preserves the stored entries
 * (see applyImportedServerToForm). OAuth/enterprise auth and advanced
 * deployment settings are not represented.
 *
 * `options.storedSecretValues` is the hydrated secret bag in edit mode. Rows
 * are masked by value identity against it, not only by their current `type`:
 * flipping a stored secret row to plain text (unsaved) must not surface the
 * stored value here or in the clipboard.
 */
export function serializeFormValuesToMcpJson(
  values: McpCatalogFormValues,
  options?: {
    storedSecretValues?: Record<string, string>;
    format?: McpJsonExportFormat;
  },
): string {
  const storedSecretValueSet = new Set(
    Object.values(options?.storedSecretValues ?? {}).filter(
      (value) => value !== "",
    ),
  );
  const key = values.name?.trim() || "server";
  const entry: Record<string, unknown> = {};

  if (values.serverType === "remote") {
    entry.type = "http";
    entry.url = values.serverUrl ?? "";
    const headers: Record<string, string> = {};
    if (values.authMethod === "bearer") {
      const headerName = values.authHeaderName?.trim() || "Authorization";
      headers[headerName] = values.includeBearerPrefix
        ? `Bearer ${PROMPTED_PLACEHOLDER}`
        : PROMPTED_PLACEHOLDER;
    }
    for (const header of values.additionalHeaders ?? []) {
      // The wire header carries the Bearer prefix when the row opts in — the
      // JSON must too, or a round-trip silently changes what is sent
      // upstream (the Token-header auth method stores its Authorization
      // credential as exactly such a row).
      const bare = header.promptOnInstallation
        ? PROMPTED_PLACEHOLDER
        : (header.value ?? "");
      headers[header.headerName] = header.includeBearerPrefix
        ? `Bearer ${bare}`
        : bare;
    }
    if (Object.keys(headers).length > 0) {
      entry.headers = headers;
    }
  } else {
    const localConfig = values.localConfig;
    if (localConfig?.command) {
      entry.command = localConfig.command;
    }
    const args = (localConfig?.arguments ?? "")
      .split("\n")
      .map((argument) => argument.trim())
      .filter((argument) => argument.length > 0);
    if (args.length > 0) {
      entry.args = args;
    }
    const env: Record<string, string> = {};
    for (const envVar of localConfig?.environment ?? []) {
      // Mounted secret-file rows are k8s deployment config, not env vars —
      // they are outside the connection JSON contract (like envFrom).
      if (envVar.mounted) {
        continue;
      }
      if (envVar.promptOnInstallation) {
        env[envVar.key] = PROMPTED_PLACEHOLDER;
      } else if (
        envVar.type === "secret" ||
        (envVar.value != null && storedSecretValueSet.has(envVar.value))
      ) {
        env[envVar.key] = SECRET_PLACEHOLDER;
      } else {
        env[envVar.key] = envVar.value ?? "";
      }
    }
    if (Object.keys(env).length > 0) {
      entry.env = env;
    }
    if (localConfig?.dockerImage) {
      entry.dockerImage = localConfig.dockerImage;
    }
    // Streamable HTTP transport (with its port/path) is deliberately NOT
    // serialized: it is how the Archestra deployment exposes the server on
    // the MCP gateway — deployment configuration that lives in the form,
    // not part of the portable connection JSON.
  }

  const format = options?.format ?? "mcpServers";
  if (format === "registry" && canExportRegistryJson(values)) {
    return `${JSON.stringify(registryServerJsonDocument(values, key), null, 2)}\n`;
  }
  if (format === "servers") {
    // VS Code's mcp.json marks stdio servers explicitly; remote entries
    // already carry `type: "http"`.
    const vsCodeEntry =
      values.serverType === "local" ? { type: "stdio", ...entry } : entry;
    return `${JSON.stringify({ servers: { [key]: vsCodeEntry } }, null, 2)}\n`;
  }
  // "registry" for a config the registry format can't express falls back to
  // the default wrapper — the format select disables the option then (see
  // canExportRegistryJson).
  return `${JSON.stringify({ mcpServers: { [key]: entry } }, null, 2)}\n`;
}

/**
 * The official registry `server.json` document (see REGISTRY_SCHEMA_URL):
 * remotes for a remote server, a single `packages` entry for a local one.
 * `version` is a starting value and `name` is emitted as-is — publishing to
 * the registry additionally needs a `namespace/name` and a real release
 * version, which only the user can supply. Prompted/secret rows are emitted
 * valueless with `isSecret` so a re-import routes them back through the
 * install-time-prompt path; the registry shape has no Bearer-prefix concept,
 * so plain header rows fold the prefix into the value and prompted rows
 * drop it.
 */
function registryServerJsonDocument(
  values: McpCatalogFormValues,
  key: string,
): Record<string, unknown> {
  const document: Record<string, unknown> = {
    $schema: REGISTRY_SCHEMA_URL,
    name: key,
    // The schema REQUIRES a 1-100 char description — fall back to a
    // starting value (like `version` below) when the form has none yet.
    description: (values.description?.trim() || `${key} MCP server`).slice(
      0,
      100,
    ),
    version: "1.0.0",
  };

  if (values.serverType === "local") {
    const pkg = registryPackageFromLocalConfig(values);
    if (pkg) {
      document.packages = [pkg];
    }
    return document;
  }

  const headers: Record<string, unknown>[] = [];
  if (values.authMethod === "bearer") {
    headers.push({
      name: values.authHeaderName?.trim() || "Authorization",
      isSecret: true,
      isRequired: true,
    });
  }
  for (const header of values.additionalHeaders ?? []) {
    if (header.promptOnInstallation) {
      headers.push({
        name: header.headerName,
        isSecret: header.sensitive === true,
        isRequired: header.required === true,
        ...(header.description ? { description: header.description } : {}),
      });
    } else {
      const bare = header.value ?? "";
      headers.push({
        name: header.headerName,
        value: header.includeBearerPrefix ? `Bearer ${bare}` : bare,
      });
    }
  }

  const remote: Record<string, unknown> = {
    type: "streamable-http",
    url: values.serverUrl ?? "",
  };
  if (headers.length > 0) {
    remote.headers = headers;
  }
  document.remotes = [remote];
  return document;
}

/**
 * Maps a local config onto an official registry package entry, or null when
 * the command doesn't match a registry-expressible shape. The inverse of
 * mapRegistryPackage: `npx [-y] <pkg>` → npm, `uvx <pkg>` → pypi, a bare
 * image reference → oci. Leading `-y` is dropped (the importer re-adds it
 * for npm); trailing arguments become positional packageArguments.
 */
function registryPackageFromLocalConfig(
  values: McpCatalogFormValues,
): Record<string, unknown> | null {
  const localConfig = values.localConfig;
  if (!localConfig) return null;
  const command = localConfig.command?.trim() ?? "";
  const args = (localConfig.arguments ?? "")
    .split("\n")
    .map((argument) => argument.trim())
    .filter((argument) => argument.length > 0);

  let registryType: string;
  let runtimeHint: string | null = null;
  let identifier: string;
  let version: string | undefined;
  let packageArguments: string[];

  if (command === "npx" && !localConfig.dockerImage) {
    const rest = args[0] === "-y" ? args.slice(1) : args;
    const target = rest[0];
    if (!target || target.startsWith("-")) return null;
    registryType = "npm";
    runtimeHint = "npx";
    // Split a trailing @version, respecting @scope/name identifiers.
    const versionAt = target.indexOf("@", 1);
    identifier = versionAt > 0 ? target.slice(0, versionAt) : target;
    version = versionAt > 0 ? target.slice(versionAt + 1) : undefined;
    packageArguments = rest.slice(1);
  } else if (command === "uvx" && !localConfig.dockerImage) {
    const target = args[0];
    if (!target || target.startsWith("-")) return null;
    registryType = "pypi";
    runtimeHint = "uvx";
    const [name, pinnedVersion] = target.split("==");
    identifier = name;
    version = pinnedVersion || undefined;
    packageArguments = args.slice(1);
  } else if (!command && localConfig.dockerImage) {
    registryType = "oci";
    identifier = localConfig.dockerImage;
    packageArguments = args;
  } else {
    return null;
  }

  const environmentVariables: Record<string, unknown>[] = [];
  for (const envVar of localConfig.environment ?? []) {
    // Mounted secret-file rows are k8s deployment config, not env vars.
    if (envVar.mounted) continue;
    const isSecret = envVar.type === "secret";
    const row: Record<string, unknown> = { name: envVar.key };
    if (envVar.description) row.description = envVar.description;
    if (isSecret) row.isSecret = true;
    if (envVar.required || isSecret || envVar.promptOnInstallation) {
      row.isRequired = true;
    }
    if (!isSecret && !envVar.promptOnInstallation && envVar.value != null) {
      row.value = envVar.value;
    }
    environmentVariables.push(row);
  }

  const pkg: Record<string, unknown> = { registryType, identifier };
  if (version) pkg.version = version;
  if (runtimeHint) pkg.runtimeHint = runtimeHint;
  // Always stdio: Archestra's streamable-http transport (port/path) is how
  // the k8s deployment is exposed on the MCP gateway — deployment settings
  // that stay in the form and never enter the exported JSON. (The importer
  // still reads third-party packages that declare streamable-http.)
  pkg.transport = { type: "stdio" };
  if (packageArguments.length > 0) {
    pkg.packageArguments = packageArguments.map((value) => ({
      type: "positional",
      value,
    }));
  }
  if (environmentVariables.length > 0) {
    pkg.environmentVariables = environmentVariables;
  }
  return pkg;
}

/** Wraps a bare arguments array as a minimal self-hosted server import. */
export function importedServerFromArgsArray(args: string[]): ImportedMcpServer {
  const base = baseFormValues();
  return {
    key: "",
    warnings: [],
    values: {
      ...base,
      serverType: "local",
      localConfig: {
        ...(base.localConfig as NonNullable<
          McpCatalogFormValues["localConfig"]
        >),
        arguments: args.join("\n"),
      },
    },
  };
}

/**
 * Applies an imported server onto an existing form instance (smart paste).
 * Only configuration fields are written; name and description are filled only
 * when still empty, so a paste never clobbers what the user already typed.
 */
export function applyImportedServerToForm(params: {
  form: UseFormReturn<McpCatalogFormValues>;
  server: ImportedMcpServer;
  /** False when the server type is locked (edit mode). */
  allowServerTypeChange: boolean;
  /**
   * True when the deployment transport is someone's decision already — edit
   * mode, or a create form whose transport/port/path fields were touched.
   * Client config JSON cannot express Archestra's streamable-http gateway
   * transport, so a stdio-shaped paste says nothing about it: with the
   * transport configured, only an EXPLICIT streamable-http declaration (a
   * registry package transport, or a docker `--port` flag) writes transport
   * fields — a JSON round-trip can never flip a working deployment back to
   * stdio. On an untouched create form the paste is DEFINING the server, so
   * its transport (stdio included) applies: a pasted npx README snippet
   * must not silently deploy as streamable-http just because that is the
   * form default.
   */
  transportConfigured: boolean;
}): { applied: true } | { applied: false; reason: string } {
  const { form, server, allowServerTypeChange, transportConfigured } = params;
  const values = server.values;
  const currentServerType = form.getValues("serverType");

  if (!allowServerTypeChange && values.serverType !== currentServerType) {
    return {
      applied: false,
      reason:
        values.serverType === "remote"
          ? "The pasted config describes a remote server, but this server is self-hosted."
          : "The pasted config describes a self-hosted server, but this server is remote.",
    };
  }

  const dirtyOption = { shouldDirty: true } as const;

  if (allowServerTypeChange) {
    form.setValue("serverType", values.serverType, dirtyOption);
  }

  if (values.serverType === "remote") {
    form.setValue("serverUrl", values.serverUrl ?? "", dirtyOption);
    // Only touch auth fields when the pasted config carries header-derived
    // auth. A config without headers says nothing about auth, and OAuth or
    // enterprise-managed setups are not representable in this JSON at all —
    // wiping them to "none" on paste would silently destroy configuration.
    if (values.authMethod !== "none") {
      form.setValue("authMethod", values.authMethod, dirtyOption);
      form.setValue(
        "includeBearerPrefix",
        values.includeBearerPrefix,
        dirtyOption,
      );
      form.setValue("authHeaderName", values.authHeaderName ?? "", dirtyOption);
    }
    if (
      values.authMethod !== "none" ||
      (values.additionalHeaders?.length ?? 0) > 0
    ) {
      // Like the env merge below: a prompted (placeholder-derived) header row
      // whose name already exists on the form keeps the existing row — its
      // stored field name, required flag, and description survive a JSON
      // round-trip instead of being regenerated (which would read as a
      // breaking header change and force reinstalls).
      const existingHeaders = form.getValues("additionalHeaders") ?? [];
      const existingByName = new Map(
        existingHeaders.map((header) => [
          header.headerName.toLowerCase(),
          header,
        ]),
      );
      const mergedHeaders = (values.additionalHeaders ?? []).map((header) => {
        const existing = existingByName.get(header.headerName.toLowerCase());
        return header.promptOnInstallation && existing ? existing : header;
      });
      form.setValue("additionalHeaders", mergedHeaders, dirtyOption);
    }
  } else if (values.localConfig) {
    // Set the environment array through its exact path so the form's
    // useFieldArray instance over localConfig.environment picks it up.
    form.setValue(
      "localConfig.command",
      values.localConfig.command,
      dirtyOption,
    );
    form.setValue(
      "localConfig.arguments",
      values.localConfig.arguments,
      dirtyOption,
    );
    // A placeholder-derived (prompted) entry whose key already exists on the
    // form keeps the existing entry: placeholders mark "value not included",
    // so a paste or JSON round-trip never downgrades a stored secret.
    const existingEnv = form.getValues("localConfig.environment") ?? [];
    const existingByKey = new Map(existingEnv.map((env) => [env.key, env]));
    // Mounted secret-file rows live outside the JSON contract: they are never
    // serialized, so an applied JSON must never delete them either. They pass
    // through untouched (and win over an incoming plain entry with the same
    // key, so a paste can't silently downgrade a stored file to an env var).
    const mountedRows = existingEnv.filter((env) => env.mounted);
    const mountedKeys = new Set(mountedRows.map((env) => env.key));
    const mergedEnvironment = values.localConfig.environment
      .filter((env) => !mountedKeys.has(env.key))
      .map((env) => {
        const existing = existingByKey.get(env.key);
        return env.promptOnInstallation && existing ? existing : env;
      });
    form.setValue(
      "localConfig.environment",
      [...mergedEnvironment, ...mountedRows],
      dirtyOption,
    );
    form.setValue(
      "localConfig.dockerImage",
      values.localConfig.dockerImage ?? "",
      dirtyOption,
    );
    // See the transportConfigured doc above for the full decision matrix.
    // Port and path are only ever written when the paste actually carried
    // them (a parsed transport url or docker --port flag) — never guessed
    // defaults over configured values.
    const importedTransport = values.localConfig.transportType ?? "stdio";
    if (!transportConfigured || importedTransport === "streamable-http") {
      form.setValue(
        "localConfig.transportType",
        importedTransport,
        dirtyOption,
      );
      if (values.localConfig.httpPort) {
        form.setValue(
          "localConfig.httpPort",
          values.localConfig.httpPort,
          dirtyOption,
        );
      }
      if (values.localConfig.httpPath) {
        form.setValue(
          "localConfig.httpPath",
          values.localConfig.httpPath,
          dirtyOption,
        );
      }
    }
  }

  if (!form.getValues("name")?.trim() && values.name) {
    form.setValue("name", values.name, dirtyOption);
  }
  if (!form.getValues("description")?.trim() && values.description) {
    form.setValue("description", values.description, dirtyOption);
  }

  return { applied: true };
}

// =========================================================================
// Internal helpers
// =========================================================================

interface InputDefinition {
  id: string;
  description: string;
  password: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is string | number =>
        typeof item === "string" || typeof item === "number",
    )
    .map(String);
}

// VS Code-style `inputs` block: install-time prompt definitions.
function readInputDefinitions(
  parsed: Record<string, unknown>,
): Map<string, InputDefinition> {
  const inputs = new Map<string, InputDefinition>();
  if (!Array.isArray(parsed.inputs)) return inputs;
  for (const entry of parsed.inputs) {
    if (!isRecord(entry)) continue;
    const id = readString(entry, "id");
    if (!id) continue;
    inputs.set(id, {
      id,
      description: readString(entry, "description") ?? "",
      password: entry.password === true,
    });
  }
  return inputs;
}

function isArchestraManifest(parsed: Record<string, unknown>): boolean {
  return isRecord(parsed.server) && typeof parsed.server.type === "string";
}

function isRegistryServerJson(parsed: Record<string, unknown>): boolean {
  return (
    typeof parsed.name === "string" &&
    (Array.isArray(parsed.remotes) || Array.isArray(parsed.packages))
  );
}

function looksLikeServerEntry(value: Record<string, unknown>): boolean {
  if (typeof value.command === "string" && value.command.length > 0) {
    return true;
  }
  if (typeof value.url === "string" && value.url.length > 0) {
    return true;
  }
  // Archestra's own extension key: an image-only entry has no command or
  // url, and the parser must recognize the serializer's own output.
  if (typeof value.dockerImage === "string" && value.dockerImage.length > 0) {
    return true;
  }
  return false;
}

function buildServersResult(
  serversRecord: Record<string, unknown>,
  inputs: Map<string, InputDefinition>,
  formatInfo: { formatLabel: string; format?: McpJsonExportFormat },
): McpConfigParseResult {
  const servers: ImportedMcpServer[] = [];
  for (const [key, entry] of Object.entries(serversRecord)) {
    if (!isRecord(entry) || !looksLikeServerEntry(entry)) continue;
    servers.push(mapServerEntry(key, entry, inputs));
  }
  if (servers.length === 0) {
    return { status: "unrecognized" };
  }
  return { status: "servers", ...formatInfo, servers };
}

function mapServerEntry(
  key: string,
  entry: Record<string, unknown>,
  inputs: Map<string, InputDefinition>,
): ImportedMcpServer {
  const warnings: string[] = [];
  const url = readString(entry, "url");
  const command = readString(entry, "command");
  const typeRaw = readString(entry, "type")?.toLowerCase();
  const isRemote = Boolean(url) && typeRaw !== "stdio";

  if (isRemote && url) {
    const headerAuth = mapHeaders(
      isRecord(entry.headers) ? entry.headers : {},
      inputs,
      warnings,
    );
    if (typeRaw === "sse") {
      warnings.push(
        "SSE transport was imported as a remote server URL; confirm the server supports it.",
      );
    }
    return {
      key: key || deriveNameFromUrl(url),
      warnings,
      values: {
        ...baseFormValues(),
        name: key || deriveNameFromUrl(url),
        serverType: "remote",
        serverUrl: url,
        ...headerAuth,
      },
    };
  }

  const rawArgs = readStringArray(entry.args);
  const envRecord = isRecord(entry.env) ? entry.env : {};

  // Archestra extension key, produced by the JSON view's serializer so an
  // image-based config round-trips (standard formats have no equivalent).
  const explicitDockerImage = readString(entry, "dockerImage") ?? "";

  // `docker run …` configs run as native pods here: the image is referenced
  // directly and `-e KEY` passthrough flags become environment variables.
  const dockerImage =
    command === "docker" ? extractDockerImage(rawArgs) : undefined;
  const docker =
    command && dockerImage
      ? parseDockerArgsToLocalConfig(command, rawArgs, dockerImage)
      : null;

  const environment = Object.entries(envRecord).map(([envKey, envValue]) =>
    mapEnvVar(envKey, envValue, inputs),
  );
  if (docker) {
    for (const passthroughKey of extractDockerEnvPassthroughKeys(rawArgs)) {
      if (!environment.some((env) => env.key === passthroughKey)) {
        environment.push(mapEnvVar(passthroughKey, "", inputs));
      }
    }
  }

  const argumentsList = docker ? (docker.arguments ?? []) : rawArgs;
  const placeholderArgs = argumentsList.filter((arg) =>
    isPlaceholderValue(arg),
  );
  if (placeholderArgs.length > 0) {
    warnings.push(
      `Replace the placeholder argument${placeholderArgs.length === 1 ? "" : "s"} ${placeholderArgs.join(", ")} with real values before saving.`,
    );
  }

  return {
    key: key || command || "",
    warnings,
    values: {
      ...baseFormValues(),
      name: key,
      serverType: "local",
      localConfig: {
        command: docker ? (docker.command ?? "") : (command ?? ""),
        arguments: argumentsList.join("\n"),
        environment,
        envFrom: [],
        dockerImage: docker?.dockerImage ?? explicitDockerImage,
        // Transport stays stdio unless the container's own `--port` flag
        // (after the image) says the server itself speaks HTTP: client
        // config formats have no field for Archestra's streamable-http
        // deployment transport, so a paste says nothing about it.
        transportType: docker?.transportType ?? "stdio",
        httpPort: docker?.httpPort?.toString() ?? "",
        httpPath: "",
        serviceAccount: "",
        imagePullSecrets: [],
      },
    },
  };
}

type EnvironmentEntry = NonNullable<
  McpCatalogFormValues["localConfig"]
>["environment"][number];

function mapEnvVar(
  key: string,
  rawValue: unknown,
  inputs: Map<string, InputDefinition>,
): EnvironmentEntry {
  if (typeof rawValue === "boolean" || typeof rawValue === "number") {
    return {
      key,
      type: typeof rawValue === "boolean" ? "boolean" : "number",
      value: String(rawValue),
      promptOnInstallation: false,
      required: false,
      description: "",
    };
  }

  const value = typeof rawValue === "string" ? rawValue : "";
  const input = matchInputReference(value, inputs);
  if (input || isPlaceholderValue(value)) {
    const sensitive = input ? input.password : looksSensitiveKey(key);
    return {
      key,
      type: sensitive ? "secret" : "plain_text",
      value: undefined,
      promptOnInstallation: true,
      required: true,
      description: input?.description ?? "",
    };
  }

  return {
    key,
    type: looksSensitiveKey(key) ? "secret" : "plain_text",
    value,
    promptOnInstallation: false,
    required: false,
    description: "",
  };
}

type HeaderAuthFields = Pick<
  McpCatalogFormValues,
  "authMethod" | "includeBearerPrefix" | "authHeaderName" | "additionalHeaders"
>;

function mapHeaders(
  headers: Record<string, unknown>,
  inputs: Map<string, InputDefinition>,
  warnings: string[],
): HeaderAuthFields {
  const result: HeaderAuthFields = {
    authMethod: "none",
    includeBearerPrefix: true,
    authHeaderName: "",
    additionalHeaders: [],
  };

  for (const [name, rawValue] of Object.entries(headers)) {
    const value = typeof rawValue === "string" ? rawValue : String(rawValue);
    // A `Bearer ` prefix is transport dressing, not part of the credential:
    // strip it into the row's includeBearerPrefix flag so the wire header
    // round-trips exactly.
    const hasBearerPrefix = /^Bearer\s+/i.test(value);
    const bare = hasBearerPrefix ? value.replace(/^Bearer\s+/i, "") : value;
    const input = matchInputReference(bare, inputs);

    if (name.toLowerCase() === "authorization") {
      // Maps to the modern Token-header auth method (never the legacy raw
      // bearer method): the credential is a prompted Authorization row.
      result.authMethod = "auth_header";
      result.additionalHeaders?.push({
        headerName: name,
        promptOnInstallation: true,
        required: true,
        value: undefined,
        description: input?.description ?? "",
        includeBearerPrefix: hasBearerPrefix,
        sensitive: true,
      });
      if (!input && !isPlaceholderValue(bare)) {
        warnings.push(
          "The Authorization token is not imported — it will be requested when the server is installed.",
        );
      }
      continue;
    }

    if (input || isPlaceholderValue(bare)) {
      result.additionalHeaders?.push({
        headerName: name,
        promptOnInstallation: true,
        required: true,
        value: undefined,
        description: input?.description ?? "",
        includeBearerPrefix: hasBearerPrefix,
        sensitive: input ? input.password : looksSensitiveKey(name),
      });
    } else {
      result.additionalHeaders?.push({
        headerName: name,
        promptOnInstallation: false,
        required: false,
        value: bare,
        description: "",
        includeBearerPrefix: hasBearerPrefix,
        sensitive: false,
      });
    }
  }

  return result;
}

// ————— Official MCP registry server.json —————

// The registry has shipped both camelCase and snake_case field names.
function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function mapRegistryServer(
  parsed: Record<string, unknown>,
): McpConfigParseResult {
  const fullName = readString(parsed, "name") ?? "";
  const shortName = fullName.split("/").pop() ?? fullName;
  const description = readString(parsed, "description") ?? "";
  const servers: ImportedMcpServer[] = [];

  const remotes = Array.isArray(parsed.remotes) ? parsed.remotes : [];
  for (const remote of remotes) {
    if (!isRecord(remote)) continue;
    const url = readString(remote, "url");
    if (!url) continue;
    const warnings: string[] = [];
    const headerAuth = mapRegistryHeaders(pick(remote, "headers"), warnings);
    servers.push({
      key: remotes.length > 1 ? `${shortName} (${url})` : shortName,
      warnings,
      values: {
        ...baseFormValues(),
        name: shortName,
        description,
        serverType: "remote",
        serverUrl: url,
        ...headerAuth,
      },
    });
  }

  const packages = Array.isArray(parsed.packages) ? parsed.packages : [];
  for (const pkg of packages) {
    if (!isRecord(pkg)) continue;
    const mapped = mapRegistryPackage(pkg, shortName, description);
    if (mapped) {
      servers.push(
        packages.length > 1 || remotes.length > 0
          ? { ...mapped, key: `${mapped.key} (${registryTypeOf(pkg)})` }
          : mapped,
      );
    }
  }

  if (servers.length === 0) {
    return { status: "unrecognized" };
  }
  return {
    status: "servers",
    formatLabel: "MCP registry server.json",
    format: "registry",
    servers,
  };
}

function registryTypeOf(pkg: Record<string, unknown>): string {
  const value = pick(pkg, "registryType", "registry_type", "registry_name");
  return typeof value === "string" ? value : "package";
}

function mapRegistryPackage(
  pkg: Record<string, unknown>,
  shortName: string,
  description: string,
): ImportedMcpServer | null {
  const identifier =
    readString(pkg, "identifier") ?? readString(pkg, "name") ?? "";
  if (!identifier) return null;
  const registryType = registryTypeOf(pkg).toLowerCase();
  const version = readString(pkg, "version");
  const warnings: string[] = [];

  let command = "";
  let dockerImage = "";
  const args: string[] = [];
  if (registryType === "npm") {
    command = "npx";
    args.push("-y", version ? `${identifier}@${version}` : identifier);
  } else if (registryType === "pypi") {
    command = "uvx";
    args.push(version ? `${identifier}==${version}` : identifier);
  } else if (registryType === "oci" || registryType === "docker") {
    dockerImage = identifier;
  } else {
    warnings.push(
      `Unsupported package registry "${registryType}" — review the command before saving.`,
    );
    command = identifier;
  }

  for (const argList of [
    pick(pkg, "runtimeArguments", "runtime_arguments"),
    pick(pkg, "packageArguments", "package_arguments"),
  ]) {
    if (!Array.isArray(argList)) continue;
    for (const arg of argList) {
      if (!isRecord(arg)) continue;
      args.push(...flattenRegistryArgument(arg, warnings));
    }
  }

  const environment: EnvironmentEntry[] = [];
  const envVars = pick(pkg, "environmentVariables", "environment_variables");
  if (Array.isArray(envVars)) {
    for (const envVar of envVars) {
      if (!isRecord(envVar)) continue;
      const key = readString(envVar, "name");
      if (!key) continue;
      const isSecret = pick(envVar, "isSecret", "is_secret") === true;
      const isRequired = pick(envVar, "isRequired", "is_required") === true;
      const literal = readString(envVar, "value");
      const fallback = readString(envVar, "default");
      const concrete =
        literal && !isPlaceholderValue(literal) ? literal : fallback;
      environment.push({
        key,
        type: isSecret ? "secret" : "plain_text",
        value: isSecret ? undefined : concrete,
        promptOnInstallation: isSecret || (isRequired && !concrete),
        required: isRequired,
        description: readString(envVar, "description") ?? "",
      });
    }
  }

  // Official package entries carry a transport object; anything other than
  // an explicit streamable-http declaration runs as stdio here. The
  // transport url (required by the official schema) carries port and path;
  // both stay empty unless the url actually declared them, so applying the
  // import never overwrites configured values with guessed defaults.
  const transport = pick(pkg, "transport");
  let transportType: "stdio" | "streamable-http" = "stdio";
  let httpPort = "";
  let httpPath = "";
  if (
    isRecord(transport) &&
    readString(transport, "type") === "streamable-http"
  ) {
    transportType = "streamable-http";
    const transportUrl = readString(transport, "url");
    if (transportUrl) {
      try {
        const parsedUrl = new URL(transportUrl);
        if (parsedUrl.port) httpPort = parsedUrl.port;
        if (parsedUrl.pathname && parsedUrl.pathname !== "/") {
          httpPath = parsedUrl.pathname;
        }
      } catch {
        // Template-style urls (e.g. with {port} variables) stay unparsed —
        // the defaults hold.
      }
    }
  }

  return {
    key: shortName,
    warnings,
    values: {
      ...baseFormValues(),
      name: shortName,
      description,
      serverType: "local",
      localConfig: {
        command,
        arguments: args.join("\n"),
        environment,
        envFrom: [],
        dockerImage,
        transportType,
        httpPort,
        httpPath,
        serviceAccount: "",
        imagePullSecrets: [],
      },
    },
  };
}

function flattenRegistryArgument(
  arg: Record<string, unknown>,
  warnings: string[],
): string[] {
  const type = readString(arg, "type");
  const value = readString(arg, "value") ?? readString(arg, "valueHint");
  const name = readString(arg, "name");
  if (type === "named" && name) {
    if (value && !isPlaceholderValue(value)) return [name, value];
    if (pick(arg, "isRequired", "is_required") === true) {
      warnings.push(
        `The argument "${name}" needs a value — fill it in before saving.`,
      );
      return [name];
    }
    return [name];
  }
  if (value) {
    if (isPlaceholderValue(value)) {
      warnings.push(
        `Replace the placeholder argument ${value} with a real value before saving.`,
      );
    }
    return [value];
  }
  return [];
}

function mapRegistryHeaders(
  headers: unknown,
  warnings: string[],
): HeaderAuthFields {
  // Registry headers are an array of { name, value?, isSecret?, isRequired?,
  // description? } — normalize to the flat record shape and reuse mapHeaders.
  const record: Record<string, unknown> = {};
  const inputs = new Map<string, InputDefinition>();
  if (Array.isArray(headers)) {
    for (const header of headers) {
      if (!isRecord(header)) continue;
      const name = readString(header, "name");
      if (!name) continue;
      const isSecret = pick(header, "isSecret", "is_secret") === true;
      const value = readString(header, "value");
      if (isSecret || !value) {
        // Route secret/valueless headers through the placeholder path so they
        // become install-time prompts.
        const inputId = `header:${name}`;
        inputs.set(inputId, {
          id: inputId,
          description: readString(header, "description") ?? "",
          password: isSecret,
        });
        record[name] = `\${input:${inputId}}`;
      } else {
        record[name] = value;
      }
    }
  }
  return mapHeaders(record, inputs, warnings);
}

// ————— docker run parsing —————

// `docker run` flags that consume the following token, so the image detection
// does not mistake their values for the image name.
const DOCKER_VALUE_FLAGS = new Set([
  "-e",
  "--env",
  "--env-file",
  "-v",
  "--volume",
  "--mount",
  "-p",
  "--publish",
  "--name",
  "--network",
  "--entrypoint",
  "-w",
  "--workdir",
  "-u",
  "--user",
  "-l",
  "--label",
  "--add-host",
  "--platform",
  "--pull",
]);

function extractDockerImage(args: string[]): string | undefined {
  let index = 0;
  if (args[index] === "run") index += 1;
  while (index < args.length) {
    const token = args[index];
    if (token.startsWith("-")) {
      // `--flag=value` carries its value inline; bare value flags consume the
      // next token.
      if (!token.includes("=") && DOCKER_VALUE_FLAGS.has(token)) {
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    return token;
  }
  return undefined;
}

// `-e KEY` (no `=`) forwards a host env var: surface it as a field to fill in.
function extractDockerEnvPassthroughKeys(args: string[]): string[] {
  const keys: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === "-e" || args[index] === "--env") {
      const value = args[index + 1];
      if (value && !value.includes("=") && !value.startsWith("-")) {
        keys.push(value);
      }
    }
  }
  return keys;
}

// ————— placeholder heuristics —————

function matchInputReference(
  value: string,
  inputs: Map<string, InputDefinition>,
): InputDefinition | undefined {
  const match = value.match(/\$\{input:([^}]+)\}/);
  if (!match) return undefined;
  const id = match[1];
  return (
    inputs.get(id) ?? {
      id,
      description: "",
      password: looksSensitiveKey(id),
    }
  );
}

// An empty string counts as a placeholder ON PURPOSE: in pasted configs an
// empty env value overwhelmingly means "fill this in", so it becomes an
// install-time prompt rather than a stored empty string. Someone who truly
// wants ENV_VAR="" sets it in the form after applying.
function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^<[^<>]+>$/.test(trimmed)) return true;
  if (/^\$\{[^}]+\}$/.test(trimmed)) return true;
  if (/^(YOUR|ENTER|INSERT|PASTE)[-_]/i.test(trimmed)) return true;
  if (/[-_]HERE$/i.test(trimmed)) return true;
  if (
    /^(CHANGEME|CHANGE[-_]ME|REPLACE[-_]?ME|TODO|PLACEHOLDER|x{3,}|\.{3})$/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  return false;
}

function looksSensitiveKey(key: string): boolean {
  return /token|secret|passw|api[-_]?key|credential|private[-_]?key|auth/i.test(
    key,
  );
}

function deriveNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// The neutral scaffold IMPORTED values are built on. Deliberately NOT the
// create form's defaultValues (mcp-catalog-form.tsx): the form defaults to
// streamable-http as the deployment transport, while a parsed config is
// stdio unless it explicitly declares otherwise — sharing one constant
// would let one purpose silently corrupt the other. Structural fields
// (oauthConfig shape etc.) must be kept in sync with the form's defaults.
function baseFormValues(): McpCatalogFormValues {
  return {
    name: "",
    description: "",
    icon: null,
    serverType: "remote",
    multitenant: false,
    serverUrl: "",
    authMethod: "none",
    includeBearerPrefix: true,
    authHeaderName: "",
    additionalHeaders: [],
    enterpriseManagedConfig: null,
    oauthConfig: {
      client_id: "",
      client_secret: "",
      audience: "",
      resource: "",
      redirect_uris:
        typeof window !== "undefined"
          ? `${window.location.origin}/oauth-callback`
          : "",
      scopes: "read, write",
      additional_scopes: "offline_access",
      supports_resource_metadata: true,
      grantType: "authorization_code",
      authServerUrl: "",
      authorizationEndpoint: "",
      wellKnownUrl: "",
      resourceMetadataUrl: "",
      tokenEndpoint: "",
    },
    localConfig: {
      command: "",
      arguments: "",
      environment: [],
      envFrom: [],
      dockerImage: "",
      transportType: "stdio",
      httpPort: "",
      httpPath: "/mcp",
      serviceAccount: "",
      imagePullSecrets: [],
    },
    scope: "personal",
    teams: [],
    environmentId: null,
  } as McpCatalogFormValues;
}
