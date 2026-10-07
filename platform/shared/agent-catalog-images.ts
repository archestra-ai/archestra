/** Maintained runtime image names shared by the catalog and background prefetch. */
import AGENT_CATALOG_IMAGE_NAMES from "./agent-catalog-images.json";

export type AgentCatalogId = keyof typeof AGENT_CATALOG_IMAGE_NAMES;

/** Public registry the maintained catalog images are published to. */
export const AGENT_CATALOG_IMAGE_REGISTRY =
  "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public";

/**
 * The catalog tag that matches a platform version. The approved stable
 * release moves :latest. Prerelease and commit builds keep their matching
 * image tag instead of pulling an older stable CLI.
 */
export function getAgentCatalogImageTag(version: string): string {
  return /^\d+\.\d+\.\d+$/.test(version) ? "latest" : version;
}

export function getAgentCatalogImages(params: {
  registry: string;
  tag: string;
}): Record<AgentCatalogId, string> {
  const registry = params.registry.replace(/\/+$/, "");
  return Object.fromEntries(
    Object.entries(AGENT_CATALOG_IMAGE_NAMES).map(([id, name]) => [
      id,
      `${registry}/${name}:${params.tag}`,
    ]),
  ) as Record<AgentCatalogId, string>;
}

/** Display name of each maintained CLI template. */
export const AGENT_CATALOG_NAMES: Record<AgentCatalogId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  hermes: "Hermes",
  openclaw: "OpenClaw",
};

/** Every maintained CLI template, in catalog order. */
export const AGENT_CATALOG_IDS = Object.keys(
  AGENT_CATALOG_IMAGE_NAMES,
) as AgentCatalogId[];

/**
 * The runtime a maintained CLI template starts from. The catalog UI and the
 * create_agent MCP tool both build from this, so an Agent made either way
 * launches the same image with the same wrapper, protocol, and steering.
 */
export function buildAgentCatalogRuntime(params: {
  id: AgentCatalogId;
  image: string;
}) {
  const { inferenceProtocol } = CATALOG_RUNTIME_PROFILES[params.id];
  return {
    image: params.image,
    command: [`archestra-${params.id}`],
    inferenceProtocol,
    backend: "kubernetes" as const,
    steerMode: "tmux_keys" as const,
    privileged: false,
    resources: null,
    environment: null,
    credentials: [],
    ...(params.id === "claude-code" && {
      claudeCode: { authentication: "subscription" as const },
    }),
    ttlHours: null,
    maxCostUsd: null,
    idleTimeoutMinutes: null,
  };
}

/** The runtime a custom-image Agent starts from before its fields are set. */
export function buildCustomAgentRuntime(params: { image: string }) {
  return {
    image: params.image,
    command: null,
    inferenceProtocol: "openai_responses" as const,
    backend: "kubernetes" as const,
    steerMode: "pipe" as const,
    privileged: false,
    resources: null,
    environment: null,
    credentials: null,
    ttlHours: null,
    maxCostUsd: null,
    idleTimeoutMinutes: null,
  };
}

/** The system prompt a catalog-created Agent starts with. */
export function buildAgentCatalogSystemPrompt(params: {
  name: string;
  platformName: string;
}): string {
  return `You are ${params.name}, an autonomous coding agent. Complete delegated tasks carefully, use the tools available through ${params.platformName}, verify your work, and report the concrete result.`;
}

/**
 * Which maintained CLI template a saved runtime runs, or null for a custom
 * one. A runtime stores no template id, so this reads the `archestra-<id>`
 * wrapper command each template launches with, the same fingerprint the
 * launch path keys on.
 */
export function resolveAgentCatalogId(runtime: unknown): AgentCatalogId | null {
  if (!runtime || typeof runtime !== "object") return null;
  const { command } = runtime as { command?: unknown };
  const executable = Array.isArray(command) ? command[0] : undefined;
  return typeof executable === "string"
    ? (CATALOG_ID_BY_COMMAND[executable] ?? null)
    : null;
}

const CATALOG_ID_BY_COMMAND: Record<string, AgentCatalogId> =
  Object.fromEntries(
    (Object.keys(AGENT_CATALOG_IMAGE_NAMES) as AgentCatalogId[]).map((id) => [
      `archestra-${id}`,
      id,
    ]),
  );

const CATALOG_RUNTIME_PROFILES: Record<
  AgentCatalogId,
  { inferenceProtocol: "openai_responses" | "openai_chat" | "anthropic" }
> = {
  "claude-code": { inferenceProtocol: "anthropic" },
  codex: { inferenceProtocol: "openai_responses" },
  opencode: { inferenceProtocol: "openai_responses" },
  hermes: { inferenceProtocol: "openai_chat" },
  openclaw: { inferenceProtocol: "openai_chat" },
};
