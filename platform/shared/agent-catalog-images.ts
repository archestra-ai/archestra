/** Maintained runtime image names shared by the catalog and background prefetch. */
import AGENT_CATALOG_IMAGE_NAMES from "./agent-catalog-images.json";
import {
  type ClaudeSubscriptionRuntime,
  DEFAULT_CLAUDE_CODE_MODEL,
  getAgentRuntimeModelCompatibility,
  isClaudeCodeRuntimeCommand,
} from "./model-constants";

export type AgentCatalogId = keyof typeof AGENT_CATALOG_IMAGE_NAMES;

/** Public registry the maintained catalog images are published to. */
export const AGENT_CATALOG_IMAGE_REGISTRY = "ghcr.io/archestra-ai";

/**
 * Digests of the images a platform release shipped with, keyed by image name
 * (`mcp-server-base`, `agent-codex`, ...). The release pipeline records them
 * when it publishes the images and ships them in the Helm chart, so an install
 * pulls exactly the bytes released, and attested, with its version.
 */
export type ReleaseImageDigests = {
  version: string;
  images: Record<string, string>;
};

/**
 * Pins a release image reference to the digest its release shipped with.
 * Only `ghcr.io/archestra-ai/<name>:<release version>` is pinned: a mirror,
 * another tag, or a reference that already has a digest is returned as is,
 * and so is everything when no digests were shipped (development builds).
 */
export function pinReleaseImage(params: {
  image: string;
  digests: ReleaseImageDigests | null;
}): string {
  const { image, digests } = params;
  if (!digests || image.includes("@")) return image;
  const prefix = `${AGENT_CATALOG_IMAGE_REGISTRY}/`;
  const suffix = `:${digests.version}`;
  if (!image.startsWith(prefix) || !image.endsWith(suffix)) return image;
  const digest = digests.images[image.slice(prefix.length, -suffix.length)];
  return digest ? `${image}@${digest}` : image;
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

/**
 * The image a saved runtime launches with on this deployment.
 *
 * An Agent made from a template saves the maintained image tag that was
 * current when it was created. The wrapper inside that image and the platform
 * change together, so after an upgrade an older tag can stop working with the
 * backend it talks to. A maintained image therefore follows the deployment's
 * current catalog: same template, this deployment's registry and tag. The
 * public registry counts as maintained too, so Agents created before an
 * operator mirrored the images move to the mirror.
 *
 * A release pins each maintained image as `<repository>:<version>@<digest>`
 * (pinReleaseImage). That tag-plus-digest form belongs to the catalog, so it
 * follows upgrades too. A digest without a tag is the author's deliberate pin,
 * and any other image is the author's own; both launch exactly as saved.
 */
export function followAgentCatalogImage(params: {
  image: string;
  catalogImages: Record<AgentCatalogId, string>;
}): string {
  const id = agentCatalogIdForImage(params);
  return id ? params.catalogImages[id] : params.image;
}

/**
 * The maintained template whose image a saved runtime launches, or null for
 * any other image. Matches the same references `followAgentCatalogImage`
 * moves to the current catalog image.
 */
export function agentCatalogIdForImage(params: {
  image: string;
  catalogImages: Record<AgentCatalogId, string>;
}): AgentCatalogId | null {
  const at = params.image.indexOf("@");
  if (at !== -1 && !hasTag(params.image.slice(0, at))) return null;
  const repository = imageRepository(params.image);
  for (const [id, name] of Object.entries(AGENT_CATALOG_IMAGE_NAMES) as [
    AgentCatalogId,
    string,
  ][]) {
    if (
      repository === imageRepository(params.catalogImages[id]) ||
      repository === `${AGENT_CATALOG_IMAGE_REGISTRY}/${name}` ||
      repository ===
        `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/${name}`
    ) {
      return id;
    }
  }
  return null;
}

/** Display name of each maintained CLI template. */
export const AGENT_CATALOG_NAMES: Record<AgentCatalogId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  hermes: "Hermes",
  openclaw: "OpenClaw",
  grok: "Grok Build",
  kimi: "Kimi Code",
  copilot: "GitHub Copilot CLI",
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
    environment: null,
    credentials: [],
    ...(params.id === "claude-code" && {
      claudeCode: {
        authentication: "subscription" as const,
        model: DEFAULT_CLAUDE_CODE_MODEL,
      },
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

/**
 * The maintained catalog runtime a command launches, or null for any other
 * command: `archestra-<id>` or its standalone `archestra-<id>-runtime` wrapper.
 */
export function agentCatalogIdForCommand(
  command?: string | null,
): AgentCatalogId | null {
  if (!command?.startsWith("archestra-")) return null;
  const id = command.slice("archestra-".length).replace(/-runtime$/, "");
  return Object.hasOwn(AGENT_CATALOG_IMAGE_NAMES, id)
    ? (id as AgentCatalogId)
    : null;
}

/**
 * Whether a runtime can run on a person's own Claude subscription: the
 * maintained Claude Code runtime, or a custom image that declares Claude Code
 * settings. A custom image without them is never offered the subscription.
 */
export function runtimeSupportsClaudeSubscription(
  runtime: ClaudeSubscriptionRuntime,
): boolean {
  const command = runtime.command?.[0];
  if (isClaudeCodeRuntimeCommand(command)) return true;
  return !agentCatalogIdForCommand(command) && !!runtime.claudeCode;
}

/**
 * Whether a runtime's settings ask for the person's Claude subscription. The
 * maintained Claude Code runtime does unless set to provider authentication;
 * a custom image only when it declares subscription authentication. Callers
 * still apply the Bedrock and Vertex exception for the maintained runtime.
 */
export function runtimeRequestsClaudeSubscription(
  runtime: ClaudeSubscriptionRuntime,
): boolean {
  if (isClaudeCodeRuntimeCommand(runtime.command?.[0])) {
    return runtime.claudeCode?.authentication !== "provider";
  }
  return (
    runtimeSupportsClaudeSubscription(runtime) &&
    runtime.claudeCode?.authentication === "subscription"
  );
}

/**
 * Whether an Agent Runtime agent that follows the organization's default model
 * can run `provider`/`modelId` as that default. A Claude Code runtime not set
 * to provider authentication runs a default it can't use from a provider on
 * the person's own Claude subscription instead, except a Bedrock model, which
 * it runs with provider billing (so that one must be a Claude model).
 */
export function getAgentRuntimeDefaultModelCompatibility(
  params: Parameters<typeof getAgentRuntimeModelCompatibility>[0] & {
    claudeCodeAuthentication?: "provider" | "subscription" | null;
  },
): { compatible: true } | { compatible: false; message: string } {
  const { claudeCodeAuthentication, ...model } = params;
  const command = params.runtimeCommand?.[0];
  if (
    isClaudeCodeRuntimeCommand(command) &&
    (claudeCodeAuthentication === "subscription" ||
      (claudeCodeAuthentication !== "provider" &&
        params.provider !== "bedrock"))
  ) {
    return { compatible: true };
  }
  if (
    !agentCatalogIdForCommand(command) &&
    claudeCodeAuthentication === "subscription"
  ) {
    return { compatible: true };
  }
  return getAgentRuntimeModelCompatibility(model);
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
  grok: { inferenceProtocol: "openai_chat" },
  kimi: { inferenceProtocol: "openai_chat" },
  copilot: { inferenceProtocol: "openai_chat" },
};

/** An image reference without its tag and digest. A registry port is not a tag. */
function imageRepository(image: string): string {
  const name = image.split("@")[0];
  return hasTag(name) ? name.slice(0, name.lastIndexOf(":")) : name;
}

/** Whether a reference (without digest) names a tag. A registry port is not one. */
function hasTag(reference: string): boolean {
  return reference.lastIndexOf(":") > reference.lastIndexOf("/");
}
