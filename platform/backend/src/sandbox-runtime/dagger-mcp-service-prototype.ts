import type {
  DaggerMcpServiceEndpoint,
  DaggerMcpServiceEnvVar,
  EnvironmentTarget,
  StartDaggerMcpServiceInput,
  StopDaggerMcpServiceResult,
} from "@archestra/sandbox-rs";
import type { InternalMcpCatalog } from "@/types";

type Candidate = Pick<
  InternalMcpCatalog,
  "serverType" | "multitenant" | "deploymentSpecYaml" | "localConfig"
>;

type DaggerMcpIncompatibility =
  | "custom-kubernetes-yaml"
  | "env-from"
  | "image-pull-secrets"
  | "image-required"
  | "image-entrypoint-with-arguments"
  | "mounted-secret"
  | "multitenant"
  | "node-port"
  | "not-local"
  | "service-account"
  | "stdio-transport";

type DaggerMcpCompatibility =
  | { compatible: true }
  | { compatible: false; reasons: DaggerMcpIncompatibility[] };

/**
 * Static admission gate for the Dagger MCP service spike.
 *
 * The point is to make the prototype an additive runtime lane, never a lossy
 * translation of Kubernetes behavior. A catalog stays on the existing runtime
 * whenever its configuration uses a feature the native Dagger primitive does
 * not model yet.
 */
export function assessDaggerMcpCompatibility(
  candidate: Candidate,
): DaggerMcpCompatibility {
  const reasons: DaggerMcpIncompatibility[] = [];
  const local = candidate.localConfig;

  if (candidate.serverType !== "local") reasons.push("not-local");
  if (candidate.multitenant) reasons.push("multitenant");
  if (candidate.deploymentSpecYaml?.trim()) {
    reasons.push("custom-kubernetes-yaml");
  }
  if ((local?.transportType ?? "stdio") !== "streamable-http") {
    reasons.push("stdio-transport");
  }
  if (!local?.dockerImage?.trim()) reasons.push("image-required");
  if (local?.envFrom?.length) reasons.push("env-from");
  if (local?.imagePullSecrets?.length) reasons.push("image-pull-secrets");
  if (local?.serviceAccount) reasons.push("service-account");
  if (local?.nodePort) reasons.push("node-port");
  if (local?.environment?.some((entry) => entry.mounted)) {
    reasons.push("mounted-secret");
  }
  if (!local?.command && local?.arguments?.length) {
    reasons.push("image-entrypoint-with-arguments");
  }

  return reasons.length > 0
    ? { compatible: false, reasons }
    : { compatible: true };
}

interface BuildDaggerMcpServiceInput {
  candidate: Candidate;
  serviceKey: string;
  resolvedEnv: DaggerMcpServiceEnvVar[];
  environment?: EnvironmentTarget;
}

/** Convert an admitted catalog plus already-resolved install secrets to the
 * small native service spec. Secret resolution remains a TS/DB concern; the
 * Rust boundary only tells Dagger which values must become graph-safe Secrets.
 */
export function buildDaggerMcpServiceInput({
  candidate,
  serviceKey,
  resolvedEnv,
  environment,
}: BuildDaggerMcpServiceInput): StartDaggerMcpServiceInput {
  const compatibility = assessDaggerMcpCompatibility(candidate);
  if (!compatibility.compatible) {
    throw new Error(
      `Catalog is not compatible with the Dagger MCP prototype: ${compatibility.reasons.join(", ")}`,
    );
  }

  const local = candidate.localConfig;
  if (!local?.dockerImage) {
    throw new Error("Compatible Dagger MCP catalog has no image");
  }
  return {
    serviceKey,
    image: local.dockerImage,
    command: local.command
      ? [local.command, ...(local.arguments ?? [])]
      : undefined,
    env: resolvedEnv,
    port: local.httpPort ?? 8080,
    environment,
  };
}

interface DaggerMcpRunningEndpoint extends DaggerMcpServiceEndpoint {
  /** Full streamable-HTTP endpoint, including the catalog's MCP path. */
  mcpUrl: string;
}

/**
 * Thin, deliberately unregistered adapter around the native spike. The
 * production manager can later put this behind an `McpWorkloadRuntime` seam;
 * keeping it unregistered now guarantees the experiment changes no deployment.
 */
export class DaggerMcpServicePrototype {
  async start(
    input: StartDaggerMcpServiceInput,
    httpPath = "/mcp",
  ): Promise<DaggerMcpRunningEndpoint> {
    const native = await import("@archestra/sandbox-rs");
    const endpoint = await native.startDaggerMcpServicePrototype(input);
    return { ...endpoint, mcpUrl: joinUrlPath(endpoint.url, httpPath) };
  }

  async stop(params: {
    serviceKey: string;
    environment?: EnvironmentTarget;
    kill?: boolean;
  }): Promise<StopDaggerMcpServiceResult> {
    const native = await import("@archestra/sandbox-rs");
    return native.stopDaggerMcpServicePrototype(params);
  }
}

function joinUrlPath(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\/+/, ""), base).toString();
}
