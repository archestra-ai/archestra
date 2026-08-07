import type {
  archestraApiTypes,
  archestraCatalogTypes,
} from "@archestra/shared";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

export interface CatalogDuplicateMatch {
  item: CatalogItem;
  /** Human-readable ground for the match, e.g. "same server URL". */
  reason: string;
}

/**
 * Finds a registry entry the in-progress create form is duplicating, from
 * whatever attributable data exists so far. Connection identity (URL,
 * command line, image) outranks the name: two servers legitimately share a
 * name variant more often than a full connection target.
 */
export function findCatalogDuplicate(
  values: McpCatalogFormValues,
  items: CatalogItem[] | undefined,
): CatalogDuplicateMatch | null {
  if (!items || items.length === 0) return null;

  const url = normalizeUrl(values.serverUrl);
  const commandLine = normalizeCommandLine(
    values.localConfig?.command,
    values.localConfig?.arguments?.split("\n"),
  );
  const image = normalizeToken(values.localConfig?.dockerImage);
  const name = normalizeToken(values.name);

  let nameMatch: CatalogDuplicateMatch | null = null;
  for (const item of items) {
    if (url && normalizeUrl(item.serverUrl) === url) {
      return { item, reason: "same server URL" };
    }
    if (
      commandLine &&
      normalizeCommandLine(
        item.localConfig?.command,
        item.localConfig?.arguments,
      ) === commandLine
    ) {
      return { item, reason: "same command" };
    }
    if (image && normalizeToken(item.localConfig?.dockerImage) === image) {
      return { item, reason: "same Docker image" };
    }
    if (!nameMatch && name && normalizeToken(item.name) === name) {
      nameMatch = { item, reason: "same name" };
    }
  }
  return nameMatch;
}

export interface ExternalCatalogMatch {
  manifest: archestraCatalogTypes.ArchestraMcpServerManifest;
  /** Human-readable ground for the match, e.g. "same command". */
  reason: string;
}

/**
 * Finds an online-catalog template whose connection identity equals what the
 * form carries. STRONG signals only (URL, command line, image) — this match
 * silently writes metadata into the form, so a fuzzy name coincidence must
 * never qualify. Weak name matches stay the registry-duplicate warning's
 * business, where a wrong match costs a dismissal, not wrong data.
 */
export function findExternalCatalogMatch(
  values: McpCatalogFormValues,
  manifests: archestraCatalogTypes.ArchestraMcpServerManifest[] | undefined,
): ExternalCatalogMatch | null {
  if (!manifests || manifests.length === 0) return null;

  const url = normalizeUrl(values.serverUrl);
  const commandLine = normalizeCommandLine(
    values.localConfig?.command,
    values.localConfig?.arguments?.split("\n"),
  );
  const image = normalizeToken(values.localConfig?.dockerImage);

  for (const manifest of manifests) {
    const server = manifest.server;
    if (server.type === "remote") {
      if (url && normalizeUrl(server.url) === url) {
        return { manifest, reason: "same server URL" };
      }
      continue;
    }
    // A template's identity includes its per-client permutations — a README
    // command a user types often equals one of those rather than the primary.
    const shapes = [
      {
        command: server.command,
        args: server.args,
        docker: server.docker_image,
      },
      ...Object.values(
        manifest.archestra_config?.client_config_permutations ?? {},
      ).map((permutation) => ({
        command: permutation.command,
        args: permutation.args,
        docker: permutation.docker_image,
      })),
    ];
    for (const shape of shapes) {
      if (
        commandLine &&
        shape.command &&
        normalizeCommandLine(shape.command, shape.args) === commandLine
      ) {
        return { manifest, reason: "same command" };
      }
      if (image && shape.docker && normalizeToken(shape.docker) === image) {
        return { manifest, reason: "same Docker image" };
      }
    }
  }
  return null;
}

/**
 * Derives a text query for the online-catalog search from the form's
 * connection identity — the search indexes name/description/repository, so
 * the package token is reduced to its core name ("@upstash/context7-mcp" →
 * "context7"). Returns null when the form carries nothing searchable; the
 * strict matcher above decides whether any result actually IS the server.
 */
export function deriveCatalogSearchTerm(
  values: McpCatalogFormValues,
): string | null {
  const packageToken = firstPackageToken(
    values.localConfig?.command,
    values.localConfig?.arguments?.split("\n"),
  );
  if (packageToken) return coreName(packageToken.split("/").pop() ?? "");

  const image = values.localConfig?.dockerImage?.trim();
  if (image) {
    const repository = image.split("/").pop()?.split(":")[0] ?? "";
    return coreName(repository);
  }

  const url = values.serverUrl?.trim();
  if (url) {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return null;
    }
    const labels = hostname
      .split(".")
      .filter((label) => !["www", "mcp", "api"].includes(label));
    // Drop the TLD; what remains is the service's own name.
    return coreName(labels.slice(0, -1).join("-"));
  }

  return null;
}

/** The package a runner command executes — `npx -y @scope/pkg` → `@scope/pkg`. */
function firstPackageToken(
  command: string | null | undefined,
  argumentList: (string | null | undefined)[] | null | undefined,
): string | null {
  const runner = command?.trim().toLowerCase();
  if (!runner || !["npx", "uvx", "bunx", "pipx"].includes(runner)) return null;
  for (const argument of argumentList ?? []) {
    const trimmed = argument?.trim();
    if (trimmed && !trimmed.startsWith("-")) return trimmed;
  }
  return null;
}

/** Strips mcp/server affixes: "mcp-server-github" → "github". */
function coreName(token: string): string | null {
  const core = token
    .toLowerCase()
    .split(/[-_.]/)
    .filter((part) => part && !["mcp", "server", "servers"].includes(part))
    .join("-");
  return core.length >= 3 ? core : null;
}

function normalizeUrl(url: string | null | undefined): string {
  const trimmed = url?.trim().toLowerCase() ?? "";
  return trimmed.replace(/\/+$/, "");
}

function normalizeToken(token: string | null | undefined): string {
  return (token ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeCommandLine(
  command: string | null | undefined,
  argumentList: (string | null | undefined)[] | null | undefined,
): string {
  const parts = [command ?? "", ...(argumentList ?? [])]
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0);
  return parts.join(" ").toLowerCase();
}
